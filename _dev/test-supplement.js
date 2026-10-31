// 判重/补充纯函数测试:node _dev/test-supplement.js(仿 test-pending 先例,零依赖)
const { isSameMatch, supplementRecent, setLearnedAliases } = require('../lib/live');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error('  ✗', name); } };
const H = 3600e3;
const now = Date.now();
const lp = (a, b, ts, extra = {}) => ({ ts, teamA: { name: a }, teamB: { name: b }, ...extra });
const pd = (a, b, ts, extra = {}) => ({ ts, teamA: { name: a }, teamB: { name: b }, ...extra });

// 1 同名同刻 → 同场,不重复补充
ok(isSameMatch(lp('NAVI', 'MOUZ', now), pd('NAVI', 'MOUZ', now)), '1 同名同刻判同场');

// 2 Jr. ↔ Junior(归一后剥词根)→ 同场
ok(isSameMatch(lp('NAVI Jr.', 'MOUZ', now), pd('NAVI Junior', 'MOUZ', now)), '2 Jr.↔Junior 判同场');

// 3 全名 ↔ 缩写(子串互含)→ 同场
ok(isSameMatch(lp('Natus Vincere', 'MOUZ', now), pd('NAVI', 'MOUZ', now)), '3 全名↔缩写判同场');

// 4 同队对 8h 后再战 → 不同场,允许补充(不吞场次)
ok(!isSameMatch(lp('NAVI', 'MOUZ', now), pd('NAVI', 'MOUZ', now - 8 * H)), '4 同队对 8h 再战判不同场');

// 5 同队对 2h 再战(GSL 决胜局式)→ 判同场(用户口径:宁可不重复)
ok(isSameMatch(lp('NAVI', 'MOUZ', now), pd('MOUZ', 'NAVI', now - 2 * H)), '5 同队对 2h 再战判同场(交换位次)');

// 6 完全不同队 → 不同场
ok(!isSameMatch(lp('NAVI', 'MOUZ', now), pd('FaZe', 'Vitality', now)), '6 不同队判不同场');

// 7 缺 ts 的 Panda 行不会进入 recent 管线(past 接口已过滤),走队名判定时视为不同场次 → 不补充
ok(!isSameMatch(lp('NAVI', 'MOUZ', now), pd('NAVI', 'MOUZ', undefined)), '7 缺 ts 不判同场(上游保证 recent 行必有 ts)');

// —— supplementRecent 集成 ——
const lpRecent = [
  lp('FaZe', 'Vitality', now - 3 * H, { endedAt: now - 2 * H }),
  lp('NAVI Jr.', 'QUAZAR', now - 30 * H, { endedAt: now - 29 * H }),
];
const pandaRecent = [
  pd('FaZe', 'Vitality', now - 3 * H, { endedAt: now - 2 * H }),          // 重复:LP 已有
  pd('NAVI Junior', 'QUAZAR', now - 30 * H, { endedAt: now - 29 * H }),   // 重复:Jr. 词根
  pd('NAVI', 'MOUZ', now - 5 * H, { endedAt: now - 4 * H }),              // LP 缺失 → 补
  pd('G2', 'Legacy', now - 40 * H, { endedAt: now - 39 * H }),            // LP 缺失 → 补(更早,排序应靠后)
];
const merged = supplementRecent(lpRecent, pandaRecent);
ok(merged.length === 4, `8 补充后总数 4(实际 ${merged.length})`);
ok(merged[0].teamA.name === 'FaZe', '9 按 endedAt 全局降序,FaZe(最新结束)在最前');
ok(merged[1].teamA.name === 'NAVI' && merged[1].panda === true, '10+11 补充行按结束时刻归位(NAVI/MOUZ 第 2)且带 panda 标记');
ok(merged[3].teamA.name === 'G2', '11b 最早的 G2 在最后,LP 原行全部保留');
ok(supplementRecent(merged, pandaRecent).length === 4, '12 幂等:同源再跑不重复补充');

// 13 同一 Panda 行的两份拷贝(一份已被池子装饰改名)→ id 相等判同场,不再补第二条
ok(isSameMatch(
  lp('EYE', 'WIMOK', now, { id: 'panda-9' }),
  pd('Eyeballers', 'WIMOK', now, { id: 'panda-9' })
), '13 同 id 两份拷贝判同场(装饰改名不失手)');

