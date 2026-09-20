// 队伍池断言:规范名归并 / 来源优先级 / 缺口补全 / VRS 回填 / LRU 封顶 / 幂等 / 页链别名学习
const { canonKey, mergeTeam, enrichFromMatches, enrichFromRankings, decorateMatches, decorateSide, capPool, DISPLAY_SEED, loadAliasCanon, aliasCanon, learnAlias } = require('../lib/teampool');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok - ' + label); } else { fail++; console.log('  FAIL - ' + label); } }

// 1) 键归并:品牌别名同队;学院队独立
ok(canonKey('NAVI') === canonKey('Natus Vincere'), 'navi 与 Natus Vincere 同键');
ok(canonKey('NAVI Jr.') !== canonKey('NAVI'), 'NAVI Jr. 与 NAVI 不同键(学院队不并母队)');
ok(canonKey('NAVI Jr.') === canonKey('NAVI Junior') && canonKey('NAVI Jr.') === canonKey('Natus Vincere Junior'), '同一支学院队三源叫法同键(LP Jr./Panda Junior/VRS 全名)');
ok(canonKey('Spirit Jr.') === canonKey('Spirit Junior'), '通用 junior→jr 后缀归并');
ok(canonKey('Team Liquid') === canonKey('Liquid'), 'Team 剥词:Team Liquid=Liquid');
ok(canonKey('') === '', '空名不给键');

// 2) 来源优先级:lp 覆盖 panda,panda 只补缺
{
  const pool = {};
  mergeTeam(pool, 'Natus Vincere', { name: 'Natus Vincere', logo: 'panda.png' }, 'panda');
  mergeTeam(pool, 'NAVI', { name: 'NAVI', href: 'https://liquipedia.net/counterstrike/Natus_Vincere' }, 'lp');
  ok(pool.natusvincere.name === 'NAVI', 'lp 展示名覆盖 panda 全名');
  ok(pool.natusvincere.logo === 'panda.png', '低优先来源的 logo 补缺保留');
  ok(!!pool.natusvincere.href, 'lp 的 href 入池');
}

// 3) VRS 供给 + 排名以最近一次为准
{
  const pool = {};
  enrichFromRankings(pool, { bySlug: { natus_vincere: { rank: 11, name: 'Natus Vincere' }, team_vitality: { rank: 6, name: 'Team Vitality' } } });
  ok(pool.natusvincere.vrs === 11, 'VRS 排名入池');
  mergeTeam(pool, 'Natus Vincere', { vrs: 9 }, 'vrs');
  ok(pool.natusvincere.vrs === 9, '榜单刷新覆盖旧排名');
}

// 4) 装饰:Panda 补位行获得规范名/href/logo/VRS(用户实况:NAVI 行显示 Natus Vincere 且缺 VRS)
{
  const pool = {};
  enrichFromMatches(pool, { recent: [{ panda: false, teamA: { name: 'NAVI', href: 'https://liquipedia.net/counterstrike/Natus_Vincere', logo: 'lp-navi.png' }, teamB: { name: 'MOUZ', href: 'https://liquipedia.net/counterstrike/Mouz', logo: 'lp-mouz.png' } }] });
  enrichFromRankings(pool, { bySlug: { natus_vincere: { rank: 11, name: 'Natus Vincere' }, mouz: { rank: 4, name: 'MOUZ' } } });
  const matches = { recent: [{ panda: true, teamA: { name: 'Natus Vincere', href: '', logo: '' }, teamB: { name: 'MOUZ', href: '', logo: 'panda-mouz.png' } }] };
  decorateMatches(matches, pool);
  const a = matches.recent[0].teamA, b = matches.recent[0].teamB;
  ok(a.name === 'NAVI', 'Panda 行 NAVI 显示规范短名(不是 Natus Vincere)');
  ok(a.href === 'https://liquipedia.net/counterstrike/Natus_Vincere', '补位行获得 LP 队页链接');
  ok(a.logo === 'lp-navi.png', '补位行获得池内队标');
  ok(a.vrs === 11 && b.vrs === 4, '补位行带 VRS 排名(双方)');
  ok(b.logo === 'panda-mouz.png', '自身已有 logo 不被覆盖');
}

