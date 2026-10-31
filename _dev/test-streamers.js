// 主播开播判定纯函数/三态派生测试:node _dev/test-streamers.js(仿 test-supplement 先例,零依赖,不触网)
const { createStreamers, parseStreamerLive, STREAMERS } = require('../lib/streamers');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error('  ✗', name); } };

// —— 斗鱼:内嵌 JSON 双重转义容错(\\\"key\\\":v) ——
const dqEsc = String.raw`{\\\"show_status\\\":1,\\\"videoLoop\\\":0}`; // 双重转义样本,实际文本含 \\\"
ok(parseStreamerLive('douyu', dqEsc) === true, '1 双重转义 show_status:1 + videoLoop:0 → 开播');
ok(parseStreamerLive('douyu', String.raw`{\\\"show_status\\\":1,\\\"videoLoop\\\":1}`) === false, '2 videoLoop:1(轮播)→ 不算开播');
ok(parseStreamerLive('douyu', String.raw`{\\\"show_status\\\":2}`) === false, '3 show_status:2 → 未开播');
ok(parseStreamerLive('douyu', '<html>普通页面无字段</html>') === false, '4 无字段 → 未开播');
ok(parseStreamerLive('douyu', '{"show_status":1,"other":2}') === true, '5 单层转义 show_status:1 无 videoLoop → 开播');

// —— 虎牙:isOn:true 且 isReplay:false ——
ok(parseStreamerLive('huya', '{"isOn":true,"isReplay":false}') === true, '6 isOn+非回放 → 开播');
ok(parseStreamerLive('huya', '{"isOn":true,"isReplay":true}') === false, '7 回放 → 不算开播');
ok(parseStreamerLive('huya', '{"isOn":false}') === false, '8 isOn:false → 未开播');
ok(parseStreamerLive('huya', '<html>无字段</html>') === false, '9 无字段 → 未开播');

// —— wanjiqiState 三态(不触网:createStreamers 仅注入空实现) ——
const { streamerStatus, wanjiqiState } = createStreamers({ getStore: () => null, getWin: () => null, pushData: () => { }, isShot: false });
ok(wanjiqiState() === null, '10 首轮未完成(updatedAt=0)→ null(未知)');
streamerStatus.updatedAt = Date.now();
const wj = streamerStatus.list.find((s) => s.key === 'wanjiqi');
ok(!!wj, '11 STREAMERS 含 wanjiqi 条目');
wj.live = true;
ok(wanjiqiState() && wanjiqiState().live === true, '12 live=true → {live:true}');
wj.live = false; wj.err = 'x';
ok(wanjiqiState() === null, '13 探测失败(err)且未在播 → null(保留按钮)');
wj.err = '';
ok(wanjiqiState() && wanjiqiState().live === false, '14 探测成功未在播 → {live:false}');

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
