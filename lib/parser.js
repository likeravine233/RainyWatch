// Liquipedia 数据解析层:输入 api.php action=parse 返回的 HTML 片段,输出结构化 JSON
// 解析目标(2026-09 实测结构,经离线样本验证):
//   - Liquipedia:Matches 页 .match-info 卡片(timer-object 时间戳 / block-team 队伍 / scoreholder 比分)
//   - Main_Page .tournaments-list-type-list 分组(Upcoming/Ongoing/Completed)下的赛事行
//   - Portal:Transfers .divRow 转会行(to-team / from-team / neutral)
const cheerio = require('cheerio');

const BASE = 'https://liquipedia.net';
const abs = (href) => (href && href.startsWith('/') ? BASE + href : href || '');

function pickLogo($, scope) {
  // 优先 darkmode 图(悬浮窗深色主题下更协调),否则 lightmode / 任意一张
  let img = scope.find('img[src*="darkmode"]').first();
  if (!img.length) img = scope.find('img[src*="lightmode"]').first();
  if (!img.length) img = scope.find('img').first();
  if (!img.length) return '';
  return abs(img.attr('src'));
}

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// ---------- 比赛 ----------
function parseMatchCard($, card, now) {
  const timer = card.find('.timer-object').first();
  if (!timer.length) return null;
  const ts = parseInt(timer.attr('data-timestamp'), 10) * 1000;
  if (!Number.isFinite(ts)) return null;
  const finished = timer.attr('data-finished') === 'finished';
  const timerText = cleanText(timer.text());

  const opps = card.find('.match-info-header-opponent');
  if (opps.length < 2) return null;

  const team = ($o) => {
    const nameA = cleanText($o.find('.name a').first().text());
    const title = $o.find('.name a').first().attr('title') || $o.find('a[title]').first().attr('title') || nameA;
    return {
      name: nameA || title,
      logo: pickLogo($, $o),
      href: abs($o.find('.name a').first().attr('href') || $o.find('a[title]').first().attr('href') || ''),
      isWinner: $o.hasClass('match-info-header-winner'),
      isLoser: $o.hasClass('match-info-header-loser'),
    };
  };

  const t1 = team(opps.eq(0));
  const t2 = team(opps.eq(1));

  // 比分:scoreholder-upper 里是两个 score span(vs 则为未开赛)
  const scoreEls = card.find('.match-info-header-scoreholder-score');
  let score = null;
  let forfeit = false; // 弃赛:LP 记 FF : W(W=walkover 胜方),数字解析必失败但两格非空
  if (scoreEls.length >= 2) {
    const a = parseInt(scoreEls.eq(0).text(), 10);
    const b = parseInt(scoreEls.eq(1).text(), 10);
    if (Number.isFinite(a) && Number.isFinite(b)) score = [a, b];
    else {
      const at = cleanText(scoreEls.eq(0).text()).toUpperCase();
      const bt = cleanText(scoreEls.eq(1).text()).toUpperCase();
      if ((at === 'FF' || at === 'W') && (bt === 'FF' || bt === 'W')) {
        forfeit = true;
        // LP 偶尔不给 winner 类:直接按 W 侧定胜者,行渲染的胜方高亮/奖牌才有依据(FF:FF 双弃则无人获胜)
        if (at === 'W' && bt !== 'W' && !t1.isWinner) { t1.isWinner = true; t2.isLoser = true; }
        else if (bt === 'W' && at !== 'W' && !t2.isWinner) { t2.isWinner = true; t1.isLoser = true; }
      }
    }
  }
  const fmt = (cleanText(card.find('.match-info-header-scoreholder-lower').first().text()).match(/[Bb][Oo]\s?\d/) || [''])[0].toUpperCase().replace('BO', 'BO');
  const format = fmt || '';

  const evA = card.find('.match-info-tournament a').first();
  const evText = cleanText(evA.text()) || cleanText(card.find('.match-info-tournament').first().text());
  // "FISSURE Playground #3 - Group A" → 赛事名 + 阶段
  let event = evText, stage = '';
  const dashIdx = evText.indexOf(' - ');
  if (dashIdx > 0) { event = evText.slice(0, dashIdx); stage = evText.slice(dashIdx + 3); }
  const eventHref = abs(evA.attr('href') || '');
  const eventIcon = pickLogo($, card.find('.match-info-tournament').first());

  // 直播/回放链接(有时在 match-info-links 里)
  const streams = [];
  card.find('a[href*="twitch.tv"], a[href*="youtube.com/watch"], a[href*="bilibili"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && !streams.includes(href)) streams.push(href);
  });
  // HLTV 深链(比赛卡外链里常带 hltv.org 比赛页)
  const hltv = card.find('a[href*="hltv.org"]').first().attr('href') || '';

  let status;
  // LP 页面常有"结果已填但忘标 finished"的半更新:任一方带 winner 标记一律按赛果收
  if (finished || t1.isWinner || t2.isWinner) status = 'finished';
  else if (ts <= now) status = 'live';
  else status = 'upcoming';
  // 三级赛事打完常无人更新页面:开赛超 6 小时仍"直播中"的按赛果收尾(Bo5 加延误极少超 6h),
  // 否则 NAVI Jr 这类 academy 队比赛会在"直播中"挂一整天
  // 占位场(任一方队名缺位/TBD/TBA)除外:LP 签表会给空档预排开赛时刻,时刻过了页面照样挂着,
  // 没有对手就没有"打完"可言,不参与超时转赛果,等真实队名填进签表后自动恢复普通判定
  const pendingSlot = !t1.name || !t2.name || /^(tbd|tba)$/i.test(t1.name) || /^(tbd|tba)$/i.test(t2.name);
  if (status === 'live' && !pendingSlot && now - ts > 6 * 3600e3) status = 'finished';

  return {
    id: `${t1.name}|${t2.name}|${ts}`,
    ts, timerText, status, score, forfeit: forfeit || undefined, format, // undefined 不入 JSON:正常比赛不带该键
    pending: pendingSlot || undefined, // 同上:占位场标记,渲染层据此显示"等待对阵"而非进行时长
    teamA: t1, teamB: t2,
    event, stage, eventHref, eventIcon,
    streams, hltv,
  };
}