// 5) 品牌种子:该队只有 panda 名入池时也按品牌名显示
{
  const pool = {};
  mergeTeam(pool, 'Natus Vincere', { name: 'Natus Vincere' }, 'panda');
  const t = decorateSide({ name: 'Natus Vincere', href: '', logo: '' }, pool);
  ok(t.name === DISPLAY_SEED.natusvincere, '无 lp 名时种子生效(NAVI)');
}

// 5b) 学院队跨源归并:Panda「NAVI Junior」行拿到 LP「NAVI Jr.」的名/链接 + VRS 排名
{
  const pool = {};
  enrichFromMatches(pool, { recent: [{ panda: false, teamA: { name: 'NAVI Jr.', href: 'https://liquipedia.net/counterstrike/Natus_Vincere_Junior', logo: 'jr.png' }, teamB: { name: 'X', href: '', logo: '' } }] });
  enrichFromRankings(pool, { bySlug: { natus_vincere_junior: { rank: 136, name: 'Natus Vincere Junior' } } });
  ok(pool.navijr && pool.navijr.vrs === 136, 'VRS 全名键归并进学院队池条目');
  const row = { recent: [{ panda: true, teamA: { name: 'NAVI Junior', href: '', logo: '' }, teamB: { name: 'QUAZAR', href: '', logo: '' } }] };
  decorateMatches(row, pool);
  const a = row.recent[0].teamA;
  ok(a.name === 'NAVI Jr.' && a.href.includes('Natus_Vincere_Junior') && a.vrs === 136, 'Panda 学院队行归一为 LP 短名+链接+VRS');
}

// 6) LP 行自身不被改写;TBD 行不动
{
  const pool = {};
  mergeTeam(pool, 'FURIA', { name: 'FURIA', href: 'https://liquipedia.net/counterstrike/FURIA' }, 'lp');
  const lp = { name: 'FURIA', href: 'https://liquipedia.net/counterstrike/FURIA', logo: 'f.png' };
  const out = decorateSide(lp, pool);
  ok(out.name === 'FURIA' && out.href === lp.href && out.logo === lp.logo, 'LP 行经装饰后字段不变(规范名即自身)');
  const tbd = decorateSide({ name: '', href: '', logo: '' }, pool);
  ok(tbd.name === '', '空名(TBD)不被装饰');
}

// 7) 幂等:二次 enrich/decorate 全等
{
  const pool = {};
  enrichFromMatches(pool, { live: [{ panda: false, teamA: { name: 'NAVI', href: 'h1', logo: 'l1' }, teamB: { name: 'X', href: '', logo: '' } }] });
  const snap1 = JSON.stringify(pool);
  enrichFromMatches(pool, { live: [{ panda: false, teamA: { name: 'NAVI', href: 'h1', logo: 'l1' }, teamB: { name: 'X', href: '', logo: '' } }] });
  ok(JSON.stringify(pool) === snap1, '重复供数不改变池子(at 除外)' );
  const m = { recent: [{ panda: true, teamA: { name: 'Natus Vincere', href: '', logo: '' } }] };
  decorateMatches(m, pool);
  const once = JSON.stringify(m.recent[0].teamA);
  decorateMatches(m, pool);
  ok(JSON.stringify(m.recent[0].teamA) === once, '重复装饰幂等(装饰结果本身可再装饰)');
}

// 8) LRU 封顶
{
  const pool = {};
  for (let i = 0; i < 10; i++) mergeTeam(pool, 'T' + i, { name: 'T' + i }, 'lp');
  Object.values(pool).forEach((e, i) => { e.at = i; });
  capPool(pool, 5);
  ok(Object.keys(pool).length === 5, '封顶后只留 5 支');
  ok(!pool.t0 && !pool.t4 && !!pool.t5 && !!pool.t9, '淘汰最旧、保留最新');
}

