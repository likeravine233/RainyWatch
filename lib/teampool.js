// —— 全量队伍池:LP / PandaScore / VRS 榜单都是池子的供数方,条目生成统一从池子取规范字段 ——
// 池子按「归一队名 + 品牌别名归并」做键(navi 与 natusvincere 是同一支):LP 行的展示名
// (LP 本来就用短名,如 NAVI/FURIA/paiN)是规范名的最高优先来源,Panda 的全名只在缺口处补位;
// href/logo 同理 LP 优先;VRS 排名以最近一次榜单为准。 decorateMatches 把池子字段回填到
// 比赛条目上——Panda 补位行由此获得规范名、LP 队页链接、队标与 VRS 徽章,不再信息缺失。
//
// 学习式别名(对标赛事池):缩写↔全名归一抓不完(LG↔Luminosity,字母还对不上——G 来自被
// norm 剥掉的 Gaming)。锚点是 LP 行自带的队页链接:页链 slug 就是队伍身份(Luminosity_Gaming),
// 展示名键与之不同时学 disp→id,双键合一;同一队无论哪个选项卡、哪个供数方,永远只有一个名字。
// 由 main.js 持久化(store('teamAlias')),启动回灌,保证重启后第一轮装饰就已归并。
const { norm, NAME_ALIASES } = require('./live');

// 别名 → 归并键(natusvincere 作 navi 的规范键);与 isSameMatch 的 NAME_ALIASES 同源同步增补。
// 学院队后缀归一:同一支学院队在三源叫法不同(LP「NAVI Jr.」/ Panda「NAVI Junior」/ VRS「Natus Vincere
// Junior」),junior→jr 后缀归并 + 品牌组合别名把它们并到 LP 短名键;与母队(natusvincere)保持分离
const ALIAS_CANON = Object.fromEntries(NAME_ALIASES.flatMap(([p, q]) => [[p, q], [q, q]]));
ALIAS_CANON.natusvincerejr = 'navijr';
// 品牌短名种子:该队从未被 LP 行收录时也按品牌名显示(键 = 归并键)
const DISPLAY_SEED = { natusvincere: 'NAVI' };
// 显示字段来源优先级:LP 行展示名 > Panda 原始名 > VRS 榜单名
const PRIO = { lp: 3, panda: 2, vrs: 1 };
const pr = (s) => PRIO[s] || 0;

// 学习式别名表(展示名键 → 页链身份键):运行期由 LP 行学习,启动时 main.js 回灌
const LEARNED = {};
function loadAliasCanon(obj) { for (const k of Object.keys(LEARNED)) delete LEARNED[k]; Object.assign(LEARNED, obj || {}); }
const aliasCanon = () => ({ ...LEARNED });
require('./live').setLearnedAliases(LEARNED); // 同一份别名对象交给 live 判重(isSameMatch):补位判重与池子显示永远同源,load/learn 都是原地改,引用常新

// 基础归并(不含学习别名):norm + 学院队后缀 + 内置品牌别名
const canonRaw = (s) => { const n = norm(s).replace(/junior$/, 'jr'); return ALIAS_CANON[n] || n; };
// 池键:在基础归并之上叠加学习别名(缩写键路由到页链身份键)
const canonKey = (s) => { const n = canonRaw(s); return LEARNED[n] || n; };

