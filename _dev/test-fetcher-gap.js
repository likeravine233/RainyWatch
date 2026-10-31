// fetcher 双车道限速时序测试:node _dev/test-fetcher-gap.js(仿 test-supplement 先例,不发真实请求)
// 裸 Node 下 sharedSlot 因 require('electron') 失败自动跳过,只剩进程内间隔约束被测
const { _gapForTest: gap, _setGapForTest } = require('../lib/fetcher');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error('  ✗', name); } };

const PARSE = 300, LIGHT = 40, TOL = 5;
_setGapForTest({ parseMs: PARSE, lightMs: LIGHT });

const stamps = [];
const rel = (kind, tag) => () => stamps.push({ kind, tag, at: Date.now(), rel: Date.now() - t0 });
const at = (tag) => stamps.find((s) => s.tag === tag).rel;
let t0 = Date.now();

(async () => {
  // 1 连续 3 次 parse:相邻放行间隔 ≥ parseMs
  const t1 = Date.now();
  await Promise.all([0, 1, 2].map((i) => gap('parse').then(rel('parse', 'p' + i))));
  const s = stamps.filter(x => x.tag.startsWith('p')).map(x => x.at);
  ok(s[1] - s[0] >= PARSE - TOL && s[2] - s[1] >= PARSE - TOL, `1 连续3次parse相邻间隔≥${PARSE}ms(实际 ${Math.round(s[1] - s[0])} ${Math.round(s[2] - s[1])})`);
  console.log('    [case1 elapsed]', Date.now() - t1, 'ms');

  // 2 parse 车道塞着两个,light 不等它们
  const enq2 = Date.now();
  await Promise.all([
    gap('parse').then(rel('parse', 'q-a')),
    gap('parse').then(rel('parse', 'q-b')),
    gap('light').then(rel('light', 'q-c')),
  ]);
  const lightAt = at('q-c'), parse2nd = at('q-b');
  ok(lightAt < parse2nd, `2 light(${Math.round(lightAt)}ms) 不等第二个 parse(${Math.round(parse2nd)}ms)`);
  ok(lightAt - (enq2 - t0) <= 3 * LIGHT + TOL, `2b light 约 ${LIGHT}ms 后放行(实际 ${Math.round(lightAt - (enq2 - t0))}ms)`);

  // 3 并发混发 parse/light 共 6 次:所有放行两两间隔 ≥ lightMs
  stamps.length = 0;
  await Promise.all([0, 1, 2, 3, 4, 5].map((i) => {
    const kind = i % 2 ? 'light' : 'parse';
    return gap(kind).then(rel(kind, 'm' + i));
  }));
  const sorted = stamps.slice().sort((a, b) => a.at - b.at);
  let minGap = Infinity;
  for (let i = 1; i < sorted.length; i++) minGap = Math.min(minGap, sorted[i].at - sorted[i - 1].at);
  ok(minGap >= LIGHT - TOL, `3 混发6次放行两两间隔≥${LIGHT}ms(最小 ${Math.round(minGap)}ms)`);

  // 4 冷却窗:parse 与 light 都不早于 coolUntil 放行
  stamps.length = 0;
  const cu = Date.now() + 200;
  _setGapForTest({ coolUntil: cu });
  await Promise.all([gap('parse').then(rel('parse', 'c-a')), gap('light').then(rel('light', 'c-b'))]);
  ok(at('c-a') >= cu - t0 - TOL && at('c-b') >= cu - t0 - TOL, `4 冷却窗内均不放行(最早放行 ${Math.round(Math.min(at('c-a'), at('c-b')))}ms,coolUntil=${cu - t0}ms)`);

  console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
