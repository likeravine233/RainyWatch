// 赛事池沙盘测试:node _dev/test-eventpool.js
const { evKey, learnEvents, lookupEvent } = require('../lib/eventpool');
const { isSameMatch } = require('../lib/live');

let pass = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  ✗ ' + msg); process.exitCode = 1; } else { pass++; console.log('  ✓ ' + msg); } };

const lpRow = (a, b, event, href, icon, ts) => ({
  teamA: { name: a }, teamB: { name: b }, ts: ts ?? Date.now(),
  event, eventHref: href || '', eventIcon: icon || '', panda: false,
});
const pdRow = (a, b, event, ts) => ({
  teamA: { name: a }, teamB: { name: b }, ts: ts ?? Date.now(),
  event, eventHref: '', eventIcon: '', panda: true,
});

console.log('[1] evKey 归一');
ok(evKey('StarLadder StarSeries') === 'starladderstarseries', '小写去符号');
ok(evKey(' SL StarSeries — Fall 2026 ') === 'slstarseriesfall2026', '空格/标点/全角破折号全剥');
ok(evKey('') === '' && evKey(null) === '', '空值安全');

console.log('[2] 同场配对学习:Panda 名 → LP 规范身份(NAVI vs Aurora 实例)');
const now = Date.now();
const lpMatches = {
  live: [],
  upcoming: [],
  recent: [
    lpRow('NAVI', 'Aurora', 'SL StarSeries Fall 2026', 'https://liquipedia.net/counterstrike/SL_StarSeries_Fall_2026', 'SL.png', now - 3600e3),
    lpRow('G2', 'MOUZ', 'ESL Pro League Season 23', 'https://liquipedia.net/counterstrike/ESL_Pro_League/Season_23', 'esl.png', now - 7200e3),
  ],
};
const pandaList = {
  live: [],
  upcoming: [],
  recent: [
    pdRow('Natus Vincere', 'AURORA Gaming', 'StarLadder StarSeries', now - 3600e3), // 品牌名+大小写+后缀差异,isSameMatch 抓得住
    pdRow('G2 Esports', 'MOUZ', 'ESL Pro League S23', now - 7200e3),                // 另一赛事另一键:各自学到各的 LP 身份
    pdRow('Team Liquid', 'Falcons', 'PGL Bucharest', now - 5400e3),                 // LP 没这场:学不到,池子不动
  ],
};
const pool = {};
ok(learnEvents(pandaList, lpMatches, pool) === true, '首轮学习有变化');
ok(Object.keys(pool).length === 2, `只学到有 LP 同场配对的赛事(实际 ${Object.keys(pool).length})`);
const e1 = pool.starladderstarseries;
ok(e1 && e1.name === 'SL StarSeries Fall 2026', '赛事名取 LP 规范名');
ok(e1 && e1.href === 'https://liquipedia.net/counterstrike/SL_StarSeries_Fall_2026', '页链挂上评级链');
ok(e1 && e1.icon === 'SL.png', '图标随 LP');
ok(lookupEvent('StarLadder StarSeries', pool) === e1, '反查命中(原始 Panda 名)');
ok(lookupEvent('  starladder…StarSeries!! ', pool) === e1, '反查容忍大小写/符号噪声');
ok(lookupEvent('Unknown Cup', pool) === null, '未知赛事返回 null(行保持原样)');

console.log('[3] 幂等:同数据重学不写盘');
ok(learnEvents(pandaList, lpMatches, pool) === false, '二轮学习无变化(写盘闸门闭得上)');

console.log('[4] 学习源防线');
ok(isSameMatch(lpMatches.recent[0], pandaList.recent[0]) === true, 'isSameMatch 跨源配对成立(回归锚)');
const noHref = { live: [lpRow('NAVI', 'Aurora', '', '', '', now)], upcoming: [], recent: [] };
const pool2 = {};
learnEvents({ live: [], upcoming: [], recent: [pdRow('NAVI', 'Aurora', 'StarLadder StarSeries', now)] }, noHref, pool2);
ok(Object.keys(pool2).length === 0, 'LP 行无赛事页链时不学(学了也挂不上评级链)');

console.log('[5] LP 行自身名与 Panda 名相同的赛事(同名赛事)');
const pool3 = {};
const lpEsl = { live: [], upcoming: [], recent: [lpRow('Vitality', 'Spirit', 'ESL Pro League', 'https://liquipedia.net/counterstrike/ESL_Pro_League', 'e.png', now)] };
learnEvents({ live: [], upcoming: [], recent: [pdRow('Vitality', 'Team Spirit', 'ESL Pro League', now)] }, lpEsl, pool3);
ok(pool3.eslproleague && pool3.eslproleague.name === 'ESL Pro League', '同名赛事也入池(补的是 href/icon)');

console.log('[6] 空入参安全');
ok(learnEvents(null, lpMatches, {}) === false && learnEvents(pandaList, null, {}) === false, 'null 列表不炸');

console.log(`\n${pass} 项断言全部通过`);