function parseMatches(html) {
  const now = Date.now();
  const $ = cheerio.load(html);
  const all = [];
  $('.match-info').each((_, el) => {
    const m = parseMatchCard($, $(el), now);
    if (m) all.push(m);
  });
  const byTime = (a, b) => a.ts - b.ts;
  const live = all.filter(m => m.status === 'live');
  const upcoming = all.filter(m => m.status === 'upcoming').sort(byTime);
  const recent = all.filter(m => m.status === 'finished' && now - m.ts < 48 * 3600e3)
    .sort((a, b) => b.ts - a.ts).slice(0, 6);
  return { live, upcoming, recent };
}

// ---------- 赛事(Main_Page tournaments-list) ----------
// 结构:div.tournaments-list 下 "h/div.tournaments-list-heading" 与其后的 "ul.tournaments-list-type-list"(行=li)成对出现
function parseEvents(html) {
  const $ = cheerio.load(html);
  const out = { ongoing: [], upcoming: [] };
  $('.tournaments-list-heading').each((_, headEl) => {
    const heading = cleanText($(headEl).text()).toLowerCase();
    const target = heading.includes('ongoing') ? 'ongoing' : heading.includes('upcoming') ? 'upcoming' : null;
    if (!target) return;
    const list = $(headEl).next('.tournaments-list-type-list');
    list.children('li').each((__, row) => {
      const r = $(row);
      const a = r.find('.tournament-name a').first();
      const name = cleanText(a.text()) || cleanText(r.find('.tournaments-list-name a[title]').first().attr('title') || '');
      if (!name) return;
      const badgeText = cleanText(r.find('.tournament-badge__text').first().text());
      const tier = badgeText.startsWith('S') ? 'S' : badgeText.startsWith('A') ? 'A' : badgeText.startsWith('B') ? 'B' : 'C';
      // 从行文本中提取 "Aug 31 – Dec 12" / "Sep 06–23" 形式的日期段
      const rowText = cleanText(r.text());
      const dm = rowText.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{1,2}(?:\s*[–-]\s*(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*)?\d{1,2})?)/);
      out[target].push({
        name,
        href: abs(a.attr('href') || ''),
        icon: pickLogo($, r),
        tier,
        dates: dm ? dm[1].replace(/\s*–\s*/, ' – ') : '',
      });
    });
  });
  const rank = { S: 0, A: 1, B: 2, C: 3 };
  out.ongoing.sort((x, y) => rank[x.tier] - rank[y.tier]);
  out.upcoming.sort((x, y) => rank[x.tier] - rank[y.tier]);
  out.ongoing = out.ongoing.slice(0, 10);
  out.upcoming = out.upcoming.slice(0, 10);
  return out;
}

