// PandaScore 增强:回合/图号实时数据 + Liquipedia 被限流时的比赛列表兜底(可选,需免费 token)
// 实测模型:csgo/matches/running → matches[].games[]: {position, status} 有;
// round_score 免费档不返回(付费字段),缺失时降级为只给图号
const { isFinalText } = require('../src/phase'); // 决赛语境判定(Grand Final/总决赛/决赛),供冠军点升级
const norm = (s) => String(s || '').toLowerCase()
  .replace(/\b(team|clan|esports|e-?sports|gaming|club|the)\b/g, '')
  .replace(/[^a-z0-9]/g, ''); // 与 main.js/renderer.js 的 normTeam 同源:Liquipedia "Team Vitality" 要能对上 PandaScore "Vitality"

/**
 * @param {string} token PandaScore API token
 * @returns {Array<{key:string, t1:string, t2:string, mapNum:number, ra:number|null, rb:number|null, maps:number[][], series:[number,number]|null, mapName:string, mapNames:string[]}>}
 */
async function fetchPandaRunning(token) {
  if (!token) return [];
  const res = await fetch('https://api.pandascore.co/csgo/matches/running?per_page=50', {
    headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 || res.status === 403) throw new Error('TOKEN_INVALID');
  if (res.status === 429) throw new Error('RATE_LIMIT');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const arr = await res.json();
  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const m of arr) {
    try {
      const opps = (m.opponents || []).map(o => o.opponent || o).filter(Boolean);
      if (opps.length < 2) continue;
      const t1 = opps[0].name || opps[0].acronym || '';
      const t2 = opps[1].name || opps[1].acronym || '';
      if (!t1 || !t2) continue;
      const games = (m.games || []).filter(g => g && (g.status === 'finished' || g.status === 'running'));
      const running = games.find(g => g.status === 'running') || games[games.length - 1];
      if (!running) continue;
      const rs = running.round_score || {};
      const ra = Number(rs.team1 ?? rs.t1 ?? NaN);
      const rb = Number(rs.team2 ?? rs.t2 ?? NaN);
      const hasRounds = Number.isFinite(ra) && Number.isFinite(rb);
      if (!hasRounds && !running.position) continue; // 既无回合分也无图号,没有可增强的内容
      const mapNum = Number(running.position || (games.filter(g => g.status === 'finished').length + 1) || 1);
      // 地图名接口:PandaScore 免费档不下发 game.map;付费档给 {id, name}。将来接 LPDB match2games
      // 时填同一字段。mapName=当前图名(渲染层"第N图"自动升级为图名),mapNames=各图名(与 games 平行)
      const nameOf = (g) => String((g && g.map && (g.map.name || g.map.display_name)) || (g && g.map_name) || '').trim();
      const mapName = nameOf(running);
      const maps = hasRounds
        ? games.map(g => {
            const s = g.round_score || {};
            return [Number(s.team1 ?? s.t1 ?? 0), Number(s.team2 ?? s.t2 ?? 0)];
          })
        : []; // 免费档无回合分:只带图号,ra/rb 置空由渲染层降级显示
      // 大比分(图胜场):running 接口的 results 免费档就有且实时;回合小分 round_score 才是付费字段
      const byId = new Map((m.results || []).map(r => [r.team_id, r.score]));
      const wA = Number(byId.get(opps[0].id)), wB = Number(byId.get(opps[1].id));
      const series = Number.isFinite(wA) && Number.isFinite(wB) ? [wA, wB] : null;
      out.push({
        key: matchKey(t1, t2),
        t1, t2, mapNum, ra: hasRounds ? ra : null, rb: hasRounds ? rb : null, maps, series,
        mapName, mapNames: games.map(nameOf),
        // 阶段名兜底:仅取决胜阶段的 tournament 名(Grand Final/Playoffs);小组赛等由 LP 卡片后缀提供
        pStage: /final|playoff/i.test((m.tournament && m.tournament.name) || '') ? (m.tournament && m.tournament.name) || '' : '',
        // 决赛语境:决胜阶段的 tournament 名(PandaScore 决赛常单独叫 "Grand Final")或系列赛名命中
        isFinal: isFinalText(m.tournament && m.tournament.name, m.serie && (m.serie.full_name || m.serie.name), m.league && m.league.name, m.name),
      });
    } catch { /* 单场解析失败不影响其余 */ }
  }
  return out;
}

function matchKey(a, b) {
  return [norm(a), norm(b)].sort().join('|');
}

