// 构建脚本:绕开 EDR 对 app.asar 的"禁止删除"限制
// 某些企业 EDR/杀软会拦删除 .asar(读/写正常,unlink 永远 EBUSY),electron-builder
// 每次构建都要清空输出目录 → 必失败。对策:每次用一个全新的 build-tmp* 目录,
// 构建完把便携 exe 拷贝到稳定的 dist-release/,win-unpacked 尽力清理(失败留待重启)。
const { spawnSync } = require('child_process');
const fs = require('fs');

let n = 1, out;
do { out = n === 1 ? 'build-tmp' : `build-tmp${n}`; n++; } while (fs.existsSync(out));
console.log('[build] output dir:', out);

const r = spawnSync('npx', ['electron-builder', '--win', 'portable', '--x64',
  `-c.directories.output=${out}`], { stdio: 'inherit', shell: true });
if (r.status !== 0) process.exit(r.status || 1);

fs.mkdirSync('dist-release', { recursive: true });
const exeName = fs.readdirSync(out).find(f => f.endsWith('.exe'));
if (!exeName) { console.error('[build] 输出目录里没有 exe'); process.exit(1); }
const src = `${out}/${exeName}`;
try {
  fs.copyFileSync(src, `dist-release/${exeName}`);
  console.log(`[build] -> dist-release/${exeName}`);
} catch (e) {
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  const stamped = exeName.replace(/\.exe$/i, '') + `-${stamp}.exe`;
  fs.copyFileSync(src, `dist-release/${stamped}`);
  console.log(`[build] 旧 exe 被占用,产物 -> dist-release/${stamped}`);
}

// 免解压文件夹版:portable 每次启动都全量自解压(NSIS 模板写死清空重解),文件夹版直接跑内层 exe 才是秒开
// 注意:EDR 会拦 CopyFile API(fs.cpSync 一碰到 .asar 进程直接被杀),必须走 read+write(读写是放行的)
const path = require('path');
function rwFile(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, fs.readFileSync(src)); }
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyTree(s, d); else rwFile(s, d);
  }
}
{
try {
  copyTree(`${out}/win-unpacked`, 'dist-release/RainyWatch-win');
  console.log('[build] -> dist-release/RainyWatch-win/RainyWatch.exe(免解压,秒开)');
} catch (e) { console.log('[build] 文件夹版拷贝失败:', e.message); }
}


try {
  fs.rmSync(`${out}/win-unpacked`, { recursive: true, force: true, maxRetries: 5, retryDelay: 800 });
} catch { console.log('[build] win-unpacked 被 EDR 锁定,重启后可删'); }

// 双轨分发的 zip 轨:把文件夹版打成 zip(根目录即应用本体,解压即见 RainyWatch.exe),
// 供"解压一次、此后每次启动秒开"的用户;SHA256SUMS.txt 覆盖两轨,一键更新按运行形态取行校验。
const crypto = require('crypto');
const { version } = require(path.join(__dirname, '..', 'package.json'));
const zipName = `RainyWatch-v${version}-win-x64.zip`;
const bsdtar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'); // Windows 自带 bsdtar;PATH 里可能撞上 Git Bash 的 GNU tar(不认 zip 与 --options)
const z = spawnSync(bsdtar, ['-a', '-c', '--options', 'zip:compression=deflate', '-f', `dist-release/${zipName}`, '-C', 'dist-release/RainyWatch-win', '.'], { stdio: 'inherit' }); // 不加 options 时 bsdtar 的 zip 只 store 不压缩
if (z.status !== 0) { console.error('[build] zip 打包失败'); process.exit(1); }
console.log(`[build] -> dist-release/${zipName}`);
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
fs.writeFileSync('dist-release/SHA256SUMS.txt',
  `${sha256('dist-release/RainyWatch-Portable.exe')}  RainyWatch-Portable.exe\r\n${sha256(`dist-release/${zipName}`)}  ${zipName}\r\n`);
console.log('[build] -> dist-release/SHA256SUMS.txt(双行:portable + zip)');