// ---------- 变阵(Portal:Transfers) ----------
function parseTransfers(html, max = 22) {
  const $ = cheerio.load(html);
  const rows = [];
  $('.divRow').each((_, el) => {
    const r = $(el);
    const dateCell = r.find('.divCell.Date').first();
    if (!dateCell.length) return;
    const date = cleanText(dateCell.text());
    // 同一 Name 格可并排多名选手(同队同批变动 Liquipedia 常并作一行):逐人各出一条,别只取 first()
    const nameAs = r.find('.divCell.Name .block-player .name a').toArray();

    const teamText = ($scope) => {
      const a = $scope.find('a[title]').first();
      const note = cleanText($scope.find('span[style*="font-style:italic"]').last().text());
      const t = a.attr('title') ? cleanText(a.text()) || a.attr('title') : cleanText($scope.text());
      return { team: t.replace(/\(.*\)/, '').trim(), href: abs(a.attr('href') || ''), note: note.replace(/[()]/g, '').trim() };
    };
    const oldT = teamText(r.find('.divCell.Team.OldTeam').first());
    const newT = teamText(r.find('.divCell.Team.NewTeam').first());
    const norm = (s) => (s && !/^none$/i.test(s) ? s : '');
    const oldTeam = norm(oldT.team);
    const newTeam = norm(newT.team);
    const oldTeamHref = oldTeam ? oldT.href : '';
    const newTeamHref = newTeam ? newT.href : '';
    const note = norm(norm(newT.note) || norm(oldT.note));
    const oldLogo = pickLogo($, r.find('.divCell.Team.OldTeam').first());
    const newLogo = pickLogo($, r.find('.divCell.Team.NewTeam').first());

    const cls = r.attr('class') || '';
    const direction = cls.includes('to-team') ? 'in' : cls.includes('from-team') ? 'out' : 'neutral';
    const ref = r.find('.divCell.Ref a[href]').first().attr('href') || '';

    for (const nameA of (nameAs.length ? nameAs : [null])) { // 无链接行:退回整格文本
      const block = nameA ? $(nameA).closest('.block-player') : r.find('.divCell.Name .block-player').first();
      const player = nameA ? cleanText($(nameA).text()) : cleanText(r.find('.divCell.Name .block-player').first().text());
      const playerHref = nameA ? abs($(nameA).attr('href') || '') : '';
      const flag = (block.find('.flag img').first().attr('title') || r.find('.divCell.Name .flag img').first().attr('title') || '');
      if (player) rows.push({ id: `${date}|${player}|${direction}|${newTeam || oldTeam}`, date, player, playerHref, flag, direction, oldTeam, newTeam, oldTeamHref, newTeamHref, oldLogo, newLogo, note, ref });
    }
  });
  return rows.slice(0, max);
}

