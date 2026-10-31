// updater 纯函数测试:node _dev/test-updater.js(仿 test-supplement 先例,零依赖)
const { parseRelNotes, newerVer } = require('../lib/updater');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error('  ✗', name); } };

// newerVer:三段数字逐段比,v 前缀可省
ok(newerVer('v0.0.3', '0.0.2') === true, '1 v0.0.3 > 0.0.2');
ok(newerVer('0.0.2', '0.0.2') === false, '2 同版本不新');
ok(newerVer('0.0.10', '0.0.9') === true, '3 0.0.10 > 0.0.9(数值比,非字典序)');
ok(newerVer('0.1', '0.0.9') === true, '4 0.1 > 0.0.9(短版本补零)');
ok(newerVer('v1.0.0', '1.0.1') === false, '5 v1.0.0 < 1.0.1');

// parseRelNotes:首行「代号|寄语」,解析失败回退 null
const rn = parseRelNotes('惊蛰|微雨众卉新,一雷惊蛰始。\n其余说明文字');
ok(rn && rn.code === '惊蛰' && rn.quote === '微雨众卉新,一雷惊蛰始。', '6 首行代号|寄语解析');
ok(parseRelNotes('') === null, '7 空串 → null');
ok(parseRelNotes('没有竖线的说明\n第二行') === null, '8 无竖线 → null');

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
