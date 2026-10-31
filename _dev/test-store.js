// Store 持久化测试:node _dev/test-store.js(仿 test-supplement 先例,零依赖,全部在 os.tmpdir() 临时目录里跑)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../lib/store');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error('  ✗', name); } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-store-test-'));
try {
  // 1 set → flush:内容正确落盘,且不残留 .tmp
  const f1 = path.join(dir, 'cfg.json');
  const s1 = new Store(f1, { a: 1, b: 'x' });
  s1.set('a', 42);
  s1.set('c', [1, 2]);
  s1.flush();
  const written = JSON.parse(fs.readFileSync(f1, 'utf8'));
  ok(written.a === 42 && written.b === 'x' && Array.isArray(written.c) && written.c.length === 2, '1 set+flush 落盘内容正确(默认值合并)');
  ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), '2 落盘后无 .tmp 残留');
  ok(new Store(f1, { a: 0 }).get('a') === 42, '3 重开实例读回已存值');

  // 2 非法 JSON:构造时备份现场并按默认值起
  const f2 = path.join(dir, 'bad.json');
  fs.writeFileSync(f2, '{oops not json');
  const s2 = new Store(f2, { k: 'dft' });
  ok(s2.get('k') === 'dft', '4 损坏文件回退默认值');
  const corrupt = fs.readdirSync(dir).filter((n) => n.startsWith('bad.json.corrupt-'));
  ok(corrupt.length === 1, '5 生成 .corrupt- 备份文件');
  ok(corrupt.length === 1 && fs.readFileSync(path.join(dir, corrupt[0]), 'utf8') === '{oops not json', '6 坏内容原样保存在备份里');
  ok(!fs.existsSync(f2), '7 原坏文件已被改名移走');
  s2.set('k', 'new'); s2.flush(); // 备份后继续用:新文件正常写
  ok(JSON.parse(fs.readFileSync(f2, 'utf8')).k === 'new', '8 备份后实例可正常再写');

  // 3 文件不存在:默认值,不产生 corrupt
  const f3 = path.join(dir, 'missing.json');
  const s3 = new Store(f3, { m: 7 });
  ok(s3.get('m') === 7, '9 文件不存在用默认值');
  ok(!fs.readdirSync(dir).some((n) => n.startsWith('missing.json.corrupt-')), '10 不存在时不产生 corrupt 文件');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
}

console.log(`\n${fail ? '✗' : '✓'} ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