// 9) 页链别名学习:LG↔Luminosity 用户实例(跨选项卡单名)
{
  loadAliasCanon({}); // 别名表清零,与全新启动对齐
  const pool = {};
  const lpUp = { live: [], upcoming: [{ panda: false, teamA: { name: 'LG', href: 'https://liquipedia.net/counterstrike/Luminosity_Gaming', logo: 'lp.png' }, teamB: { name: 'OPP', href: '', logo: '' } }], recent: [] };
  enrichFromMatches(pool, lpUp);
  ok(aliasCanon().lg === 'luminosity', 'LP 行学出别名 lg→luminosity(页链身份锚)');
  ok(!pool.lg && !!pool.luminosity, '直接落在身份键,无旧展示键残留');
  ok(pool.luminosity.name === 'LG' && pool.luminosity.href.includes('Luminosity_Gaming') && pool.luminosity.logo === 'lp.png', '身份键上 LP 名/页链/队标齐全');
  const pdRow = { panda: true, teamA: { name: 'Luminosity', href: '', logo: 'pd.png' }, teamB: { name: 'OPP', href: '', logo: '' } };
  enrichFromMatches(pool, { recent: [pdRow] });
  const dec = decorateMatches({ recent: [{ panda: true, teamA: { name: 'Luminosity', href: '', logo: 'pd.png' } }] }, pool);
  ok(dec.recent[0].teamA.name === 'LG', 'Panda 全名行装饰后显示 LP 短名(与即将开始同一名字)');
  ok(dec.recent[0].teamA.logo === 'pd.png', '行自有队标不被池子覆盖(池子只补缺)');
  enrichFromRankings(pool, { bySlug: { luminosity: { name: 'Luminosity', rank: 29 } } });
  const dec2 = decorateMatches({ recent: [{ panda: true, teamA: { name: 'Luminosity', href: '', logo: '' } }] }, pool);
  ok(dec2.recent[0].teamA.name === 'LG' && dec2.recent[0].teamA.vrs === 29, 'VRS 全名归并同键:行显示 LP 名+VRS 徽章');
  enrichFromMatches(pool, { recent: [{ panda: false, teamA: { name: 'Luminosity', href: 'https://liquipedia.net/counterstrike/Luminosity_Gaming', logo: '' }, teamB: { name: 'OPP', href: '', logo: '' } }] });
  ok(pool.luminosity.name === 'LG', 'LP 另一区块写全名也不翻面(name 同优先级 keep-first)');
  const snap = JSON.stringify(pool), asnap = JSON.stringify(aliasCanon());
  enrichFromMatches(pool, lpUp);
  enrichFromMatches(pool, { recent: [pdRow] });
  learnAlias(pool, { name: 'LG', href: 'https://liquipedia.net/counterstrike/Luminosity_Gaming' });
  ok(JSON.stringify(pool) === snap && JSON.stringify(aliasCanon()) === asnap, '别名学习/供数重复跑幂等(写盘闸门闭得上)');
  const saved = aliasCanon();
  loadAliasCanon({});
  ok(aliasCanon().lg === undefined, '别名表可清零');
  loadAliasCanon(saved);
  ok(canonKey('LG') === 'luminosity' && canonKey('Luminosity') === 'luminosity', '启动回灌后两个叫法同键');
  ok(canonKey('NAVI') === 'natusvincere' && DISPLAY_SEED.natusvincere === 'NAVI', '学习别名不干扰内置别名与种子');
  const rl = {};
  ok(learnAlias(rl, { name: 'Banger', href: 'https://liquipedia.net/counterstrike/index.php?title=Banger_Gang&action=edit&redlink=1' }) === false, 'LP 红链(index.php)不学别名(两支队红链同指 index.php 会撞键互覆)');
  ok(learnAlias(rl, { name: 'BBL', href: 'https://liquipedia.net/counterstrike/index.php?title=BBL_Esports&action=edit&redlink=1' }) === false && Object.keys(rl).length === 0, '红链不产生任何别名与迁移');
  loadAliasCanon({}); // 收尾清零,不给后续运行留状态
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