// 从 LP 行学一条「展示名键 → 页链身份键」;池里旧键的存量字段迁移到身份键后删除旧键
function learnAlias(pool, t) {
  if (!t || !t.name || !t.href) return false;
  const m = String(t.href).match(/\/counterstrike\/([^?#]+)/);
  if (!m) return false;
  if (/^index\.php$/i.test(m[1])) return false; // LP 红链(页面不存在的编辑链接)不是身份:任何队的红链都截成 index.php,会撞成一个键互覆
  let id;
  try { // 下划线先还原成空格再归一:Luminosity_Gaming 的 _gaming 是 word 字符,word-strip 剥不掉,
    // 会错成 luminositygaming 与全名键 luminosity 劈叉;子页保留(Natus_Vincere/Junior→navijr)
    id = canonRaw(decodeURIComponent(m[1]).replace(/[_-]+/g, ' '));
  } catch { return false; }
  const disp = canonRaw(t.name);
  if (!id || !disp || id === disp || LEARNED[disp] === id) return false;
  LEARNED[disp] = id;
  const old = pool[disp];
  if (old) {
    delete pool[disp];
    const dst = (pool[id] = pool[id] || {});
    for (const f of ['name', 'href', 'logo']) {
      if (!dst[f] && old[f]) { dst[f] = old[f]; dst[f + 'Src'] = old[f + 'Src']; }
    }
    if (dst.vrs == null && old.vrs != null) dst.vrs = old.vrs;
    dst.at = Math.max(dst.at || 0, old.at || 0);
  }
  return true;
}

// 单队并入:show 字段(name/href/logo)高优先来源可覆盖、低优先只补缺;vrs 恒取最新。
// name 同优先级不互相覆盖(keep-first):同一队两个区块万一写法不同,显示名必须稳定唯一,
// 不许随解析轮次翻面;href/logo 仍取最新(LP 页链形式变化无展示歧义)。
// 无实质变化不落笔(at 不动)——payload 每次推送都会跑供数,必须真正幂等,否则写盘闸门永闭不上
function mergeTeam(pool, name, patch, src) {
  const key = canonKey(name);
  if (!key) return;
  const cur = pool[key] || {};
  const next = { ...cur };
  let changed = false;
  for (const f of ['name', 'href', 'logo']) {
    const v = patch[f];
    if (!v || next[f] === v) continue;
    const take = f === 'name' ? pr(src) > pr(cur[f + 'Src']) : pr(src) >= pr(cur[f + 'Src']);
    if (take || !next[f]) { next[f] = v; next[f + 'Src'] = src; changed = true; }
  }
  if (Number.isFinite(patch.vrs) && next.vrs !== patch.vrs) { next.vrs = patch.vrs; changed = true; }
  if (!changed) return;
  next.at = Date.now();
  pool[key] = next;
}

// 比赛三区里的每个队都是供数方;LP 派生行(panda 标记之外)按 lp 级供数,并顺带学页链别名
function enrichFromMatches(pool, matches) {
  for (const k of ['live', 'upcoming', 'recent']) {
    for (const m of (matches && matches[k]) || []) {
      const src = m.panda ? 'panda' : 'lp';
      for (const t of [m.teamA, m.teamB]) {
        if (!t || !t.name) continue;
        if (!m.panda) learnAlias(pool, t); // 页链身份只在 LP 行上学(Panda 行无页链)
        mergeTeam(pool, t.name, { name: t.name, href: t.href, logo: t.logo }, src);
      }
    }
  }
}

// VRS 榜单:排名 + 榜单名(该队缺任何行来源时的显示兜底)
function enrichFromRankings(pool, rankings) {
  for (const rec of Object.values((rankings && rankings.bySlug) || {})) {
    if (!rec || !rec.name) continue;
    mergeTeam(pool, rec.name, { name: rec.name, vrs: rec.rank }, 'vrs');
  }
}

// 池子回填到条目:规范名(LP 名或品牌种子)覆盖非 LP 来源的原始名;href/logo/vrs 只补缺
function decorateSide(t, pool) {
  if (!t || !t.name) return t;
  const key = canonKey(t.name);
  const e = pool[key];
  if (!e) return t;
  const name = (e.nameSrc === 'lp' && e.name) || DISPLAY_SEED[key] || e.name || t.name;
  return { ...t, name, href: t.href || e.href || '', logo: t.logo || e.logo || '', vrs: e.vrs || null };
}

function decorateMatches(matches, pool) {
  for (const k of ['live', 'upcoming', 'recent']) {
    for (const m of (matches && matches[k]) || []) {
      if (!m) continue;
      m.teamA = decorateSide(m.teamA, pool);
      m.teamB = decorateSide(m.teamB, pool);
    }
  }
  return matches;
}

// 容量封顶:按最近见到时间 LRU 淘汰,池子不随岁月无限膨胀
function capPool(pool, max) {
  const keys = Object.keys(pool);
  if (keys.length <= max) return;
  keys.sort((a, b) => (pool[a].at || 0) - (pool[b].at || 0));
  for (const k of keys.slice(0, keys.length - max)) delete pool[k];
}

module.exports = { canonKey, canonRaw, learnAlias, loadAliasCanon, aliasCanon, mergeTeam, enrichFromMatches, enrichFromRankings, decorateMatches, decorateSide, capPool, DISPLAY_SEED };