// ---------- 选手当前队伍与活跃状态(选手页 infobox 的 "Team:"/"Status:" 行) ----------
// Status 行(Liquipedia 惯例:Active/Inactive/Retired)是"被下放但不离队"的唯一可见信号——
// 这类选手 Team 行仍写着原队,只有 Status 落到 Inactive;行缺失时 status 返回 ''(未知,按活跃对待)
function parsePlayerTeam(html) {
  const $ = cheerio.load(html);
  const box = $('.fo-nttax-infobox').first();
  if (!box.length) return null;
  const rowVal = (re) => {
    const label = box.find('.infobox-cell-2.infobox-description')
      .filter((_, el) => re.test($(el).text().trim())).first();
    return label.length ? label.next() : null;
  };
  let name = '', href = '';
  const teamVal = rowVal(/^Team:?$/i);
  if (teamVal) {
    const a = teamVal.find('a[href^="/counterstrike/"]').first();
    name = cleanText(a.text());
    href = a.length ? abs(a.attr('href')) : '';
  }
  // 归一顺序不可换:"Inactive" 含 "active" 子串,必须先判不活跃再判活跃
  const raw = rowVal(/^Status:?$/i);
  const st = raw ? cleanText(raw.text()) : '';
  const status = /inactiv/i.test(st) ? 'inactive' : /retir/i.test(st) ? 'retired' : /active/i.test(st) ? 'active' : '';
  // 兜底:Team 行缺失(教练/下放/自由球员页常缺,allu 实测)→ 从 infobox 履历里找"未闭合区间"的最近队伍。
  // 履历可能独立成第二个 infobox 模块(allu 页:Player Information 与 Career History 分离),扫 wrapper 下全部模块;
  // 闭区间(起—止)不认:避免把已结束的旧队当现队;只认 "— Present" 或以分隔符收尾(只写了起始日)的条目;
  // 多条未闭合取 DOM 序最后一个(履历按时间升序,最后=最近;教练履历在球员履历之后,allu 场景正好取到 ENCE)
  if (!name) {
    const scope = $('.fo-nttax-infobox-wrapper').length ? $('.fo-nttax-infobox-wrapper') : $('.fo-nttax-infobox');
    scope.find('a[href^="/counterstrike/"]').each((_, a) => {
      const $a = $(a);
      const label = cleanText($a.text());
      if (!label) return;
      let node = $a;
      for (let i = 0; i < 5 && node.length; i++) {
        const txt = node.text() || '';
        if (/\d{4}-\d{2}/.test(txt)) { // 找到带日期的履历行
          const rest = cleanText(txt.split(label).join(' '));
          if (/[—–-]\s*(present)?\s*$/i.test(rest)) {
            const h = $a.attr('href') || '';
            if (/^\/counterstrike\/.+/.test(h)) { name = label; href = abs(h); }
          }
          break;
        }
        node = node.parent();
      }
    });
  }
  if (!name && !status) return null; // Team/Status 行与履历兜底都没认出来:页面结构对不上,维持旧约定返回 null
  return { name, href, status };
}