// 14 学习别名参与判重:LP「LG」行 ↔ Panda「Luminosity」行(页链别名同步后)
const lpRow = lp('LG', 'NIP', now, { id: 'lp-1' });
const pdRow = pd('Luminosity', 'Ninjas in Pyjamas', now, { id: 'panda-1' });
ok(isSameMatch(lpRow, pdRow) === false, '14a 未学别名时配不上(复现重复条目的根源)');
setLearnedAliases({ lg: 'luminosity', nip: 'ninjasinpyjamas' });
ok(isSameMatch(lpRow, pdRow) === true, '14b 学别名后判同场(与队伍池显示同源)');
ok(supplementRecent([lpRow], [pdRow]).length === 1, '14c 学别名后同场 Panda 行不再补入(LP 已有 LG vs NIP)');
setLearnedAliases({});

// 15 已补充过的列表整体重套用(行已被装饰改名)不产生重复
const deco = supplementRecent([lp('NAVI', 'MOUZ', now)], [pd('Natus Vincere', 'MOUZ', now - H, { id: 'panda-7', endedAt: now - H })]);
deco.forEach((m) => { if (m.panda) { m.teamA = { name: 'NAVI' }; m.teamB = { name: 'MOUZ' }; } }); // 模拟 payload 装饰改写补位行队名
ok(supplementRecent(deco, [pd('Natus Vincere', 'MOUZ', now - H, { id: 'panda-7', endedAt: now - H })]).length === deco.length, '15 装饰过的列表重套用不重复(名字改了 id 还在)');

// —— pandaRecentPair:结束时刻回填/僵死直播清理的同场判据(2026-09-20 FURIA/Vitality 回归)——
const { pandaRecentPair } = require('../lib/live');
const fuzzyYes = () => true, fuzzyNo = () => false;

// 16 同队对(交换位次)开赛差 41h → 不同场:同队再战绝不允许跨场配对(当日新场结束时刻盖到前日旧场键的根源)
ok(!pandaRecentPair(lp('FURIA', 'Vitality', now - 43 * H), pd('Vitality', 'FURIA', now), fuzzyNo), '16a matchKey 全等但隔 41h → 不同场(回归:前日场被新场覆盖)');
ok(!pandaRecentPair(lp('FURIA', 'Vitality', now - 43 * H), pd('Vitality', 'FURIA', now), fuzzyYes), '16b 模糊分支也不能救回超窗配对');

// 17 同队对开赛差 1h → 同场(LP 排定时刻与 Panda 实际开赛的正常漂移)
ok(pandaRecentPair(lp('FURIA', 'Vitality', now - H), pd('Vitality', 'FURIA', now), fuzzyNo), '17 同队对 1h 漂移判同场');

// 18 名字模糊(变名/别名失手)→ 30min 紧窗:窗内同场,窗外拒绝
ok(pandaRecentPair(lp('EYE', 'WIMOK', now - 20 * 60e3), pd('Eyeballers', 'WIMOK', now), fuzzyYes), '18a 模糊名 20min 判同场');
ok(!pandaRecentPair(lp('EYE', 'WIMOK', now - 2 * H), pd('Eyeballers', 'WIMOK', now), fuzzyYes), '18b 模糊名 2h 拒绝(防跨场)');
ok(!pandaRecentPair(lp('EYE', 'WIMOK', now), pd('Eyeballers', 'WIMOK', now), fuzzyNo), '18c 模糊名但 fuzzyFn 不认 → 拒绝');

// 19 缺开赛时刻不设窗(与旧判据兼容)
ok(pandaRecentPair(lp('NAVI', 'MOUZ', undefined), pd('NAVI', 'MOUZ', now), fuzzyNo), '19a LP 缺 ts → 名字键全等即同场');
ok(pandaRecentPair(lp('NAVI', 'MOUZ', now), pd('NAVI', 'MOUZ', undefined), fuzzyNo), '19b Panda 缺 ts → 同场');

// 20 品牌缩写↔全名跨源(2026-10-26 FURIA 0:2 NAVI 实例):LP 写 NAVI、Panda 写 Natus Vincere,
// 精确键与调用方 fuzzyFn(子串互含且短边≥5,'navi' 只有 4 字符)都配不上 → 须由 pairEq 的
// NAME_ALIASES 桥接。桥接不了则 confirmStaleLive 摘不掉已结束的直播行,与赛果补位行并存成
// "同场两区重复",只能等 LP 自己翻页
ok(pandaRecentPair(lp('FURIA', 'NAVI', now - 5 * 60e3), pd('FURIA', 'Natus Vincere', now), fuzzyNo), '20a NAVI↔Natus Vincere 判同场(NAME_ALIASES 桥接,fuzzyFn 失手时兜住)');
ok(!pandaRecentPair(lp('FURIA', 'NAVI', now - 2 * H), pd('FURIA', 'Natus Vincere', now), fuzzyNo), '20b 别名桥接仍守 30min 紧窗(防同队再战跨场配对)');

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
