// 更新检测(GitHub Releases) + 一键更新(应用内下载 → SHA256 校验 → 退出后由助手脚本换文件并重启)
// 从 main.js 拆出:对外行为不变,主进程依赖(win/store/mouseLocked/ui/pushData)经 createUpdater 注入
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { netFetch } = require('./fetcher');

// ---------- 更新检测(GitHub Releases) ----------
// release 说明首行约定为「中文代号|寄语」,是版本代号/寄语的在线通道:复用 releases/latest
// 的既有响应解析,零新增请求;解析失败静默回退应用内 RELEASE_NOTES,不发版也能修订文案
function parseRelNotes(body) {
  const line = String(body || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  const m = line.match(/^([^|\n]{1,24})\|(.{1,200})$/);
  return m ? { code: m[1].trim(), quote: m[2].trim() } : null;
}
const verNums = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
function newerVer(a, b) { // a 是否比 b 新(三段数字逐段比)
  const x = verNums(a), y = verNums(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

function createUpdater({ getWin, getStore, ui, pushData, isMouseLocked }) {
  const { app, shell, dialog } = require('electron'); // 必须在工厂内惰性 require:裸 Node 测试/CI(--ignore-scripts 无 electron 二进制)require('electron') 会抛
  let lastUpdCheckAt = 0;
  // 仓库转公开前 API 会 404:状态置 unavailable,设置页如实显示"暂无法检测",不弹窗不打扰。
  // 弹窗策略:启动自动检测发现新版时每个版本只弹一次(updateSeen);手动检测只在设置页显示结果
  const UPD = { repo: 'likeravine233/RainyWatch', state: 'idle', version: '', url: '', canInstall: false, notes: null };
  // 一键更新状态机:idle→downloading→verifying→ready(重启生效)|error;进度走 push:upd-dl 专用通道,payload 只带快照
  const UPDDL = { phase: 'idle', received: 0, total: 0, msg: '' };
  const updDlPush = () => { const win = getWin(); if (win && !win.isDestroyed()) win.webContents.send('push:upd-dl', { ...UPDDL }); };
  async function ghGet(url) { // GitHub API 小助手:UA + net.fetch(自动解压,跟随系统代理);不走 fetcher 的 LP 限速队列,两套节奏互不干扰
    const res = await netFetch(url, { headers: { 'User-Agent': 'RainyWatch-Updater', 'Accept': 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    return { code: res.status, body: await res.text() };
  }
  async function checkUpdate(manual) {
    const store = getStore();
    lastUpdCheckAt = Date.now();
    if (!app.isPackaged && process.env.RW_UPD_DEMO) { // 审阅用钩子:伪造"有新版本",走与真实完全相同的展示路径;不发请求、不写 updateSeen。isPackaged 门控:防再次随版发布
      UPD.state = 'available'; UPD.version = '0.0.2'; UPD.url = `https://github.com/${UPD.repo}/releases`; UPD.canInstall = true;
      UPD.notes = { code: '惊蛰', quote: '微雨众卉新,一雷惊蛰始。' };
      pushData();
      if (!manual && process.env.RW_UPD_DEMO !== 'badge') showUpdate();
      if (manual) return { state: UPD.state, version: UPD.version, url: UPD.url };
      return;
    }
    try {
      const { code, body } = await ghGet(`https://api.github.com/repos/${UPD.repo}/releases/latest`);
      if (code === 404) { UPD.state = 'unavailable'; UPD.version = ''; UPD.url = ''; UPD.canInstall = false; UPD.notes = null; } // 仓库未公开/还没有 Release
      else if (code !== 200) throw new Error('HTTP ' + code);
      else {
        const rel = JSON.parse(body);
        const tag = String(rel.tag_name || '');
        UPD.notes = parseRelNotes(rel.body); // 可用与已最新两种状态都带上:latest 时它就是当前版的在线修订
        // 一键更新的前提:release 里挂着 SHA256SUMS.txt,且 portable 单文件 / win-x64 zip 至少一种在架
        const assets = Array.isArray(rel.assets) ? rel.assets : [];
        const hasSums = assets.some((a) => /^SHA256SUMS\.txt$/i.test(a.name));
        UPD.canInstall = hasSums && (assets.some((a) => /^RainyWatch-Portable\.exe$/i.test(a.name)) || assets.some((a) => /^RainyWatch-v[\d.]+-win-x64\.zip$/i.test(a.name)));
        if (tag && newerVer(tag, app.getVersion())) {
          UPD.state = 'available'; UPD.version = tag.replace(/^v/i, ''); UPD.url = rel.html_url || `https://github.com/${UPD.repo}/releases`;
          if (!manual && store.get('updateSeen') !== UPD.version) { store.set('updateSeen', UPD.version); showUpdate(); }
        } else { UPD.state = 'latest'; UPD.version = ''; UPD.url = ''; }
      }
    } catch { UPD.state = 'error'; UPD.version = ''; UPD.url = ''; UPD.canInstall = false; UPD.notes = null; } // 断网/限流:设置页如实显示,不打扰
    pushData();
    if (manual) return { state: UPD.state, version: UPD.version, url: UPD.url };
  }
  function showUpdate() { // 弹窗路由:窗口可见、未锁穿透、非迷你 → 应用内自绘弹窗(随主题换装,水月出镜);否则原生弹窗兜底(托盘隐藏/穿透锁定时自绘弹窗用户看不到也点不到)
    const win = getWin(), store = getStore();
    if (win && !win.isDestroyed() && win.isVisible() && !store.get('mini') && !isMouseLocked()) {
      win.webContents.send('push:upd-dialog', { version: UPD.version, url: UPD.url, canInstall: UPD.canInstall, notes: UPD.notes });
      return;
    }
    dialogShowUpdate();
  }

  // ---------- 一键更新:应用内下载 → SHA256 校验 → 退出后由助手脚本换文件并重启 ----------
  // 便携包无法在运行中覆盖自己:把新 exe 下到临时目录,校验通过后落一个 PowerShell 助手,
  // 它等本进程退出 → 拷贝覆盖原 exe → 重新拉起。仓库私有期间 release 拉不到,按钮自然不出现。
  async function ghDownload(url, dest, onProg) { // 下载 release 资产(net.fetch 自动跟随重定向);onProg(已收, 总长);15s 无新数据即中止
    const MAX = 220 * 1024 * 1024; // 便携包远小于此,防呆
    const ac = new AbortController();
    let idle = null;
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('timeout')), 15000); }; // 空闲超时:每到一块数据重新计 15s
    try {
      arm();
      const res = await netFetch(url, { headers: { 'User-Agent': 'RainyWatch-Updater' }, signal: ac.signal });
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || 0;
      if (total > MAX) throw new Error('size');
      const src = Readable.fromWeb(res.body);
      const f = fs.createWriteStream(dest);
      let got = 0;
      src.on('data', (c) => {
        got += c.length;
        arm();
        if (got > MAX) src.destroy(new Error('size')); // 声明长度缺失/撒谎时按实收兜底
        if (onProg) onProg(got, total);
      });
      src.pipe(f);
      try { await new Promise((ok, bad) => { f.on('finish', ok); f.on('error', bad); src.on('error', bad); }); }
      catch (e) { f.destroy(); throw e; }
      clearTimeout(idle);
      return got;
    } catch (e) {
      clearTimeout(idle);
      try { fs.rmSync(dest, { force: true }); } catch { } // 半成品不留
      throw e;
    }
  }
  async function updInstall() {
    if (UPDDL.phase === 'downloading' || UPDDL.phase === 'verifying') return { ...UPDDL }; // 已在进行,不重复下
    try {
      UPDDL.phase = 'downloading'; UPDDL.received = 0; UPDDL.total = 0; UPDDL.msg = ''; updDlPush();
      const { code, body } = await ghGet(`https://api.github.com/repos/${UPD.repo}/releases/latest`); // 现查一次,拿资产直链
      if (code !== 200) throw new Error('HTTP ' + code);
      const rel = JSON.parse(body);
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE; // 双轨:portable 换单文件,文件夹版换 zip,按运行形态取包
      const sumsA = assets.find((a) => /^SHA256SUMS\.txt$/i.test(a.name));
      const pkgA = isPortable
        ? assets.find((a) => /^RainyWatch-Portable\.exe$/i.test(a.name))
        : assets.find((a) => /^RainyWatch-v[\d.]+-win-x64\.zip$/i.test(a.name));
      if (!pkgA || !sumsA) throw new Error('no-asset');
      const tmp = path.join(app.getPath('temp'), 'RainyWatch-update');
      fs.mkdirSync(tmp, { recursive: true });
      const pkgPath = path.join(tmp, pkgA.name); // 名字经上方正则严格匹配,SHA 行匹配与解压都靠它
      const sumsPath = path.join(tmp, 'SHA256SUMS.txt');
      UPDDL.total = pkgA.size || 0;
      await ghDownload(pkgA.browser_download_url, pkgPath, (r, t) => { UPDDL.received = r; if (t) UPDDL.total = t; updDlPush(); });
      UPDDL.phase = 'verifying'; updDlPush();
      await ghDownload(sumsA.browser_download_url, sumsPath);
      const sumsLine = isPortable ? 'rainywatch-portable.exe' : '-win-x64.zip'; // SHA256SUMS.txt 双行,按形态取自己的行
      const line = fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/).find((l) => l.trim().toLowerCase().endsWith(sumsLine));
      const expect = line ? line.trim().split(/\s+/)[0].toLowerCase() : '';
      const got = crypto.createHash('sha256').update(fs.readFileSync(pkgPath)).digest('hex');
      if (!/^[0-9a-f]{64}$/.test(expect) || got !== expect) { try { fs.rmSync(pkgPath, { force: true }); } catch { } throw new Error('sha256'); }
      UPDDL.phase = 'ready'; UPDDL.msg = pkgPath; updDlPush();
    } catch (e) {
      UPDDL.phase = 'error'; UPDDL.msg = e.message; updDlPush();
    }
    return { ...UPDDL };
  }
  function updApplyRestart() { // 就绪后:落 PowerShell 助手(等本进程退出→覆盖/解压→重启),随后应用退出
    if (UPDDL.phase !== 'ready' || !UPDDL.msg || !fs.existsSync(UPDDL.msg)) return false;
    const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;
    const cur = isPortable ? process.env.PORTABLE_EXECUTABLE_FILE : process.execPath; // portable 下前者才是用户双击的那个 exe
    if (!app.isPackaged || !cur.toLowerCase().endsWith('.exe')) return false; // 开发态(electron.exe)不允许自换
    const tmp = path.join(app.getPath('temp'), 'RainyWatch-update');
    const ps = path.join(tmp, 'apply.ps1');
    const q = (s) => String(s).replace(/'/g, "''");
    const steps = [
      '$ErrorActionPreference = "Stop"',
      `Wait-Process -Id ${process.pid} -ErrorAction SilentlyContinue`,
      'Start-Sleep -Milliseconds 600', // 留足退出收尾,Windows 释放 exe 文件锁
    ];
    if (isPortable) steps.push(`Copy-Item -Force '${q(UPDDL.msg)}' '${q(cur)}'`);
    else steps.push(`& "$env:SystemRoot\\System32\\tar.exe" -xf '${q(UPDDL.msg)}' -C '${q(path.dirname(cur))}'`); // 文件夹版:zip 就地解压覆盖安装目录
    steps.push(
      `Start-Process -FilePath '${q(cur)}'`,
      `Remove-Item -Force '${q(ps)}'`,
    );
    fs.writeFileSync(ps, '\ufeff' + steps.join('\r\n'), 'utf8'); // BOM 让 Windows PowerShell 5.1 按 UTF-8 读中文路径
    const { spawn } = require('child_process');
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    app.quit();
    return true;
  }
  function dialogShowUpdate() { // 启动发现更新:一次温和的弹窗(去下载 / 用当前版继续)
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    dialog.showMessageBox(win, {
      type: 'info', title: ui('upd.dlg.title'), message: ui('upd.dlg.title'),
      detail: ui('upd.dlg.msg', { v: UPD.version }),
      buttons: [ui('upd.dlg.go'), ui('upd.dlg.later')], defaultId: 0, cancelId: 1, noLink: true,
    }).then((r) => { if (r.response === 0 && UPD.url) shell.openExternal(UPD.url); });
  }
  return { UPD, UPDDL, checkUpdate, updInstall, updApplyRestart, lastCheckAt: () => lastUpdCheckAt };
}

module.exports = { createUpdater, parseRelNotes, newerVer };