// ---------- 队伍页 roster 分区:下放(预备名单)与角色(Coach/Sub)判定 ----------
// LP 队伍页把名单分成若干张表,各挂一个分区标题(Active / Inactive / Former…),行内另有角色列
// (NRG 的教练 daps 那行角色列就写着 Coach)。**选手页 infobox 的 Status 表达的是职业生涯状态**
// (下放不离队的选手照样 Active,oSee 实测),判"下放/角色"必须看队伍页。
// 返回 {zone, role}:zone ∈ 'active'|'inactive'|'former'|'coach'(教练单列一表的分区)|''(没认出);
// role ∈ 'coach'|'sub'|''。zone 认不出时调用方回落选手页 Status
function parseTeamRoster(html, playerSlug) {
  const slug = String(playerSlug || '').replace(/^.*\/counterstrike\//i, '').replace(/[?#].*$/, '').toLowerCase();
  if (!html || !slug) return null;
  const $ = cheerio.load(html);
  // 归一顺序不可换:former(离队)优先于 inactive(还在队),inactive 优先于 active("Inactive" 含 active 子串);
  // Coach/Staff 分区标题 = 教练单列一表(该表里的人是现役教练组,角色随标题得出)
  const classify = (txt) => {
    const s = String(txt || '');
    return /former/i.test(s) ? 'former'
      : /inactiv|reserve|bench/i.test(s) ? 'inactive'
      : /coach|staff/i.test(s) ? 'coach'
      : /active/i.test(s) ? 'active' : '';
  };
  const rowRole = (txt) => {
    const s = String(txt || '');
    return /coach/i.test(s) ? 'coach' : /substitute|\bsub\b/i.test(s) ? 'sub' : '';
  };
  // 分区标题:新 MediaWiki 把 h3 包在 div.mw-heading 里,LP 另有 .table-header 行头;表格还可能被页签容器包裹
  const headingFor = (tbl) => {
    let node = tbl;
    for (let i = 0; i < 6 && node && node.length; i++) {
      const h = node.prevAll('h2,h3,h4,.mw-heading,.table-header').first();
      if (h.length) {
        const inner = h.find('h2,h3,h4,.mw-headline').first();
        return (inner.length ? inner.text() : h.text()) || '';
      }
      node = node.parent();
    }
    return '';
  };
  // 两通道:先扫标准 roster-table,落空再扫全部表格(信息框排除);选手链接命中后按"分区标题→表头行"归类,
  // CS2/CS:GO 双页签都命中取 DOM 序第一个(默认页签 CS2 在前)
  let zone = '', role = '';
  const scan = (sel, excludeInfobox) => {
    $(sel).each((_, t) => {
      if (zone) return;
      const tbl = $(t);
      if (excludeInfobox && tbl.closest('.fo-nttax-infobox').length) return;
      const hit = tbl.find('a[href^="/counterstrike/"]').toArray().some((a) => {
        const href = decodeURIComponent($(a).attr('href') || '');
        return href.replace(/^.*\/counterstrike\//i, '').replace(/[?#].*$/, '').toLowerCase() === slug;
      });
      if (!hit) return;
      // 命中行内的角色列:整行文字剥掉选手链接显示名后再认(标题认不出时退表头行)
      const tr = tbl.find('tr').toArray().find((r) => $(r).find(`a[href^="/counterstrike/"]`).toArray().some((a) => {
        const href = decodeURIComponent($(a).attr('href') || '');
        return href.replace(/^.*\/counterstrike\//i, '').replace(/[?#].*$/, '').toLowerCase() === slug;
      }));
      let rowTxt = '';
      if (tr) {
        const a = $(tr).find('a[href^="/counterstrike/"]').toArray().find((x) => {
          const href = decodeURIComponent($(x).attr('href') || '');
          return href.replace(/^.*\/counterstrike\//i, '').replace(/[?#].*$/, '').toLowerCase() === slug;
        });
        rowTxt = cleanText($(tr).text().replace(a ? $(a).text() : '', ' '));
      }
      const head = classify(headingFor(tbl)) || classify(tbl.find('tr').first().text());
      zone = head;
      role = rowRole(rowTxt) || (head === 'coach' ? 'coach' : '');
    });
  };
  scan('table.roster-table', false);
  if (!zone) scan('table', true);
  return zone ? { zone, role } : null;
}

// ---------- V社全球排名(Valve_Regional_Standings 页的全局榜) ----------
// 表结构:table2__table,表头 Rank|Points|Team|Region|Roster;行内 td[0]=名次,td[2]=队名+队页链接
function parseVrs(html, max = 200) {
  const $ = cheerio.load(html);
  const tab = $('table').toArray().find(t => {
    const h = $(t).find('tr').first().text().replace(/\s+/g, ' ');
    return /Rank/.test(h) && /Points/.test(h) && /Team/.test(h) && $(t).find('tr').length > 20;
  });
  if (!tab) throw new Error('VRS ranking table not found');
  const bySlug = {}, byName = {};
  $(tab).find('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;
    const rank = parseInt(tds.eq(0).text(), 10);
    const points = parseFloat(tds.eq(1).text());
    const a = tds.eq(2).find('a[href^="/counterstrike/"]').first();
    const name = cleanText(a.text()) || cleanText(tds.eq(2).text());
    if (!Number.isFinite(rank) || !name) return;
    const slug = decodeURIComponent((a.attr('href') || '').replace(/^.*\/counterstrike\//, '').replace(/[?#].*$/, ''));
    const region = cleanText(tds.eq(3).text()).toUpperCase();
    const rec = { rank, points: Number.isFinite(points) ? points : null, region, name };
    if (slug && !bySlug[slug.toLowerCase()]) bySlug[slug.toLowerCase()] = rec;
    if (!byName[name.toLowerCase()]) byName[name.toLowerCase()] = rec;
    if (Object.keys(bySlug).length >= max) return false;
  });
  return { bySlug, byName };
}

// ---------- 赛事页对阵弹层的逐图数据(图序/逐图比分) ----------
// BP 都是赛前才完成:弹层里已填图名的场次天然就是临场的;未 BP 的弹层没有图槽,不采。
// 赛事页(如 CCT/2026/Europe/Series_8)每个对阵内嵌 brkts-popup,图行 = brkts-popup-body-grid-row
function parseEventMaps(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.brkts-popup').each((_, el) => {
    const p = $(el);
    const timer = p.find('.timer-object').first();
    if (!timer.length) return;
    const ts = parseInt(timer.attr('data-timestamp'), 10) * 1000;
    if (!Number.isFinite(ts)) return;
    const names = [];
    p.find('.match-info-header-opponent').each((__, o) => {
      const a = $(o).find('.name a').first();
      names.push(cleanText(a.attr('title') || a.text()).replace(/\s*\(page does not exist\)\s*/, ''));
    });
    if (names.length < 2 || !names[0] || !names[1]) return;
    const games = [];
    p.find('.brkts-popup-body-grid-row').each((__, row) => {
      const r = $(row);
      const a = r.find('a[title]').first();
      const sc = r.find('.brkts-popup-body-detailed-scores-main-score').map((___, x) => parseInt($(x).text(), 10));
      games.push({
        map: a.length ? cleanText(a.attr('title') || a.text()) : '',
        s1: Number.isFinite(sc[0]) ? sc[0] : null,
        s2: Number.isFinite(sc[1]) ? sc[1] : null,
      });
    });
    while (games.length && !games[games.length - 1].map) games.pop(); // 尾部未定的空图槽剪掉
    if (!games.some((g) => g.map)) return; // BP 未出
    const bo = (cleanText(p.find('.match-info-header-scoreholder-lower').first().text()).match(/[Bb][Oo]\s?\d/) || [''])[0].toUpperCase();
    out.push({ ts, a: names[0], b: names[1], bestof: bo, games });
  });
  return out;
}

// ---------- 赛事页信息框评级(掉榜赛事回填用) ----------
// LP 赛事页 infobox 的 "Liquipedia tier" 行,值形如 "S-Tier"/"A-Tier"(老页面偶见 Premier=今 S 级)
function parseEventTier(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  const box = $('.infobox').first();
  const raw = box.length ? $.html(box) : html;
  // 标签必须换成空格:直接 .text() 会把相邻文本节点粘连成 "tierS-Tier",词边界被吃掉匹配不到
  const text = raw.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ');
  const m = /\b(S|A|B|C)(?:\s?-\s?|\s)Tier\b/i.exec(text);
  if (m) return m[1].toUpperCase();
  return /\bPremier\b/i.test(text) ? 'S' : '';
}

// ---------- 赛事页信息框日期段(掉榜回填时顺带采) ----------
// 新模板两行 ISO:"Start Date: 2026-09-05" / "End Date: 2026-09-13";老模板一行区间:"Dates: Sep 5, 2026 — Sep 13, 2026"
// (日期能是 "September 5th" 序数式)。返回 { d1, d2 }(UTC 正午,日级精度)——赛事真正起止;
// 48h 最近赛果窗口里"最早一场"只是窗口尾巴,当不得开赛时间
function parseEventDates(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const cell = (re) => {
    let out = '';
    $('.infobox-description').each((_, el) => {
      if (!out && re.test($(el).text())) out = cleanText($(el).next().text());
    });
    return out;
  };
  // 结构 A:Start Date / End Date 两行(ISO,也可混别的写法,先按 ISO 取)
  const iso = (s) => { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(s || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 12) : 0; };
  const a1 = iso(cell(/start\s+date/i));
  const a2 = iso(cell(/end\s+date/i));
  if (a1 || a2) return { ...(a1 ? { d1: a1 } : {}), ...(a2 ? { d2: a2 } : {}) };
  // 结构 B:"Dates:" / "Date:" 单行,区间或单日
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mon = (t) => MON[String(t || '').slice(0, 3).toLowerCase()];
  const txt = cell(/\bdates?\b/i);
  if (!txt) return null;
  const ORD = '(?:st|nd|rd|th)?';
  let m = new RegExp(`([A-Za-z]{3,9})\\.?\\s*(\\d{1,2})${ORD}(?:,?\\s*(\\d{4}))?\\s*[–—-]\\s*(?:([A-Za-z]{3,9})\\.?\\s*)?(\\d{1,2})${ORD}(?:,?\\s*(\\d{4}))?`, 'i').exec(txt);
  if (m && mon(m[1]) !== undefined) {
    const y1 = m[3] ? +m[3] : (m[6] ? +m[6] : new Date().getFullYear());
    const m2 = m[4] ? mon(m[4]) : mon(m[1]);
    if (m2 === undefined) return null;
    const mk = (yr) => {
      let a = Date.UTC(yr, mon(m[1]), +m[2], 12);
      let b = Date.UTC(yr, m2, +m[5], 12);
      if (b < a) b = Date.UTC(yr + 1, m2, +m[5], 12); // 跨年:"Dec 30 – Jan 3"
      return [a, b];
    };
    let [d1, d2] = mk(y1);
    if (!(m[3] || m[6]) && d1 > Date.now() + 2 * 864e5) [d1, d2] = mk(y1 - 1); // 年份缺省且落在未来:整体退一年(回填对象必已完赛)
    return { d1, d2 };
  }
  m = new RegExp(`([A-Za-z]{3,9})\\.?\\s*(\\d{1,2})${ORD}(?:,?\\s*(\\d{4}))?`, 'i').exec(txt); // 兜底:单日 "Sep 5, 2026"(一日赛)
  if (m && mon(m[1]) !== undefined) {
    const y = m[3] ? +m[3] : new Date().getFullYear();
    let d1 = Date.UTC(y, mon(m[1]), +m[2], 12);
    if (!m[3] && d1 > Date.now() + 2 * 864e5) d1 = Date.UTC(y - 1, mon(m[1]), +m[2], 12);
    return { d1, d2: d1 };
  }
  return null;
}

// ---------- VRS 数据日期(页面自带 "updated: YYYY-MM-DD Data by Liquipedia" 标注) ----------
// api.php 响应没有 Last-Modified,页面修订时间也可能只是排版改动;数据表自带的 updated 标注才是真正的数据更新日
function parseVrsStamp(html) {
  if (!html) return 0;
  const m = /updated:\s*(\d{4})-(\d{2})-(\d{2})/i.exec(String(html).replace(/<[^>]*>/g, ' '));
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], 12); // 正午 UTC:纯日期无时区,取正午避免任何偏移把日期挤过界
}

module.exports = { parseMatches, parseEventMaps, parseEvents, parseTransfers, parsePlayerTeam, parseTeamRoster, parseVrs, parseEventTier, parseEventDates, parseVrsStamp };