// Liquipedia 被限流时的比赛列表兜底:PandaScore 拉基础字段(队名/队标/时间/比分/BO/赛事名)
// 返回与 parseMatches 同构的 {live, upcoming, recent};字段比 Liquipedia 少(VRS/阶段/赛事图标/直播链接等)
async function fetchPandaMatchList(token) {
  if (!token) return null;
  const H = { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' };
  const get = async (kind, sort, extra = '') => {
    const res = await fetch(`https://api.pandascore.co/csgo/matches/${kind}?per_page=30&sort=${sort}${extra}`, {
      headers: H, signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429) throw new Error('PandaScore 限流,下个整点恢复');
    if (res.status === 401 || res.status === 403) throw new Error('TOKEN_INVALID');
    if (!res.ok) throw new Error('PandaScore HTTP ' + res.status);
    return res.json();
  };
  // past 必须带 status=finished + begin_at 时间窗:否则按 -begin_at 排序时 begin_at=null 的
  // canceled/forfeited 场次霸占整页,真实赛果被挤出 per_page=30
  const pastRange = `&filter%5Bstatus%5D=finished&range%5Bbegin_at%5D=${
    encodeURIComponent(new Date(Date.now() - 48 * 3600e3).toISOString())
  },${encodeURIComponent(new Date(Date.now() + 3600e3).toISOString())}`;
  const [run, up, past] = await Promise.all([
    get('running', 'begin_at'), get('upcoming', 'begin_at'), get('past', '-begin_at', pastRange),
  ]);
  const norm1 = (m) => {
    try {
      if (!m || !Array.isArray(m.opponents) || m.opponents.length < 2) return null;
      const opps = m.opponents.map(o => o.opponent || o).filter(Boolean);
      if (opps.length < 2 || !opps[0].name || !opps[1].name) return null;
      const status = m.status === 'running' ? 'live' : m.status === 'finished' ? 'finished' : m.status === 'not_started' ? 'upcoming' : '';
      if (!status) return null; // canceled/postponed 等不进列表
      const ts = Date.parse(m.begin_at || m.scheduled_at || '') || 0;
      if (status !== 'live' && !ts) return null;
      const endedAt = Date.parse(m.end_at || '') || 0;
      const score = (status !== 'upcoming' && Array.isArray(m.results) && m.results.length >= 2)
        ? (() => {
            const byId = new Map(m.results.map(r => [r.team_id, r.score]));
            const a = byId.get(opps[0].id), b = byId.get(opps[1].id);
            return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
          })()
        : null;
      const logoOf = (o) => { const u = (o && o.image_url) || ''; return /hltv\.org/i.test(u) ? '' : u; }; // PandaScore 个别队标 URL 指向 HLTV CDN:不加载,回落字母牌
      return {
        id: `panda-${m.id}`, ts, endedAt, status, timerText: '', score,
        format: m.number_of_games ? `BO${m.number_of_games}` : '',
        teamA: { name: opps[0].name || '', href: '', logo: logoOf(opps[0]), isWinner: m.winner_id === opps[0].id, isLoser: !!m.winner_id && m.winner_id !== opps[0].id },
        teamB: { name: opps[1].name || '', href: '', logo: logoOf(opps[1]), isWinner: m.winner_id === opps[1].id, isLoser: !!m.winner_id && m.winner_id !== opps[1].id },
        event: (m.league && m.league.name) || (m.serie && m.serie.name) || (m.tournament && m.tournament.name) || '',
        stage: '', eventHref: '', eventIcon: '', streams: [], hltv: '',
      };
    } catch { return null; } // 单场解析失败不影响其余
  };
  const all = [...(Array.isArray(run) ? run : []), ...(Array.isArray(up) ? up : []), ...(Array.isArray(past) ? past : [])]
    .map(norm1).filter(Boolean);
  const now = Date.now();
  return {
    live: all.filter(m => m.status === 'live'),
    upcoming: all.filter(m => m.status === 'upcoming').sort((a, b) => a.ts - b.ts).slice(0, 20),
    recent: all.filter(m => m.status === 'finished' && now - (m.endedAt || m.ts) < 48 * 3600e3)
      .sort((a, b) => (b.endedAt || b.ts) - (a.endedAt || a.ts)).slice(0, 30),
  };
}

// 用两个队名在 PandaScore 结果里找对应场次
// 关键:返回 swap 标记——PandaScore 的 team1/team2 顺序与调用方的 teamA/teamB 不保证一致,
// 调用方需在 swap 时交换 ra/rb 与 maps,否则比分会挂反队
function findForTeams(runningList, teamA, teamB) {
  const ka = norm(teamA), kb = norm(teamB);
  const want = [ka, kb].sort().join('|');
  const r = runningList.find(x => x.key === want);
  if (!r) return null;
  return { ...r, swap: norm(r.t1) !== ka };
}

// LP 限流兜底时的元数据合并:PandaScore 新表只补实时字段,LP 已查实的慢变元数据
// (阶段/赛事链接/图标/直播流/HLTV/队名链接/队标)按队名对带过来——二路互补而非整表替换
function mergeFallback(pandaList, oldMatches) {
  if (!pandaList || !oldMatches) return pandaList;
  const prev = new Map();
  for (const k of ['live', 'upcoming', 'recent']) {
    for (const m of (oldMatches[k] || [])) prev.set(matchKey(m.teamA && m.teamA.name, m.teamB && m.teamB.name), m);
  }
  for (const k of ['live', 'upcoming', 'recent']) {
    for (const m of (pandaList[k] || [])) {
      const old = prev.get(matchKey(m.teamA && m.teamA.name, m.teamB && m.teamB.name));
      if (!old) continue;
      m.event = old.event || m.event;
      m.stage = old.stage || m.stage || '';
      m.eventHref = old.eventHref || '';
      m.eventIcon = old.eventIcon || '';
      m.streams = (old.streams && old.streams.length) ? old.streams : (m.streams || []);
      m.hltv = old.hltv || m.hltv || '';
      if (m.teamA && old.teamA) { m.teamA.href = m.teamA.href || old.teamA.href || ''; m.teamA.logo = m.teamA.logo || old.teamA.logo || ''; }
      if (m.teamB && old.teamB) { m.teamB.href = m.teamB.href || old.teamB.href || ''; m.teamB.logo = m.teamB.logo || old.teamB.logo || ''; }
    }
  }
  return pandaList;
}
module.exports = { fetchPandaRunning, matchKey, findForTeams, fetchPandaMatchList, mergeFallback };
