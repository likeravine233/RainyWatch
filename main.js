// RainyWatch(小暴雨助手)— Liquipedia/PandaScore CS2 赛况桌面小组件 · Electron 主进程
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, nativeTheme, Notification, shell, clipboard, desktopCapturer, screen, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { Store } = require('./lib/store');
const { fetchWikiPage, apiQuery, searchPlayers, searchPandaPlayers, lpCooldownUntil } = require('./lib/fetcher');
const { parseMatches, parseEventMaps, parseEvents, parseTransfers, parsePlayerTeam, parseTeamRoster, parseVrs, parseEventTier, parseEventDates, parseVrsStamp } = require('./lib/parser');
const { fetchPandaRunning, findForTeams, fetchPandaMatchList, matchKey, mergeFallback, supplementRecent } = require('./lib/live');
const { learnEvents, lookupEvent } = require('./lib/eventpool');
const { enrichFromMatches, enrichFromRankings, decorateMatches, capPool, learnAlias, loadAliasCanon, aliasCanon } = require('./lib/teampool');
const { isThirdPlace } = require('./src/phase'); // 决赛语境闩锁的季军赛豁免
const I18N = require('./src/i18n'); // 界面文案字典(托盘/通知随界面语言)

const isShot = process.argv.some(a => a.startsWith('--shot'));
const shotThemes = (process.argv.find(a => a.startsWith('--shot')) || '').split('=')[1] || 'clear,tactical,blue';
const useMock = process.argv.includes('--mock');

// 实测 26200 上 GPU 进程起不来(exit_code=1 反复重启,伴随 network service crashed):整窗退 SwiftShader,
// WebGL 光效全落到 CPU 上算——这就是光效烧 CPU 的根因。抢修梯队如下,按序试:每次只改一行,重启看
// 启动日志还有没有 "GPU process exited" / 调试面板 GPU 行是否从 disabled_software 变 enabled。
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 0) 沙箱豁免对某些驱动/安全软件反而是雷:先注释掉它试原始配置(部分机器仅此一步就好)
// app.commandLine.appendSwitch('disable-gpu-sandbox');
// 1) 换 ANGLE 后端绕开 D3D11 设备创建失败——D3D9 已验证能让 GPU 进程活(RTX 3060 Ti)。
//    但 D3D9 后端没有 DirectComposition 呈现路径,每帧渲染完回读拷贝上屏,CPU 依旧 15%;
//    而着色器缓存已清空,当初 D3D11 起不来很可能正是缓存损坏。先试回默认 D3D11(下一行保持注释):
// app.commandLine.appendSwitch('use-angle', 'd3d9');
// 1b) 若换回 D3D11 后又出现 GPU process exited:恢复上面这行(GPU 至少能跑),CPU 问题另治
// 2) 备选:走驱动原生 OpenGL ICD
// app.commandLine.appendSwitch('use-angle', 'gl');
// 3) 仍崩:GPU 代码搬进浏览器进程跑(不再有独立 GPU 进程可崩;若显卡设备本身起不来则仍回软件渲染)
// app.commandLine.appendSwitch('in-process-gpu');
// GPU 进程能起来时尽量走硬件光栅;起不来时本开关无害(由启动日志「GPU加速状态」与调试面板 GPU 行诊断)
app.commandLine.appendSwitch('enable-gpu-rasterization');
// 禁 Win 窗口遮挡判定:小部件被别的窗口盖住时 Chromium 会停掉合成,CSS 动画(进行中的起伏点)随之冻结
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 数据目录固定为既有名"CS Watch Lite":productName 已改名 RainyWatch,
// 不固定的话 Electron 会把 userData 切到 %APPDATA%/RainyWatch,既有配置/缓存全部"丢失"
app.setPath('userData', path.join(app.getPath('appData'), 'CS Watch Lite'));
if (isShot) { // 截图模式隔离 userData(临时目录):截图跑批与用户正在运行的实例互抢缓存会双双起不来,也不再有任何真实配置可见
  app.setPath('userData', path.join(app.getPath('temp'), 'cswatch-shot-profile'));
}

// ---------- 状态 ----------
let store, win = null, tray = null, quitting = false;
// 单实例:重复双击 exe(portable 自解压完)不再开第二份,直接唤起已有窗口
if (!app.requestSingleInstanceLock()) { app.quit(); }
else app.on('second-instance', () => { try { showWindow(); } catch { } });
let data = { matches: { live: [], upcoming: [], recent: [] }, events: { ongoing: [], upcoming: [] }, transfers: [], rankings: { bySlug: {}, byName: {}, updatedAt: 0 } };
const PARSE_VER = 2; // 解析器版本:parser 输出变更(如变阵一行拆多选手)就 +1;启动时版本不符的缓存整体作废并丢 etag 强制重抓
let meta = { updatedAt: 0, stale: false, err: '' };
// 各数据区首抓状态:pending=还没有任何数据且正在同步(渲染层显示"同步中"挂起态而非"暂无")
let syncPhase = { matches: 'pending', events: 'pending', transfers: 'pending', rankings: 'pending' };
let booting = false; // 引导(启动/手动刷新)进行中:手动刷新不并发重入
let preShotTheme = null, preShotMapPool = null; // 截图模式开始前的用户设置,结束后还原
let preShotStoreFile = null; // 截图模式开始前的 store 文件原文(will 级还原:演示数据一律不落盘)
let shotMapPool = null;      // mock 演示图序:仅内存(此前 store.set 曾把演示图序写进用户真实缓存)
let saveTimer = null;        // 窗口 bounds 防抖落盘定时器(截图还原前要取消)
let wanjiqi = null; // 玩机器直播间(斗鱼 6657)开播状态 { live, title };null=尚未探测到
// 斗鱼房间页内嵌 JSON 带 show_status(1=开播):每 5 分钟摸一次;标题不再是玩机器(房间易主/接口改版)时
// 保留旧状态不动,免得按钮误隐。玩机器不播所有比赛,主卡按钮只在开播时显示
async function pollWanjiqi() {
  try {
    const res = await fetch('https://www.douyu.com/6657', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    const html = await res.text();
    const seg = (html.split('show_status')[1] || '').slice(0, 40);
    const status = Number((seg.match(/:\s*(\d)/) || [])[1]);
    const nick = (html.split('nickname')[1] || '').slice(0, 60);
    if (!nick.includes('玩机器')) return;
    const next = { live: status === 1 };
    if (!wanjiqi || next.live !== wanjiqi.live) { wanjiqi = next; pushData(); }
    else wanjiqi = next;
  } catch { /* 探测失败保留现状,下一轮再试 */ }
}
setInterval(pollWanjiqi, 5 * 60e3);
pollWanjiqi();
let newTransferIds = [];
let miniBounds = null;

const DEFAULTS = {
  theme: 'clear',          // clear | tactical | blue | versus | crt | poster
  opacity: 1,              // 0.4 ~ 1 (基础透明度系数)
  onTop: true,
  mini: false,
  notifyTransfers: true,
  notifyPreMatch: true,    // 开赛前提醒
  preMatchMin: 10,         // 提前几分钟
  preMatchStarredOnly: true, // 仅提醒关注的比赛
  notifyResults: true,     // 赛果速报(会话内直播过的比赛结束)
  autostart: false,
  intervalMin: 3,          // 比赛刷新间隔(分钟)
  lowPower: false,         // 性能优先:关氛围动效 + 失焦暂停动画 + 取景玻璃降至 15fps
  visualFps: 0,            // 视觉帧率上限:0=不限制(动效按各自设计帧率);240/165/90/60/30=全局硬上限——任何模式(含灵活模式交互时)都不会超过它
  flexMode: false,         // 灵活模式:光标在窗口上时跑「视觉帧率上限」,离开窗口回落「保底帧率」;关闭则恒为上限
  idleFps: 30,             // 保底帧率(灵活模式开启时,光标离开窗口后的动效帧率),最低 15;实际不高于「视觉帧率上限」
  bounds: null,
  lastSeenTransferId: null,
  etagMatches: '', etagEvents: '', etagTransfers: '',
  mapPool: {},             // 赛事页弹层采到的 BP 图序:key=开赛时间戳ms,跨重启持久
  mapEtags: {},            // 事件页 ETag(304 条件请求,页面没变连正文都不下载)
  pandaToken: '',         // 可选:回合级实时比分增强
  twitchClientId: '',     // 可选:英文主播(Twitch)开播检测——用户自建应用凭证,仅存本机
  twitchSecret: '',       // 与 Client ID 配对;未配置时不检测英文主播,也绝不访问 Twitch
  dateFormat: 'smart',     // 日期显示:smart=今天/明天/周X;weekday=周几;date=具体日期
  upcomingTime: 'both',    // 列表开赛时间显示:start=只看时刻;cd=临近1小时换倒计时;both=临近时「倒计时·时刻」
  lang: 'zh',              // 赛事文本语言:zh=结构词翻译为中文;en=原文
  uiLang: 'zh',            // 界面语言:只管菜单/设置/按钮等界面文案;比赛内容语言看 lang
  fontScale: 3,            // 字号五档:1-5,内容文字乘 --fs(0.9-1.15)缩放;迷你条/标题栏不缩放
  timezone: '',            // 时间显示时区:''=本机(自动夏令时);IANA 名(如 Asia/Shanghai)=按该时区渲染全部时刻
  zhFont: 'noto',          // 中文字体:noto=思源黑体(默认);misans=MiSans;yahei=微软雅黑——已定稿思源,菜单保留供切换
  mapLang: 'zh',           // 地图名显示:zh=中文全称(国服译名);zhShort=中文简称(玩家惯称);en=英文原名
  mapStripMode: 'band',    // 主卡地图信息:band=图序带(前图·当前·下张);cur=只显示当前图(第N图·图名)
  roleLang: 'zh',          // 变阵角色/状态标注:zh=中文(教练/退役/替补);en=原文(Coach/Retired)
  eventNameMode: 'abbr',   // 赛事名显示:abbr=简称(去掉年份/位置等后缀);full=全称
  collapsedSections: {},   // 列表组折叠状态:{ 'upcoming': true, 'recent': false, ... }
  hideTaskbar: false,      // 不占任务栏图标(窗口从托盘唤回)
  deskPin: false,          // 图钉=钉在桌面:禁拖动/缩放,被 显示桌面/Win+D 收起后自动顶回;不占任务栏,壁纸引擎之上
  glassBlur: 28,           // 取景玻璃模糊半径(px,8~48)
  sizePreset: 'm',         // 尺寸预设:mini/s/m/l(布局随窗口实际大小自动分级)
  starPlayers: [],         // [{id, name, href, team, teamSlug, resolvedAt}]
  starTeams: [],           // [{id, name, href}]
  playerCache: {},         // 搜过的选手档案 {title小写: {title,slug,href,team,...,cachedAt}}(LRU≤100):重复搜索零网络,只随显式搜索/关注解析更新
  captureGlass: true,      // 取景玻璃:抓取窗口背后的桌面画面,渲染层自绘真高斯模糊+边缘折射
};

// Win11 22H2+ 支持 acrylic 背景
const osBuild = parseInt(os.release().split('.')[2] || '0', 10);
const acrylicSupported = process.platform === 'win32' && osBuild >= 22621;
const glassTheme = () => ['frost', 'liquid'].includes(store.get('theme'));
// DWM 系统背板 acrylic:仅 frost 且未开启取景玻璃时使用(液态主题的折射需要自绘)
const acrylic = () => store.get('theme') === 'frost' && acrylicSupported && !captureGlassOn();
// 取景玻璃:透明窗口 + desktopCapturer 抓取窗口后方真实桌面像素(不依赖 DWM 背板,Win10 也可用)
const captureGlassOn = () => process.platform === 'win32' && glassTheme() && store.get('captureGlass') !== false;
// frost/liquid 且未开取景玻璃:走"不透明窗口 + DWM 系统背板"。Win11 24H2 起系统移除了 accent acrylic,
// 系统背板(acrylic/mica)是取景玻璃之外唯一的 OS 模糊;但它要求窗口非 transparent(透明窗口上不渲染)。
const wantsOsBackdrop = () => process.platform === 'win32' && acrylicSupported && glassTheme() && !captureGlassOn();
// 窗口透明档位:os=不透明窗+DWM 系统背板(frost/liquid 且无取景玻璃);plain=透明窗(其余一律)。
// Electron 的 transparent 是创建期属性:只有跨档位的切换才需要重建窗口,档位内换主题原生侧可实时重挂
const transMode = () => (wantsOsBackdrop() ? 'os' : 'plain');

// ---------- 数据抓取与调度 ----------
function notifyNewTransfers() {
  if (!store.get('notifyTransfers') || !newTransferIds.length || !app.isReady()) return;
  const fresh = (data.transfers || []).filter(t => newTransferIds.includes(t.id)).slice(0, 2);
  for (const t of fresh) {
    const arrow = t.direction === 'in' ? ui('ntf.in') : t.direction === 'out' ? ui('ntf.out') : ui('ntf.adj');
    const team = t.direction === 'out' ? t.oldTeam : t.newTeam;
    const body = `${t.player} ${arrow} ${team || ui('ntf.free')}${t.note ? ' (' + t.note + ')' : ''}`;
    const n = new Notification({ title: ui('ntf.transfer'), body, icon: path.join(__dirname, 'assets', 'icon.png'), silent: true });
    n.on('click', () => { showWindow(); });
    n.show();
  }
}

// ---------- 高光选手 / 关注队伍 ----------
const slugOf = (href) => decodeURIComponent(String(href || '').replace(/^.*\/counterstrike\//, '').replace(/[?#].*$/, ''));

// 某队(比赛侧)命中的关注项:关注队伍 + 高光选手的当前队伍
// 队伍名归一:去 team/clan/esports 等前缀词与非字母数字,让 PandaScore 队名(slug 无下划线)能对上 Liquipedia 页面 slug
const normTeam = (s) => String(s || '').toLowerCase()
  .replace(/\b(team|clan|esports|e-?sports|gaming|club|the)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

function sideStars(teamName, teamHref) {
  const out = [];
  const slug = String(teamHref || '').replace(/^.*\/counterstrike\//, '').replace(/[?#].*$/, '').toLowerCase();
  const slugN = normTeam(slug);
  for (const t of store.get('starTeams') || []) {
    if ((t.id || '').toLowerCase() === slug || (teamName && (t.name || '').toLowerCase() === String(teamName).toLowerCase())) {
      out.push({ type: 'team', name: t.name });
    }
  }
  for (const p of store.get('starPlayers') || []) {
    if (p.status === 'retired') continue; // 退役:不出现;下放保留可见性(通知里列名字,是否在阵由界面标注表达)
    // PandaScore 的 teamSlug(如 natus-vincere-cs-go)与比赛侧 Liquipedia slug(Natus_Vincere)字面不等,
    // 剥掉 -cs-go 后缀再做队名归一;NAVI 这类"LP 显示缩写、Panda 存全名"的队靠它才置顶
    const ps = p.teamSlug ? normTeam(String(p.teamSlug).replace(/[-_ ]*cs[-_ ]*go$/i, '')) : '';
    if (ps && slugN && ps === slugN) out.push({ type: 'player', name: p.name });
    else if (p.panda && p.team && teamName && normTeam(p.team) === normTeam(teamName)) out.push({ type: 'player', name: p.name });
  }
  return out;
}

function pushSettings() {
  if (win && !win.isDestroyed()) win.webContents.send('push:settings', store.all());
}

// 选手缓存入库(LRU≤100,按 cachedAt 淘汰):来源=显式搜索结果与关注解析产物。
// 不产生任何后台网络任务——增量只随"再搜索"与"已关注的 24h 复核"自然发生,不碰限流
function cacheUpsertPlayer(rec) {
  const key = String(rec.title || '').toLowerCase();
  if (!key) return;
  const c = store.get('playerCache') || {};
  c[key] = { ...(c[key] || {}), ...rec, cachedAt: Date.now() };
  const keys = Object.keys(c);
  if (keys.length > 100) {
    keys.sort((a, b) => (c[a].cachedAt || 0) - (c[b].cachedAt || 0));
    for (const k of keys.slice(0, keys.length - 100)) delete c[k];
  }
  store.set('playerCache', c);
}

async function resolvePlayer(entry) {
  entry.resolving = true; // 周期复核也亮同步态(短暂)
  try {
    // panda 形态的 id 是 PandaScore slug(如 w0nderfu1),不保证是 LP 页面名(LP 页叫 W0nderful):
    // 先用 opensearch 按名字校正页面标题(轻量接口,2s 队列),成功后缓存进 lpTitle 复用。
    // LP 来源(搜索回退/变阵行)的 id 本就是合法页名,无需校正
    let title = entry.lpTitle || entry.id;
    if (!entry.lpTitle && entry.panda) {
      const hits = await searchPlayers(entry.name || entry.id).catch(() => null);
      if (!hits) throw new Error('LP 搜索不可用(冷却/网络)'); // 搜索都失败就不再补一刀 parse,不放大限流压力
      const nm = normTeam(entry.name || entry.id);
      const hit = hits.length ? (hits.find(h => normTeam(h.title) === nm) || hits[0]) : null;
      // 命中→用页名;未命中且 id 带 UUID 后缀(Panda 同名消歧 slug)必非 LP 页名,不盲抓注定失败的 parse
      if (hit) title = hit.title;
      else if (/-[0-9a-f]{8}-[0-9a-f]{4}-/i.test(entry.id)) throw new Error('LP 页面标题未解析');
    }
    const r = await fetchWikiPage(title);
    entry.lpTitle = title;
    const team = parsePlayerTeam(r.html);
    if (team) {
      // Team 行在(含自由球员空链接)才覆写队伍;panda 关注的队伍来自 PandaScore,LP 缺行不抹掉
      if (team.name) { entry.team = team.name; entry.teamSlug = team.href ? slugOf(team.href) : ''; }
      entry.status = team.status || '';
      entry.err = '';
      // 队伍页 roster 分区才是"下放"的判据——选手页 Status 表达职业生涯状态,下放不离队的选手照样 Active
      // (oSee 实测:选手页 Active,队伍页 7/9 起在预备名单)。结果记 entry.roster 供诊断;
      // active→active,inactive/former→按 inactive 抑制在阵,认不出回落选手页状态
      if (entry.teamSlug) {
        try {
          const tp = await fetchWikiPage(entry.teamSlug);
          const r = parseTeamRoster(tp.html, title); // {zone, role} | null:zone=active/inactive/former/coach,role=coach/sub
          if (r && r.zone) { entry.roster = r.zone; if (r.role) entry.rosterRole = r.role; }
          entry.status = (r && (r.zone === 'active' || r.zone === 'coach')) ? 'active' : (r && r.zone) ? 'inactive' : entry.status;
        } catch (e2) { entry.err = 'roster: ' + String(e2.message || e2); } // roster 是关键信号,失败走 6h 重试
      }
    } else if (!entry.panda) { entry.team = ''; entry.teamSlug = ''; entry.status = ''; entry.err = ''; }
    entry.resolvedAt = Date.now();
  } catch (e) {
    entry.err = String(e.message || e);
    entry.resolvedAt = Date.now();
  }
  entry.resolving = false; // 完成/失败都落位:此后才允许显示"未解析到队伍/解析失败"等终态
  if (entry.name) cacheUpsertPlayer({ title: entry.name, slug: entry.lpTitle || entry.id, href: entry.href || '', team: entry.team || '', teamSlug: entry.teamSlug || '', panda: !!entry.panda, status: entry.status || '', rosterRole: entry.rosterRole || '' }); // 关注解析产物镜像进缓存:队伍/状态随 24h 复核自然增量
  store.set('starPlayers', store.get('starPlayers')); // 持久化引用修改
  pushSettings();
  checkReminders();
}

// 启动时补解析关注选手:队伍未知/上次出错 6h 重试;正常条目 24h 复核一次——
// 下放(被下放但不离队)与转会都只落在选手页的 Team/Status 行上,不定期复核就永远学不到
async function refreshStarsIfNeeded() {
  const list = store.get('starPlayers') || [];
  for (const p of list) {
    const age = Date.now() - (p.resolvedAt || 0);
    if ((!p.team || p.err) && age > 6 * 3600e3) await resolvePlayer(p);
    else if (p.status === undefined) await resolvePlayer(p); // 补丁前入场的存量条目:一次性补拉状态(每个条目只发生一次)
    else if (age > 24 * 3600e3) await resolvePlayer(p);
  }
}

// ---------- 开赛提醒 / 赛果速报 ----------
let notifiedPre = new Set();
let prevLiveIds = new Set();
let cachedUpdatedAt = 0;   // 缓存里上次同步时间(重启后推算结束时刻用)
let sessionPolled = false; // 本会话是否已实际轮询过(区分"在场观测"与"重启后发现")

function loadTrackState() {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    notifiedPre = new Set(c.notifiedPre || []);
    prevLiveIds = new Set(c.prevLive || []);
    cachedUpdatedAt = c.meta?.updatedAt || 0;
  } catch { }
}
function saveTrackState() {
  try {
    fs.writeFileSync(cacheFile(), JSON.stringify({
      data, meta, pver: PARSE_VER, notifiedPre: [...notifiedPre].slice(-200), prevLive: [...prevLiveIds].slice(-200),
    }));
  } catch { }
}

function checkReminders() {
  if (!store.get('notifyPreMatch') || !Notification.isSupported()) return;
  const onlyStarred = store.get('preMatchStarredOnly') !== false;
  const min = Math.max(1, store.get('preMatchMin') || 10) * 60e3;
  const now = Date.now();
  for (const m of data.matches?.upcoming || []) {
    const starA = sideStars(m.teamA.name, m.teamA.href);
    const starB = sideStars(m.teamB.name, m.teamB.href);
    if (onlyStarred && !starA.length && !starB.length) continue;
    const dt = m.ts - now;
    if (dt > 0 && dt <= min && !notifiedPre.has(m.id)) {
      notifiedPre.add(m.id);
      const starHint = starA.length + starB.length ? ` ★${[...starA, ...starB].map(s => s.name).join('/')}` : '';
      const n = new Notification({
        title: ui('ntf.prematch'),
        body: `${m.teamA.name} vs ${m.teamB.name}${starHint} · ${m.event}${m.format ? ' (' + m.format + ')' : ''}`,
        icon: path.join(__dirname, 'assets', 'icon.png'), silent: true,
      });
      n.on('click', () => showWindow());
      n.show();
      saveTrackState();
    }
  }
}

// 直播 -> 结束 的转变检测:推送赛果 + 记录结束时刻(列表里显示"N小时前结束")
function trackMatchTransitions() {
  const cur = new Set((data.matches?.live || []).map(m => m.id));
  // 结束时刻:app 在场观测到转变 = 精确;重启后从缓存发现 = 近似(以缓存同步时间为准)
  const endedMap = store.get('endedAt') || {};
  for (const id of prevLiveIds) {
    if (cur.has(id) || endedMap[id]) continue;
    const fin = (data.matches?.recent || []).find(x => x.id === id);
    if (!fin || !fin.score) continue;
    const real = realEnded.get(id);
    endedMap[id] = real ? { ts: real } // 核实过的场次用真实结束时刻,别盖成"发现时刻"
      : sessionPolled
      ? { ts: Date.now() }
      : { ts: cachedUpdatedAt || Date.now(), approx: true };
  }
  // 只保留当前 recent 引用的条目,防止无限增长
  const keep = new Set((data.matches?.recent || []).map(m => m.id));
  for (const id of Object.keys(endedMap)) if (!keep.has(id)) delete endedMap[id];
  for (const id of [...realEnded.keys()]) if (!keep.has(id)) realEnded.delete(id);
  for (const m of data.matches?.recent || []) {
    const real = realEnded.get(m.id); // LP 的 recent 行是重新解析的对象,核实值每次都覆盖,修掉历史误盖的"发现时刻"
    const e = real ? { ts: real } : endedMap[m.id];
    if (e) { m.endedAt = e.ts; m.endedApprox = real ? false : !!e.approx; }
  }
  store.set('endedAt', endedMap);
  if (store.get('notifyResults') && Notification.isSupported()) {
    for (const id of prevLiveIds) {
      if (cur.has(id)) continue;
      const fin = (data.matches?.recent || []).find(x => x.id === id);
      if (!fin || !fin.score) continue;
      const n = new Notification({
        title: ui('ntf.result'),
        body: `${fin.teamA.name} ${fin.score[0]}:${fin.score[1]} ${fin.teamB.name} · ${fin.event}`,
        icon: path.join(__dirname, 'assets', 'icon.png'), silent: true,
      });
      n.on('click', () => showWindow());
      n.show();
    }
  }
  prevLiveIds = cur;
  sessionPolled = true;
  saveTrackState();
}

// Liquipedia 被限流时的比赛列表兜底:PandaScore 拉基础字段;限流解除后下一次成功抓取自动覆盖切回
async function pandaMatchesFallback(reason) {
  const token = store.get('pandaToken');
  if (!token) return;
  try {
    const list = await fetchPandaMatchList(token);
    if (!list) return;
    data.matches = mergeFallback(list, data.matches); // 合并而非整表替换:LP 慢变元数据(阶段/评级链/图标/直播流)在限流窗口内继续存活
    meta = { updatedAt: Date.now(), stale: true, err: `Liquipedia 限流(${reason});比赛列表来自 PandaScore 兜底,恢复后自动切回` };
    trackMatchTransitions();
    checkReminders();
    saveCache();
    pushData();
    console.log('[panda-fallback] matches list from PandaScore');
  } catch (e2) {
    console.error('[panda-fallback]', e2.message);
  }
}

// 启动审计:赛果行的结束时刻来自“发现结束”打点,可能早于本功能上线时被误盖;
// 用 PandaScore 全量列表核实一遍,能对上号的行用真实结束时刻覆盖(显示与存储一起修)
let recentAudited = false;
async function auditRecentEnded() {
  const token = store.get('pandaToken');
  const rec = data.matches?.recent || [];
  if (!token || !rec.length) return;
  try {
    const list = await fetchPandaMatchList(token);
    if (!list || !Array.isArray(list.recent)) return;
    const endedMap = store.get('endedAt') || {};
    let hit = false;
    for (const m of rec) {
      const key = matchKey(m.teamA?.name, m.teamB?.name);
      const fin = list.recent.find((r) => {
        const near = !m.ts || !r.ts || Math.abs(r.ts - m.ts) <= 30 * 60e3;
        return (matchKey(r.teamA?.name, r.teamB?.name) === key
          || (near && fuzzyPair(m.teamA?.name, m.teamB?.name, r.teamA?.name, r.teamB?.name)))
          && (r.endedAt || r.ts || 0) > (m.ts || 0) - 3600e3
          && (r.endedAt || r.ts || 0) > Date.now() - 12 * 3600e3;
      });
      if (!fin?.endedAt) continue;
      realEnded.set(m.id, fin.endedAt);
      endedMap[m.id] = { ts: fin.endedAt };
      m.endedAt = fin.endedAt; m.endedApprox = false;
      hit = true;
    }
    if (hit) { store.set('endedAt', endedMap); pushData(); }
  } catch { /* 限流/token 失效:保留现有时间戳,下次启动再修 */ }
}

// LP 主页 Results 区块容量有限,部分已结束场次不被收录:用 PandaScore past 列表补齐 recent 缺口。
// 判重见 lib/live.js isSameMatch(队伍对 + ≤6h 时间窗),LP 行永远优先、只增不删。
// 补位行必须每轮重套用:LP 解析会整表替换 recent,只在会话开头补一次的话,
// 补位行随下一轮替换蒸发(NAVI vs Aurora 实例)——补位源列表存 store('pandaSupplement'),
// 每轮 LP 解析后无网络开销地重套用;48h 窗外的旧行不再回填
function reappliedSupplement(recent) {
  const saved = (store.get('pandaSupplement') || []).filter((r) => (r.endedAt || r.ts || 0) > Date.now() - 48 * 3600e3);
  return supplementRecent(recent, saved);
}

// 赛事池装饰:Panda 系行(补位/兜底,特征是无 eventHref)反查池子换上 LP 赛事名/页链/图标,
// 评级徽章(tierOf 走 eventHref)随之恢复;LP 行原样跳过。幂等,payload() 每次组装都跑;
// 缓存与 pandaSupplement 存档里始终是原始 Panda 名,装饰只发生在下发管线,信息不丢
function decorateEvents() {
  const pool = store.get('eventPool');
  if (!pool || !Object.keys(pool).length) return;
  for (const k of ['live', 'upcoming', 'recent']) {
    for (const m of (data.matches?.[k] || [])) {
      if (m.eventHref || !m.event) continue;
      const e = lookupEvent(m.event, pool);
      if (!e) continue;
      if (e.name) m.event = e.name;
      m.eventHref = e.href || '';
      m.eventIcon = e.icon || '';
    }
  }
}
let recentSupplemented = false;
async function supplementRecentFromPanda() {
  const token = store.get('pandaToken');
  if (!token) return;
  try {
    const list = await fetchPandaMatchList(token);
    if (!list) return;
    store.set('pandaSupplement', list.recent || []); // 补位源持久化,供本轮之后的所有 LP 解析重套用
    { // 赛事池学习:Panda 行与 LP 现表同场配对,记「Panda 赛事名 → LP 赛事名/页链/图标」
      const pool = store.get('eventPool') || {};
      if (learnEvents(list, data.matches, pool)) store.set('eventPool', pool);
    }
    const before = (data.matches?.recent || []).length;
    data.matches.recent = reappliedSupplement(data.matches?.recent || []);
    const added = data.matches.recent.length - before;
    if (added > 0) {
      saveCache(); pushData();
      console.log(`[panda-supplement] recent 补充 ${added} 场(LP 未收录):`, data.matches.recent.filter((m) => m.panda).map((m) => `${m.teamA.name} vs ${m.teamB.name}`).join(' ; '));
    }
  } catch (e) { console.error('[panda-supplement]', e.message); }
}

function kindNonEmpty(kind) {
  if (kind === 'matches') return ((data.matches?.live?.length || 0) + (data.matches?.upcoming?.length || 0) + (data.matches?.recent?.length || 0)) > 0;
  if (kind === 'events') return ((data.events?.ongoing?.length || 0) + (data.events?.upcoming?.length || 0)) > 0;
  if (kind === 'transfers') return (data.transfers?.length || 0) > 0;
  return Object.keys(data.rankings?.bySlug || {}).length > 0;
}

// ---------- 赛事评级归档(完赛掉榜续用) ----------
// 完赛赛事会从 LP 首页 ongoing 列表掉出,tierOf 查不到 → 赛果行/主卡的评级徽标消失(裂变天地实例)。
// 归档:在榜期间持续收录 slug→(级别,最后见到时间);掉榜后按级别保留——S=永久,A=30天,B=15天,C及以下=7天。
// 存档落用户 store(data 换表/缓存整包替换都会丢引用),data.tierArchive 随 payload 下发,渲染层 tierOf 回退查这里。
const TIER_TTL = { S: Infinity, A: 30 * 864e5, B: 15 * 864e5, C: 7 * 864e5 };
function tierArchiveLoad() { // 任何 data 换表(缓存恢复/mock 注入)后调用:挂回存档并剪枝
  if (!data.tierArchive || typeof data.tierArchive !== 'object') data.tierArchive = store.get('tierArchive') || {};
  const arc = data.tierArchive, now = Date.now();
  let n = 0;
  for (const k of Object.keys(arc)) {
    const e = arc[k], ttl = TIER_TTL[e?.t] ?? TIER_TTL.C;
    if (!(now - e?.ts <= ttl)) { delete arc[k]; n++; } // Infinity 恒不过期;缺 ts/NaN 视为坏行清除
  }
  if (n) store.set('tierArchive', arc);
}
function tierArchiveHarvest() { // events 每轮解析后调用:在榜赛事收录/续期(保留期从掉榜那天起算),顺带补全名称/图标
  const arc = data.tierArchive || (data.tierArchive = {});
  let n = 0;
  for (const e of [...(data.events?.ongoing || []), ...(data.events?.upcoming || [])]) {
    if (!e?.tier || !e?.href) continue;
    const slug = slugOf(e.href).toLowerCase();
    if (!slug) continue;
    const hit = arc[slug];
    const extra = { name: e.name, icon: e.icon, dates: e.dates, page: slugOf(e.href) }; // page 存原始大小写:LP 页名除首字母外大小写敏感,全小写键直接抓会 missingtitle
    if (hit && hit.t === e.tier) { Object.assign(hit, extra, { ts: Date.now() }); n++; continue; } // 旧条目缺 name/icon 也在此补全
    arc[slug] = { ...extra, t: e.tier, ts: Date.now() };
    n++;
  }
  if (n) store.set('tierArchive', arc);
}
function tierArchivePut(slug, tier, extra) { // 单条入档(掉榜回填用):extra 带 name/icon/page 供"最近完赛"成行;保留期从入档时刻起算
  if (!slug) return;
  const arc = data.tierArchive || (data.tierArchive = {});
  const old = arc[slug] || {};
  if (!tier && !old.t) return; // 页面无评级标注且档里也没有:无从定级,不入档
  arc[slug] = { ...old, ...extra, t: tier || old.t, ts: Date.now() };
  store.set('tierArchive', arc);
}
// 掉榜即记终点:在榜→从 LP 列表消失,赛事大概率刚完赛,掉榜时刻记为结束时间(误差≤一个同步间隔)。
// 诚实性护栏:距"最后见到"超过 3 天才掉榜(中间关过应用)不冒充;距开赛超过 30 天的"结束"视为停办/解析抖动,不记。
function markEventEnds(prevOngoing) {
  if (!prevOngoing.length) return;
  const arc = data.tierArchive || (data.tierArchive = {});
  const alive = new Set([...(data.events?.ongoing || []), ...(data.events?.upcoming || [])].map((e) => slugOf(e.href).toLowerCase()));
  const now = Date.now();
  let n = 0;
  for (const slug of prevOngoing) {
    const hit = arc[slug];
    if (alive.has(slug)) { if (hit && hit.droppedAt) { delete hit.droppedAt; n++; } continue; } // 回榜:撤销掉榜计时
    if (!hit || hit.end) continue;
    if (hit.d2 && now < hit.d2) continue; // 信息框日期段没走完:掉榜只是阶段间歇(小组赛完、淘汰赛未开),不算完赛
    if (now - (hit.ts || 0) > 3 * 864e5) continue;
    if (hit.start && now - hit.start > 30 * 864e5) continue;
    if (!hit.droppedAt) { hit.droppedAt = now; n++; continue; } // 首次掉榜:先挂 48h 宽限,不急着记 end
    if (now - hit.droppedAt < 48 * 36e5) continue; // 宽限期内:给阶段间歇留回榜窗口
    hit.end = hit.droppedAt; delete hit.droppedAt; n++; // 宽限后仍未回榜:按掉榜时刻记完赛
  }
  if (n) store.set('tierArchive', arc);
}
// 赛果档案:LP 首页每轮只给 48h 内的 6 条完赛,过了就永远消失。这里落本地 store:
// 默认留 7 天(等评级补全后还有机会升级进列表),S 级留 45 天(用户要求 S 级赛果长久保存)。
function matchArchiveLoad() { // 任何 data 换表(缓存恢复/mock 注入)后由 payload 兜底挂回
  if (!data.matchArchive || typeof data.matchArchive !== 'object') data.matchArchive = store.get('matchArchive') || {};
}
function harvestMatchArchive(recent) { // matches 每轮解析后调用:入档 + 顺带把最早开赛时间回写赛事归档(逐场取 min,比回填单场更准)
  matchArchiveLoad();
  const arc = data.tierArchive || (data.tierArchive = {});
  const ma = data.matchArchive;
  let arcN = 0;
  for (const m of recent) {
    if (!m?.id) continue;
    const slug = slugOf(m.eventHref).toLowerCase();
    ma[m.id] = { m, slug, ts: m.ts || 0 };
    const hit = slug && arc[slug];
    if (hit && m.ts && (!hit.start || m.ts < hit.start)) { hit.start = m.ts; arcN++; }
    if (hit && !hit.page && m.eventHref) { hit.page = slugOf(m.eventHref); arcN++; } // 存量补 page:掉榜条目只有拿到原始大小写页名,回填才够得着
  }
  const now = Date.now();
  for (const [id, e] of Object.entries(ma)) {
    const isS = e.slug && arc[e.slug]?.t === 'S';
    if (now - e.ts > (isS ? 45 : 7) * 864e5) delete ma[id];
  }
  if (Object.keys(ma).length > 80) { // 兜底上限:异常刷量也不让 store 无界膨胀
    const keep = Object.values(ma).sort((a, b) => b.ts - a.ts).slice(0, 80);
    data.matchArchive = {}; for (const e of keep) data.matchArchive[e.m.id] = e;
  }
  store.set('matchArchive', data.matchArchive);
  if (arcN) store.set('tierArchive', arc);
}
function mergeMatchArchive(freshRecent) { // 48h 窗口外的 S 级赛果从档案并回列表,按时间倒序混排(上限 15 条,超出由分区内滚消化)
  matchArchiveLoad();
  const arc = data.tierArchive || {};
  const have = new Set(freshRecent.map((m) => m.id));
  const olds = Object.values(data.matchArchive)
    .filter((e) => e.m?.id && !have.has(e.m.id) && e.m.status === 'finished' && e.slug && arc[e.slug]?.t === 'S')
    .map((e) => e.m);
  return [...freshRecent, ...olds].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 15);
}
// 掉榜赛事评级回填:归档只能从"在榜"起算,早已完赛掉榜的赛事(如刚收官的联赛)永远补不进来。
// 从最近赛果(48h)里找评级缺失的赛事页,每拍最多补 1 页(走全局 30s 队列),解析信息框的
// Liquipedia tier 入档;单页 24h 只试一次(失败次日再试),入档成功后 slug 在档、天然不再重试
let lastTierBackfillAt = 0;
async function tierBackfill() {
  if (lpCooldownUntil() > Date.now()) return; // LP 冷却(429)期不添乱
  const now = Date.now();
  if (now - lastTierBackfillAt < 35e3) return; // 与图序采集同拍节流
  lastTierBackfillAt = now;
  const arc = data.tierArchive || (data.tierArchive = {});
  const candByPage = new Map(); // page → { slug, name, icon }:名称/图标取自赛果行的赛事字段,"最近完赛"直接成行
  for (const m of data.matches?.recent || []) {
    if (!m.eventHref) continue;
    const slug = slugOf(m.eventHref).toLowerCase();
    if (!slug || (arc[slug] && arc[slug].name && arc[slug].icon && (arc[slug].d1 || arc[slug].dates))) continue; // 名称/图标/日期段齐全的跳过;缺其中任何一项的旧条目重采一次补全
    const page = slugOf(m.eventHref); // abs() 产出的是完整 URL,api.php 要的是 counterstrike/ 之后的页面名(slugOf 顺带剥锚点+解码);拼整条 URL 会 missingtitle
    if (!page) continue;
    const prev = candByPage.get(page);
    if (prev) { if (m.ts && (!prev.start || m.ts < prev.start)) prev.start = m.ts; continue; } // 同赛事多场:记最早开赛时间
    candByPage.set(page, { slug, name: m.event, icon: m.eventIcon, start: m.ts || 0, page });
  }
  for (const [slug, a] of Object.entries(arc)) { // 档案存量:还在保留期、缺日期段的排队补采——d2 才是"已完赛"的判定依据
    if (!slug || a.d1 || a.dates || !a.page || !a.name) continue;
    if (candByPage.has(a.page)) continue;
    candByPage.set(a.page, { slug, name: a.name, icon: a.icon || '', start: 0, page: a.page });
  }
  if (!candByPage.size) { // 候选清空=回填收工:熄掉列表页的"回填中"提示
    if (data.tierBackfillPending) { data.tierBackfillPending = false; pushData(); }
    return;
  }
  const retry = store.get('tierRetry2') || {}; // v2:改键清零——旧键里的 24h 封锁会挡住名称/图标补全的重采
  const page = [...candByPage.keys()].find((p) => now - (retry[p] || 0) > 24 * 3600e3);
  if (!page) return; // 都在 24h 冷却期:无可推进,不亮提示
  if (!data.tierBackfillPending) { data.tierBackfillPending = true; pushData(); } // 亮"回填中":每拍最多采一页,期间完赛分区挂提示
  retry[page] = now; store.set('tierRetry2', retry);
  try {
    const r = await fetchWikiPage(page); // 一次性回填,采完即走:无需 ETag 条件请求
    const tier = parseEventTier(r.html || '');
    const dates = parseEventDates(r.html || ''); // 信息框 Dates:赛事真正起止(日级);48h 窗口里"最早一场"只是决赛尾巴,冒充不得
    console.log('[tier-backfill]', page, '->', tier || '(页面无评级标注)', dates ? `${new Date(dates.d1).toDateString()} ~ ${new Date(dates.d2).toDateString()}` : '(无日期段)');
    const cand = candByPage.get(page);
    if ((tier || dates) && cand) { // 只采到日期(无评级)也要入档:d2 是"已完赛"判定的正主
      tierArchivePut(cand.slug, tier, { name: cand.name, icon: cand.icon, start: cand.start, page: cand.page, ...(dates || {}) });
      saveCache(); pushData(); // 徽标立即回显,不等下一轮
    }
  } catch { retry[page] = Date.now() - 23 * 3600e3; store.set('tierRetry2', retry); } // 抓取失败(多为 LP 限流):1h 后即可再试,不占 24h 整档
}

async function fetchKind(kind) {
  // 冷却期内完全静默:Liquipedia 政策是"封禁期间继续请求会延长封禁",重试只会让 IP 等不到解封。
  // matches 走 Panda 兜底;events/transfers/rankings 保持旧数据,冷却结束(封禁解除)后自然重试
  if (lpCooldownUntil() > Date.now()) {
    if (kind === 'matches') await pandaMatchesFallback('Liquipedia 冷却中');
    return;
  }
  try {
    const map = {
      matches: { page: 'Liquipedia:Matches', etagKey: 'etagMatches' },
      events: { page: 'Main_Page', etagKey: 'etagEvents' },
      transfers: { page: 'Portal:Transfers', etagKey: 'etagTransfers' },
      rankings: { page: 'Valve Regional Standings', etagKey: 'etagVrs' },
    };
    const { page, etagKey } = map[kind];
    const r = await fetchWikiPage(page, store.get(etagKey));
    if (r.notModified) { // 无变化:缓存里的就是最新
      if (kindNonEmpty(kind)) syncPhase[kind] = 'ready';
      else store.set(etagKey, ''); // 有 304 记录但缓存是空的(异常态):丢 etag,下轮强制重抓
      if (kind === 'rankings' && !(data.rankings || {}).stampSrc) store.set(etagKey, ''); // 旧缓存的日期来自本地抓取(不可信):丢 etag 换一次全量,补页面真实数据日期
      return;
    }
    if (r.etag) store.set(etagKey, r.etag);
    if (kind === 'matches') {
      const fresh = parseMatches(r.html);
      reHomePromoted(fresh); // LP 还没翻牌的抢翻场次回灌成 upcoming 时,按 promotedIds 留在 live
      carryEnrichment(data.matches?.live, fresh.live); // 换新表前把增强数据带过去,防"进行中"↔比分闪跳
      // PandaScore 已核实结束、LP 还没下架的场次直接过滤,防"摘了又回"反复横跳
      fresh.live = (fresh.live || []).filter((m) => !finishedKeysHas(matchKey(m.teamA?.name, m.teamB?.name)));
      // 改期检测:同名对阵的新旧开赛时间差 ≥60s 视为推迟/提前,标记 tsPrev 供列表与主卡展示
      const oldByKey = new Map((data.matches?.upcoming || []).map((x) => [x.teamA?.name + '|' + x.teamB?.name, x]));
      for (const x of fresh.upcoming || []) {
        const prev = oldByKey.get(x.teamA?.name + '|' + x.teamB?.name);
        if (prev && prev.ts && x.ts && Math.abs(x.ts - prev.ts) >= 60e3) x.tsPrev = prev.ts;
      }
      harvestMatchArchive(fresh.recent || []); // 赛果入本地档案(S 级留 45 天),再把 48h 外的 S 级并回列表
      fresh.recent = mergeMatchArchive(fresh.recent || []);
      data.matches = fresh;
      data.matches.recent = reappliedSupplement(data.matches.recent); // Panda 补位行逐轮重套用:LP 整表替换不再吞掉已补的场次
    }
    // events/transfers/rankings:内容与上次相同就不再推送/重渲染(304 挡了大部分,这里挡 200 同文)
    const prevJson = kind === 'matches' ? '' : JSON.stringify(kind === 'events' ? data.events : kind === 'transfers' ? data.transfers : data.rankings);
    if (kind === 'events') {
      const prevOngoing = (data.events?.ongoing || []).map((e) => slugOf(e.href).toLowerCase()); // 覆盖前记下在榜名单:本轮消失的即"掉榜",记结束时间
      data.events = parseEvents(r.html);
      tierArchiveHarvest();
      markEventEnds(prevOngoing);
    }
    if (kind === 'transfers') data.transfers = parseTransfers(r.html);
    if (kind === 'rankings') { // changedAt=VRS 数据更新日期(页面自带 "updated: YYYY-MM-DD" 标注);stampSrc=page 标记"日期来自页面",旧缓存里本地抓取出的日期一律不可信
      const prevR = data.rankings || {};
      const fresh = parseVrs(r.html);
      const pageStamp = parseVrsStamp(r.html);
      // 只信页面数据日期:标注缺失就沿用旧值/留空(渲染层显示'—'),绝不拿本地抓取时间冒充 VRS 更新日期
      const stamp = pageStamp || prevR.changedAt || 0;
      data.rankings = { ...fresh, updatedAt: Date.now(), ...(stamp ? { changedAt: stamp } : {}), ...(pageStamp ? { stampSrc: 'page' } : {}) };
    }
    const contentChanged = kind === 'matches' || JSON.stringify(kind === 'events' ? data.events : kind === 'transfers' ? data.transfers : data.rankings) !== prevJson;
    const wasStale = meta.stale;
    syncPhase[kind] = 'ready';
    meta = { updatedAt: Date.now(), stale: false, err: '' };
    if (kind === 'matches') { trackMatchTransitions(); checkReminders();
      if (!recentAudited && (data.matches?.recent || []).length) { recentAudited = true; auditRecentEnded(); }
      if (!recentSupplemented && (data.matches?.recent || []).length && store.get('pandaToken')) { recentSupplemented = true; supplementRecentFromPanda(); } }
    if (kind === 'transfers') {
      const rows = data.transfers;
      const lastSeen = store.get('lastSeenTransferId');
      if (!lastSeen) {
        newTransferIds = []; // 首次运行不提示历史
      } else {
        const idx = rows.findIndex(t => t.id === lastSeen);
        newTransferIds = idx === -1 ? rows.slice(0, 3).map(t => t.id) : rows.slice(0, idx).map(t => t.id);
      }
      if (rows.length) store.set('lastSeenTransferId', rows[0].id);
    }
    if (contentChanged || wasStale || syncPhase[kind] !== 'ready') { saveCache(); pushData(); }
    if (kind === 'transfers' && contentChanged) notifyNewTransfers();
  } catch (e) {
    meta = { ...meta, stale: true, err: String(e.message || e) };
    console.error('[fetch]', kind, e.message);
    if (kind === 'matches') await pandaMatchesFallback(String(e.message || e));
    pushData();
  }
}

async function bootstrapData() {
  if (booting) return; // 上一次引导(启动/手动刷新)还没跑完:不并发堆请求
  booting = true;
  try {
    if (useMock) {
      try {
        data = JSON.parse(fs.readFileSync(path.join(__dirname, '_dev', 'mock-data.json'), 'utf8'));
        meta = { updatedAt: Date.now(), stale: false, err: '' };
        newTransferIds = (data.transfers || []).slice(0, 2).map(t => t.id);
        syncPhase = { matches: 'ready', events: 'ready', transfers: 'ready', rankings: 'ready' };
        // 截图常青化:按 live[0](缺位依次回退)锚点整体平移,保持 mock 自身的相对时间线——
        // 此前按分区强排固定阶梯(live 全 37 分钟前/upcoming 18 分钟起),会让"半决赛刚打完的队几分钟后又上场"穿帮
        // mock 顶层 liveAnchorMin(默认 37)可指定主卡"已进行"分钟数,让 BO3 前两图打完的场景不再失真
        const now = Date.now();
        const live = data.matches?.live || [], up = data.matches?.upcoming || [], rc = data.matches?.recent || [];
        const anchor = live[0] || up[0] || rc[0];
        const delta = anchor ? (now - (data.liveAnchorMin || 37) * 60e3) - anchor.ts : 0;
        for (const m of [...live, ...up, ...rc]) {
          const d = m.tsPrev ? m.ts - m.tsPrev : 0;
          m.ts += delta;
          if (m.endedAt) m.endedAt += delta; // 平移保对局时长
          if (d > 0) m.tsPrev = m.ts - d;
        }
        // mock 顶层 mapPool.LIVE0 / UP0 = 第一场 live / upcoming 的图序演示数据,按定基后的 ts 落到真实键
        if (data.mapPool && (live[0] || up[0])) {
          const mp = data.mapPool, pool = {};
          delete data.mapPool;
          if (mp.LIVE0 && live[0]) pool[String(live[0].ts)] = mp.LIVE0;
          if (mp.UP0 && up[0]) pool[String(up[0].ts)] = mp.UP0;
          shotMapPool = pool; // 仅内存:演示图序绝不写用户 store(曾覆盖真实采集的图序缓存)
        }
        // 截图演示:注入示例关注(FaZe 队伍 + ropz 选手)
        if (process.argv.includes('--star-demo')) {
          store.data.starTeams = [{ id: 'FaZe', name: 'FaZe', href: '/counterstrike/FaZe' }, { id: 'MOUZ', name: 'MOUZ', href: '/counterstrike/MOUZ' }];
          store.data.starPlayers = [
            { id: 'ropz', name: 'ropz', href: '/counterstrike/ropz', team: 'FaZe', teamSlug: 'FaZe', resolvedAt: Date.now() },
            // PandaScore 形态:teamSlug 带 -cs-go 后缀、队名为全名——回归 NAVI(缩写)置顶匹配
            { id: 'w0nderfu1', name: 'w0nderful', href: '', team: 'Natus Vincere', teamSlug: 'natus-vincere-cs-go', panda: true, resolvedAt: Date.now() },
          ];
        }
        return;
      } catch (e) { console.error('[mock] 加载失败,回落到在线抓取'); }
    }
    // 先读缓存保证首屏:赛事/变阵/图序全在缓存里,立即下发,不等网络——
    // LP 慢或冷却时窗口也不再长时间空白(没有缓存的部分由 syncPhase 驱动"同步中"挂起态)
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      if (c.pver === PARSE_VER) { data = c.data; meta = c.meta; }
      else { // 解析器升级:旧解析产物不可信,作废并丢 etag —— 不然页面 304 会一直沿用旧数据,解析侧修复落不了地
        ['etagMatches', 'etagEvents', 'etagTransfers', 'etagVrs'].forEach((k) => store.set(k, ''));
      }
      syncPhase = {
        matches: kindNonEmpty('matches') ? 'ready' : 'pending',
        events: kindNonEmpty('events') ? 'ready' : 'pending',
        transfers: kindNonEmpty('transfers') ? 'ready' : 'pending',
        rankings: kindNonEmpty('rankings') ? 'ready' : 'pending',
      };
      loadTrackState();
      pushData();
    } catch { /* 无缓存 */ }
    await fetchKind('matches');
    await fetchKind('events');
    await fetchKind('transfers');
    if (!(data.rankings || {}).stampSrc) store.set('etagVrs', ''); // 旧缓存的 VRS 日期来自本地抓取(不可信):丢 etag,启动首轮全量拿页面真实数据日期
  await fetchKind('rankings');
    harvestEventMaps(); // 启动也采一次;缓存里已有的图序首屏直接显示
  tierBackfill(); // 掉榜赛事评级回填:启动先补一轮(刚完赛掉榜的评级立即找回)
  } finally { booting = false; }
}

// ---------- 赛事页图序采集(BP 都是赛前才出,有图序的场次天然就是临场的) ----------
// 只抓未来 24h 内有对阵的赛事页,每次最多补 1 页(走全局 30s 队列);临近开赛(=BP 窗口)的页 90s 重采,
// 远场 10 分钟。采到的图序按开赛时间戳持久缓存(mapPool),跨重启首屏可用,随 push:data 下发
function eventPagesForUpcoming() {
  const now = Date.now();
  const pages = new Map(); // page → 最先开赛的 ts
  // 直播中的比赛同样纳入：BP 最晚赛前敲定，但应用未必一直开着；赛事页弹层对进行中场次
  // 还带实时比分，直播期间走 90s 档重采，主卡图序带与比分才跟得上
  for (const m of (data.matches?.live || [])) {
    if (!m.eventHref || !m.ts) continue;
    const page = slugOf(m.eventHref); // abs() 产出的是完整 URL,api.php 要的是 counterstrike/ 之后的页面名(slugOf 顺带剥锚点+解码);拼整条 URL 会 missingtitle
    const cur = pages.get(page);
    if (cur == null || m.ts < cur) pages.set(page, m.ts);
  }
  for (const m of (data.matches?.upcoming || [])) {
    if (!m.eventHref || !m.ts || m.ts < now - 6 * 3600e3 || m.ts > now + 24 * 3600e3) continue; // 已开赛 6h 内的也采（LP 免费档无 running 列表，开赛后仍留在 upcoming）
    const page = slugOf(m.eventHref); // abs() 产出的是完整 URL,api.php 要的是 counterstrike/ 之后的页面名(slugOf 顺带剥锚点+解码);拼整条 URL 会 missingtitle
    const cur = pages.get(page);
    if (cur == null || m.ts < cur) pages.set(page, m.ts);
  }
  return [...pages.entries()].sort((x, y) => x[1] - y[1]);
}
async function harvestEventMaps() {
  if (lpCooldownUntil() > Date.now()) return; // LP 冷却(429)期不添乱
  const pages = eventPagesForUpcoming();
  if (!pages.length) return;
  const now = Date.now();
  const picked = pages.find(([page, soonest]) => {
    const ttl = soonest - now < 2 * 3600e3 ? 90e3 : 600e3;
    return now - (mapMeta[page] || 0) > ttl;
  });
  if (!picked) return;
  const [page] = picked;
  mapMeta[page] = now;
  try {
    const fetchParse = async (pg) => {
      const r = await fetchWikiPage(pg, (store.get('mapEtags') || {})[pg]);
      if (r.notModified) return [];
      if (r.etag) { const t = store.get('mapEtags') || {}; t[pg] = r.etag; store.set('mapEtags', t); }
      return parseEventMaps(r.html || '');
    };
    const fetchParseSafe = async (pg) => { try { return await fetchParse(pg); } catch { return []; } };
    const sub = (store.get('eventSub') || {})[page];
    let rows;
    if (sub) {
      rows = await fetchParseSafe(sub); // 已解析过真身子页:直接采它
    } else {
      rows = await fetchParseSafe(page);
      // 列表页给的事件链接可能是已不存在/不含弹层的系列父页:页里没有临近场次的弹层时,
      // prefixsearch 找编号最大的子页(最新一期)并记住,后续直接采子页
      if (!rows.some((x) => Math.abs(x.ts - now) < 24 * 3600e3)) {
        const q = await apiQuery({ action: 'query', list: 'prefixsearch', pssearch: page + '/', pslimit: 'max' });
        const numOf = (t) => { const m = /\/(\d+)\s*$/.exec(t || ''); return m ? +m[1] : -1; };
        const target = ((q.query || {}).prefixsearch || []).map((x) => x.title)
          .filter((t) => /\/\d+\s*$/.test(t)).sort((a, b) => numOf(b) - numOf(a))[0];
        if (target) {
          const t = store.get('eventSub') || {}; t[page] = target; store.set('eventSub', t);
          rows = await fetchParseSafe(target);
        }
      }
    }
    mergeEventMaps(rows || []);
  } catch { /* 图序是增强数据,抓不到不影响主功能 */ }
}
function mergeEventMaps(rows) {
  const now = Date.now();
  const pool = { ...(store.get('mapPool') || {}) };
  for (const r of rows) {
    if (!(r.games || []).some((g) => g.map)) continue;
    const arr = pool[String(r.ts)] || [];
    const i = arr.findIndex((x) => (fuzzyTeamEq(x.a, r.a) && fuzzyTeamEq(x.b, r.b)) || (fuzzyTeamEq(x.a, r.b) && fuzzyTeamEq(x.b, r.a)));
    const rec = { a: r.a, b: r.b, bestof: r.bestof, games: r.games, at: now };
    if (i >= 0) arr[i] = rec; else arr.push(rec);
    pool[String(r.ts)] = arr;
  }
  for (const k of Object.keys(pool)) if (Number(k) < now - 72 * 3600e3) delete pool[k]; // 打完 3 天的图序没用了
  store.set('mapPool', pool);
  pushData();
}
function fuzzyTeamEq(x, y) { // 弹层里是队伍短名(PARIVISION/Magic),与主对阵页全名做包含级匹配
  x = String(x || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  y = String(y || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  if (!x || !y) return false;
  return x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)));
}
let mapMeta = {}, lastMapHarvestAt = 0;

function cacheFile() { return path.join(app.getPath('userData'), 'cache.json'); }
function saveCache() {
  if (useMock) return; // mock 数据绝不落盘:--mock/--shot 运行曾把演示变阵写进真实缓存,用户重启后看到一会儿假数据(mapPool 教训的同族,此处治整包)
  try { fs.writeFileSync(cacheFile(), JSON.stringify({ data, meta, pver: PARSE_VER })); } catch { }
}

function startScheduler() {
  if (isShot) return;
  setInterval(() => {
    const now = Date.now();
    const iv = Math.max(1, store.get('intervalMin')) * 60e3;
    const anyLive = (data.matches?.live || []).length > 0;
    const anyStarting = (data.matches?.upcoming || []).some((m) => m.ts && m.ts <= now && now - m.ts < 30 * 60e3); // 到点未开赛也跑 enrichLive 抢翻:同一 45s 节流阀
    const matchIv = anyLive ? Math.min(iv, 120e3) : iv;
    if ((anyLive || anyStarting) && store.get('pandaToken') && now - lastPandaAt > 45e3) {
      lastPandaAt = now; enrichLive(); return;
    }
    if (now - meta.updatedAt > 60e3 && meta.stale) { fetchKind('matches'); return; } // 失败快速重试
    if (now - (meta.updatedAt || 0) > matchIv) { fetchKind('matches'); return; }
    if (now - (lastEventsAt || 0) > 30 * 60e3) { lastEventsAt = now; fetchKind('events'); return; }
    if (now - (lastTransfersAt || 0) > 30 * 60e3) { lastTransfersAt = now; fetchKind('transfers'); return; }
    if (now - (lastVrsAt || 0) > 6 * 3600e3) { lastVrsAt = now; fetchKind('rankings'); return; }
    if (now - lastMapHarvestAt > 35e3) { lastMapHarvestAt = now; harvestEventMaps(); tierBackfill(); } // 图序采集+评级回填:异步进全局 30s 队列,不占当拍
    if (now - lastUpdCheckAt > 12 * 3600e3) { checkUpdate(false); return; } // 每 12h 静默查更新:发现新版只亮题头角标
    if (now - lastStreamersAt > 120e3) { lastStreamersAt = now; refreshStreamers(); return; }
  }, 25e3);
}
let lastEventsAt = Date.now(), lastTransfersAt = Date.now(), lastVrsAt = Date.now(), lastPandaAt = 0, lastUpdCheckAt = 0;

// ---------- 主播直播间开播检测 ----------
// 斗鱼/虎牙:检测房间页内嵌状态(比第三方接口可靠:斗鱼 open.douyucdn.cn 对 6657 返回过别人房间的错数据):
//   斗鱼 show_status:1=开播,但轮播(一起看)时仍为 1,需再查 videoLoop:1=轮播中(RSSHub 同款判定,
//   real-url#368 亦证实 show_status 不分轮播)——轮播不算开播,绿点不亮;
//   虎牙 TT_ROOM_DATA 的 isOn:true 且 isReplay:false 才算在播
// Twitch:不走房间页抓取,统一改官方 Helix 批量接口(需用户自配 Client ID/Secret,
// 未配置则完全不发起任何 Twitch 请求,英文主播条目也不显示开播)——见 refreshTwitchBatch
// CSBOY 是马西西+MO 二人组合,各有独立直播间:captainmo 是 MO 的房,19307729 是马西西的房
// lang:该解说面向的界面语言;英文界面只展示 en 条目(国际知名英文频道/主播),中文界面只展示 zh 条目
const STREAMERS = [
  { key: 'wanjiqi', name: '玩机器', url: 'https://www.douyu.com/6657', platform: 'douyu', room: '6657', lang: 'zh' },
  { key: 'csboy', name: 'MO', url: 'https://www.huya.com/captainmo', platform: 'huya', room: 'captainmo', lang: 'zh' },
  { key: 'maxixi', name: '马西西', url: 'https://www.huya.com/19307729', platform: 'huya', room: '19307729', lang: 'zh' },
  { key: 'danking', name: 'DANK1NG', url: 'https://www.huya.com/dank1ng', platform: 'huya', room: 'dank1ng', lang: 'zh' },
  // 英文/国际:三大赛事官方频道(esl_csgo=ESL 旗舰英文频道,BLAST/PGL 为 Major 级主办方)+ 两位人气英文主播
  { key: 'esl', name: 'ESL CS', url: 'https://www.twitch.tv/esl_csgo', platform: 'twitch', room: 'esl_csgo', lang: 'en' },
  { key: 'blast', name: 'BLAST Premier', url: 'https://www.twitch.tv/blastpremier', platform: 'twitch', room: 'blastpremier', lang: 'en' },
  { key: 'pgl', name: 'PGL', url: 'https://www.twitch.tv/pgl', platform: 'twitch', room: 'pgl', lang: 'en' },
  { key: 'ohnepixel', name: 'ohnepixel', url: 'https://www.twitch.tv/ohnepixel', platform: 'twitch', room: 'ohnepixel', lang: 'en' },
  { key: 'fl0m', name: 'fl0m', url: 'https://www.twitch.tv/fl0m', platform: 'twitch', room: 'fl0m', lang: 'en' },
];
const streamerStatus = { updatedAt: 0, twitchOn: isShot, list: STREAMERS.map((s) => ({ ...s, live: false, err: '' })) }; // twitchOn=截图模式默认真,保住 en 演示的开播绿点;正常运行由凭证决定
let lastStreamersAt = Date.now(), streamerPolling = false;

async function fetchStreamerLive(entry) {
  const url = entry.platform === 'douyu' ? `https://www.douyu.com/${entry.room}`
    : `https://www.huya.com/${entry.room}`; // Twitch 不在此列:走 Helix 批量接口,不做页面抓取
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Referer': `https://www.${entry.platform}.com/`,
    },
  });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; } // 错误页不解析,保住上次状态
  const html = await res.text();
  if (entry.platform === 'douyu') {
    // 房间页内嵌 JSON 是双重转义的(实测 `\\\"show_status\\\":1`),键名与冒号间的反斜杠/引号个数不定,
    // 用字符类容错任意个;旧正则只忍一个反斜杠,永远落空 → 开播检测一直失效
    const m = html.match(/show_status[\\\"']*\s*:\s*(\d+)/);
    if (!m || m[1] !== '1') return false;
    // 轮播(一起看)时 show_status 仍为 1,videoLoop:1 才是轮播标志 → 不算开播
    const loop = html.match(/videoLoop[\\\"']*\s*:\s*(\d+)/);
    return !(loop && loop[1] === '1');
  }
  const on = html.match(/"isOn":(true|false)/);
  const replay = html.match(/"isReplay":(true|false)/);
  return on ? on[1] === 'true' && (!replay || replay[1] === 'false') : false;
}

// ---------- Twitch 官方 Helix 开播检测(英文主播) ----------
// 每用户在 dev.twitch.tv 自建应用拿 Client ID/Secret(免费,client_credentials 无需回调);
// app token 约 60 天有效,401 自愈重取。Helix 限速=每 client ID 800 点/分,streams 端点 1 点/次
// 且一次可批量 ≤100 个 user_login——全部英文频道一轮一个请求,远低于配额。
// 未配置凭证时完全不发起任何 Twitch 请求
let twitchTok = null; // { token, exp }
function twitchCreds() {
  const id = String(store.get('twitchClientId') || '').trim();
  const secret = String(store.get('twitchSecret') || '').trim();
  return { id, secret, ok: !!(id && secret) };
}
async function twitchAppToken(id, secret) {
  if (twitchTok && twitchTok.exp > Date.now() + 60e3) return twitchTok.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) { const e = new Error('Twitch token HTTP ' + res.status); e.status = res.status; throw e; }
  const j = await res.json();
  twitchTok = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 0) * 1000 };
  return twitchTok.token;
}
async function refreshTwitchBatch(entries) {
  if (!entries.length) return;
  const { id, secret } = twitchCreds();
  const token = await twitchAppToken(id, secret);
  const res = await fetch('https://api.twitch.tv/helix/streams?' + entries.map((s) => 'user_login=' + encodeURIComponent(s.room)).join('&'), {
    headers: { 'Client-Id': id, 'Authorization': 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) { twitchTok = null; const e = new Error('Twitch token 需重取'); e.status = 401; throw e; } // 下轮自动重换 app token
  if (res.status === 403 || res.status === 429) { const e = new Error('Twitch HTTP ' + res.status); e.status = res.status; throw e; }
  if (!res.ok) throw new Error('Twitch HTTP ' + res.status);
  const j = await res.json();
  const liveSet = new Set((Array.isArray(j.data) ? j.data : []).map((s) => String(s.user_login || '').toLowerCase()));
  for (const s of entries) s.live = liveSet.has(String(s.room).toLowerCase());
}

// 串行轮询:斗鱼/虎牙逐房间页(请求间 1.5s 限速),Twitch 一轮一次批量;失败保留上次状态,下轮再试;
// 403/429 视为被限流,对应条目(虎牙/斗鱼按房间、Twitch 整组)冷却 15 分钟退避
async function refreshStreamers() {
  if (streamerPolling) return;
  streamerPolling = true;
  try {
    const list = streamerStatus.list;
    const twitchOn = twitchCreds().ok;
    streamerStatus.twitchOn = twitchOn;
    if (twitchOn) {
      try {
        await refreshTwitchBatch(list.filter((s) => s.platform === 'twitch' && Date.now() >= (s.coolUntil || 0)));
        for (const s of list) if (s.platform === 'twitch') s.err = '';
      } catch (e) {
        const errText = String(e.message || e);
        const cool = e.status === 403 || e.status === 429 || e.status === 401;
        for (const s of list) if (s.platform === 'twitch') { s.err = errText; if (cool) s.coolUntil = Date.now() + 15 * 60e3; }
      }
    } else {
      for (const s of list) if (s.platform === 'twitch') { s.live = false; s.err = ''; } // 未配置:恒不在线,渲染层同步隐藏
    }
    for (const entry of list.filter((s) => s.platform !== 'twitch')) {
      if (Date.now() < (entry.coolUntil || 0)) continue;
      try {
        entry.live = await fetchStreamerLive(entry);
        entry.err = '';
      } catch (e) {
        entry.err = String(e.message || e);
        if (e.status === 403 || e.status === 429) entry.coolUntil = Date.now() + 15 * 60e3;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    streamerStatus.updatedAt = Date.now();
    if (win && !win.isDestroyed()) win.webContents.send('push:streamers', streamerStatus);
  } finally {
    streamerPolling = false;
  }
}

// PandaScore running 缺席宽限:队名对 -> 连续未命中拍数。图间休息/接口抖动时 running 列表会
// 短暂移除比赛,不立刻清增强数据,否则"第N图/大比分"会闪没
const pandaMiss = new Map();
const promotedIds = new Set(); // 抢翻成 live 的场次 id:LP 重抓还没翻牌时靠它留在 live,防「live↔即将开赛」横跳

// matches 每次重抓都整表换新对象:把旧 live 里的增强数据(score/live2/isFinal)按队名对带到新表,
// 否则每次 LP 刷新后到下一次 enrichLive(≥45s)之间,主卡会闪回"进行中"再跳回比分
function carryEnrichment(oldLive, freshLive) {
  const key = (a, b) => [a, b].map((t) => String((t && t.name) || '').toLowerCase()).sort().join('|');
  const prev = new Map((oldLive || []).map((m) => [key(m.teamA, m.teamB), m]));
  for (const m of freshLive || []) {
    const old = prev.get(key(m.teamA, m.teamB));
    if (!old) continue;
    if (old.score) m.score = old.score;
    if (old.live2) m.live2 = old.live2;
    if (old.isFinal) m.isFinal = old.isFinal;
    if (!m.stage && old.stage) m.stage = old.stage; // Panda 阶段名兜底跨 LP 重建保持,防阶段标记闪没
  }
}

// 回合级实时比分增强(PandaScore,可选)——返回错误串,'' 表示成功
// LP 的 Matches 页对已完赛场次的下架常滞后数小时,期间该场一直挂 live(主卡长时间显示已结束的比分)。
// running 连续缺席后,用 PandaScore 全量列表核实:同两队且结束时间晚于该场开赛的 finished 场次即是这一场
// → 从 live 摘除,并记入 finishedKeys 让后续 LP 刷新重灌时持续过滤,防"摘了又回"反复横跳
const finishedKeys = new Map(); // 规范化对阵键 → 记录过期时刻(24h)
const realEnded = new Map(); // PandaScore 核实出的真实结束时刻(ms),按场次 id 记;endAgo 显示与结束通知都该用它
function finishedKeysHas(key) {
  const exp = finishedKeys.get(key);
  if (!exp) return false;
  if (exp < Date.now()) { finishedKeys.delete(key); return false; }
  return true;
}
// LP 与 PandaScore 队名写法常不一致(NAVI Jr./OLDBOYS ↔ NAVI Junior/OLDBOYS PL),严格 matchKey
// 对不上时已结束的场次会在主卡挂到 LP 自己下架为止。二级模糊匹配:jr 归一成 junior;一侧队名可
// 容纳另一侧(≥5 字符,挡 NAVI↔NAVI Junior 这类同根不同队);两队都要过,且另加开赛时间窗(±30 分钟)兜底
const aliasNorm = (s) => normTeam(s).replace(/jr$/, 'junior');
const looseTeamEq = (a, b) => !!a && !!b && (a === b
  || (a.includes(b) && b.length >= 5) || (b.includes(a) && a.length >= 5));
function fuzzyPair(la, lb, ra, rb) {
  const a = aliasNorm(la), b = aliasNorm(lb), x = aliasNorm(ra), y = aliasNorm(rb);
  return (looseTeamEq(a, x) && looseTeamEq(b, y)) || (looseTeamEq(a, y) && looseTeamEq(b, x));
}
let lastStaleCheckAt = 0;
async function confirmStaleLive(cands) {
  if (Date.now() - lastStaleCheckAt < 120e3) return; // 核实要走全量列表,限频 2 分钟一次
  lastStaleCheckAt = Date.now();
  const token = store.get('pandaToken');
  if (!token) return;
  let list;
  try { list = await fetchPandaMatchList(token); } catch { return; } // 限流/token 失效:保持现状,下轮再核
  if (!list || !Array.isArray(list.recent)) return;
  const now = Date.now();
  const live = data.matches?.live || [];
  let removed = false;
  for (const m of cands) {
    const key = matchKey(m.teamA?.name, m.teamB?.name);
    const fin = list.recent.find((r) => {
      const near = !m.ts || !r.ts || Math.abs(r.ts - m.ts) <= 30 * 60e3;
      return (matchKey(r.teamA?.name, r.teamB?.name) === key
        || (near && fuzzyPair(m.teamA?.name, m.teamB?.name, r.teamA?.name, r.teamB?.name)))
        && (r.endedAt || r.ts || 0) > (m.ts || 0) - 3600e3
        && (r.endedAt || r.ts || 0) > now - 12 * 3600e3;
    });
    if (!fin) continue;
    finishedKeys.set(key, now + 24 * 3600e3);
    if (fin.endedAt || fin.ts) realEnded.set(m.id, fin.endedAt || fin.ts);
    const i = live.indexOf(m);
    if (i >= 0) { live.splice(i, 1); removed = true; }
    pandaMiss.delete([m.teamA?.name, m.teamB?.name].map((n) => String(n || '').toLowerCase()).sort().join('|'));
  }
  if (removed) pushData();
}

// LP 重抓回灌防护:抢翻过的场次 LP 仍挂 upcoming 时把它搬回 fresh.live;集合里只留 live 在册的 id
function reHomePromoted(fresh) {
  const ups = fresh.upcoming || [];
  for (let i = ups.length - 1; i >= 0; i--) {
    const m = ups[i];
    if (!promotedIds.has(m.id) || !m.ts || m.ts > Date.now()) continue;
    ups.splice(i, 1);
    m.status = 'live';
    (fresh.live = fresh.live || []).unshift(m);
  }
  for (const id of [...promotedIds]) if (!(fresh.live || []).some((x) => x.id === id)) promotedIds.delete(id);
}

// 到点未开赛抢翻:LP 翻 live 常滞后几分钟;PandaScore running 一出现(=服务器真的开打)就本地翻成 live。
// 复用 enrichLive 已拉回的同一份 running 响应,零新增请求;只认开赛后 30 分钟内的场次,取消/腰斩的过期
// 场次不会把探测无限拖下去
function promoteStarting(running) {
  const now = Date.now();
  let promoted = false;
  const ups = data.matches?.upcoming || [];
  for (let i = ups.length - 1; i >= 0; i--) {
    const m = ups[i];
    if (!m.ts || m.ts > now || now - m.ts > 30 * 60e3) continue;
    const hit = findForTeams(running, m.teamA.name, m.teamB.name);
    if (!hit) continue;
    if (hit.series) m.score = hit.swap ? [hit.series[1], hit.series[0]] : hit.series;
    m.live2 = { mapNum: hit.mapNum, ra: hit.swap ? hit.rb : hit.ra, rb: hit.swap ? hit.ra : hit.rb, maps: hit.swap ? hit.maps.map(([a, b]) => [b, a]) : hit.maps, mapName: hit.mapName || '', mapNames: hit.mapNames || [] };
    if (!m.stage && hit.pStage) m.stage = hit.pStage; // 阶段双源互补
    m.isFinal = !!hit.isFinal && !isThirdPlace(m.stage); // 决赛语境闩锁(+季军赛豁免)
    m.status = 'live';
    ups.splice(i, 1);
    (data.matches.live = data.matches.live || []).unshift(m);
    promotedIds.add(m.id);
    promoted = true;
  }
  return promoted;
}

async function enrichLive() {
  const token = store.get('pandaToken');
  if (!token) return 'NO_TOKEN';
  let err = '';
  try {
    const running = await fetchPandaRunning(token);
    let hitCount = 0;
    const staleCheck = []; // 连续缺席 running 的场次,稍后统一交给 confirmStaleLive 核实
    for (const m of data.matches?.live || []) {
      const pairKey = [m.teamA.name, m.teamB.name].map((n) => String(n || '').toLowerCase()).sort().join('|');
      const hit = findForTeams(running, m.teamA.name, m.teamB.name);
      if (hit) {
        pandaMiss.delete(pairKey);
        // swap: PandaScore 的 team1/team2 与列表 teamA/teamB 顺序相反时,比分/图分对调
        const ra = hit.swap ? hit.rb : hit.ra;
        const rb = hit.swap ? hit.ra : hit.rb;
        const maps = hit.swap ? hit.maps.map(([a, b]) => [b, a]) : hit.maps;
        // 大比分:running 接口的 results 免费档实时可得;Liquipedia 对进行中的比赛常无比分,中央空白就出在这
        if (hit.series) m.score = hit.swap ? [hit.series[1], hit.series[0]] : hit.series;
        // mapName/mapNames 与队序无关,不随 swap;将来 LPDB match2games 的图名也落进这两个字段
        m.live2 = { mapNum: hit.mapNum, ra, rb, maps, mapName: hit.mapName || '', mapNames: hit.mapNames || [] };
        if (!m.stage && hit.pStage) m.stage = hit.pStage; // 阶段双源互补:LP 决赛卡常无后缀,用 PandaScore 阶段名兜底(Grand Final→总决赛)
        m.isFinal = !!hit.isFinal && !isThirdPlace(m.stage); // 决赛语境闩锁:缺席不清除,赛点/决胜图升级冠军点用
        hitCount++;
      } else {
        // 比赛不在 PandaScore running 列表:可能真结束/未收录,也可能只是图间休息(running 会短暂移除)。
        // 连续 3 拍(≥45s/拍,约 2 分多钟)仍缺席才清残留,否则主卡/列表的比分会闪没;
        // 缺席继续累积,过 3 拍后用全量列表核实是否真已结束(见 confirmStaleLive)
        const miss = (pandaMiss.get(pairKey) || 0) + 1;
        pandaMiss.set(pairKey, miss);
        if (miss >= 3 && m.live2) { m.live2.ra = null; m.live2.rb = null; } // 降级链:L2 回合分过期;L1 图号图名冻结、L0 决赛语境闩锁(confirmStaleLive 摘场才随对象释放)
        if (miss >= 3 && miss % 4 === 3) staleCheck.push(m);
      }
    }
    if (staleCheck.length) await confirmStaleLive(staleCheck);
    const promoted = promoteStarting(running); // 抢翻:复用上面这份 running 响应,零新增请求
    if (hitCount || promoted) pushData();
  } catch (e) {
    err = String(e.message || e);
    console.error('[panda]', err); // token 无效/限流时静默停用
  }
  return err;
}

// ---------- 窗口 ----------
// 模式尺寸范畴:每档有固定最小/最大,拖出范畴即无痛切换显示模式
const MINI_SIZE = { width: 260, height: 160 }; // 160 = 标题栏24 + 页脚18 + hero(边距4+内边6):全信息最坏情况(题头+回合行+队名行+图序带+赛点胶囊行+图x·BO行)≈112 行高。旧 240×128 追求极小,胶囊挤比分、图x/BO3 被裁出卡外(用户实测反馈)
const MINI_EXIT = { width: 300, height: 176 };  // 迷你条拖大越过此线 → 还原为普通模式(必须大于 MINI_SIZE,否则切迷你即误触退出;宽度 300 与普通档最小值衔接)
const MINI_BOX = { min: { width: 200, height: 160 }, max: { width: 560, height: 1040 } };  // 高度下限=MINI_SIZE(160):再矮就裁掉题头/图带/页脚(用户反馈"无限缩小");宽度仍可收窄。不设小上限:靠 MINI_EXIT 检测跨档(setBounds 会被 max 钳住,读不到超限)
const NORM_BOX = { min: { width: 300, height: 420 }, max: { width: 560, height: 1040 } }; // 普通模式最小=小卡档

function applyModeBounds() {
  if (!win || win.isDestroyed()) return;
  const box = store.get('mini') ? MINI_BOX : NORM_BOX;
  win.setMinimumSize(box.min.width, box.min.height);
  win.setMaximumSize(box.max.width, box.max.height);
}

function createWindow() {
  const b = store.get('bounds') || {};
  const mini = store.get('mini');
  const box = mini ? MINI_BOX : NORM_BOX;
  const w = new BrowserWindow({
    width: mini ? MINI_SIZE.width : (b.width || 380),
    height: mini ? MINI_SIZE.height : (b.height || 700),
    x: b.x, y: b.y,
    minWidth: box.min.width, minHeight: box.min.height,
    maxWidth: box.max.width, maxHeight: box.max.height,
    frame: false,
    show: false,
    resizable: true,
    alwaysOnTop: store.get('onTop') && !store.get('deskPin'), // 图钉与置顶互斥
    skipTaskbar: mini || !!store.get('hideTaskbar') || !!store.get('deskPin'),
    transparent: !wantsOsBackdrop(), // 取景玻璃关+frost/liquid:不透明窗口承载 DWM 系统背板;其余一律透明
    backgroundColor: '#00000000',
    // 系统背板必须在窗口创建时挂上:创建后运行时补挂,窗口底刷会保持不透明黑、背板透不出来
    ...(wantsOsBackdrop() ? { backgroundMaterial: 'acrylic' } : {}),
    hasShadow: false, // 透明窗口不启用系统阴影(方形阴影很丑)
    title: 'RainyWatch · 小暴雨助手',
    icon: path.join(__dirname, 'assets', 'icon.png'), // 任务栏/窗口图标(打包 exe 的图标来自 build/icon.ico,构建期注入)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win = w;
  applyGlassMaterial(); // 窗口就位后立即挂 OS 模糊底材(acrylic/mica 背板或 accent)
  w.loadFile(path.join(__dirname, 'src', 'index.html'));
  // 渲染层诊断直达终端:WebGL 实际用的是哪个渲染器只有渲染层拿得到('[fx] WebGL 渲染器: …'),
  // 打包/后台运行时 DevTools 不可见,按关键字转发到 stdout 进启动日志,用户可直接复制
  w.webContents.on('console-message', (e, _lvl, message) => {
    const msg = String(message ?? e?.message ?? '');
    if (/fx\]|GPU/i.test(msg)) console.log('[renderer]', msg);
  });
  // ready-to-show 在 Electron 中偶发不触发(主题/取景玻璃重建后尤甚),错过即窗口永不显示
  // = "点设置后程序隐藏自己"。did-finish-load 兜底保底出窗。
  let shown = false;
  const showOnce = () => { if (!shown && !w.isDestroyed()) { shown = true; w.show(); } };
  w.once('ready-to-show', showOnce);
  w.on('close', (e) => { if (!quitting) { e.preventDefault(); pinUserHidden = true; w.hide(); logHide('close-event(Alt+F4或系统关闭)'); } });
  // 系统背板:恒挂 acrylic(失焦由系统去饱和,渲染层 push:focus 加深打底)
  const pushFocus = () => { applyGlassMaterial(); if (!w.isDestroyed()) w.webContents.send('push:focus', w.isFocused()); };
  w.on('focus', pushFocus);
  w.on('blur', pushFocus);
  w.on('show', pushFocus);
  // hide/minimize 事件只有 Electron 自己调 hide()/minimize() 时才派发;Win+D 对工具窗口的外部 SW_HIDE
  // 不派发(日志里从未出现"即时顶回"可证)—— 这里留痕取证:若出现"收到 hide 事件"说明另有内部隐藏源
  const pinOn = () => store.get('deskPin') && !pinUserHidden;
  w.on('hide', () => { if (pinOn()) { logPin('收到 hide 事件(内部隐藏)'); reassertBurst('hide事件'); } });
  w.on('minimize', () => { if (pinOn()) { logPin('收到 minimize 事件'); reassertBurst('minimize事件'); } });
  w.webContents.on('did-finish-load', () => {
    applyGlassCapture();
    w.webContents.send('push:focus', w.isFocused()); // 重建后同步聚焦态
    w.webContents.send('push:streamers', streamerStatus); // 主播开播状态(渲染层兜底前先给一次)
    setTimeout(showOnce, 150);
    if (store.get('deskPin')) setTimeout(mountToDesktop, 350); // 主题/取景玻璃重建窗口后重挂桌面层
  });
  const saveBounds = () => {
    if (isShot || w.isDestroyed() || store.get('mini') || w.isMinimized()) return; // 截图模式不持久化窗口尺寸(整文件快照还原,防演示 bounds 泄漏)
    const nb = w.getBounds();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('bounds', nb), 400);
  };
  // 用户拖拽结束:按尺寸范畴自动切模式(迷你拖大→还原;普通拖到迷你范畴→缩为迷你条)
  w.on('resized', () => {
    autoModeBySize();
    saveBounds();
  });
  w.on('resize', autoModeBySize); // 拖拽过程中实时跨档:迷你条往下拖的瞬间即还原,不等松手
  w.on('moved', saveBounds);
}

function autoModeBySize() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  if (store.get('mini') && (b.width >= MINI_EXIT.width || b.height >= MINI_EXIT.height)) {
    setMini(false, { keepCurrent: true }); // 迷你条被拖大:按拖大后的尺寸还原,不回旧位置
  }
}

function recreateWindow() {
  const pos = win && !win.isDestroyed() ? win.getPosition() : null;
  const size = win && !win.isDestroyed() && !store.get('mini') ? win.getSize() : null;
  if (win && !win.isDestroyed()) win.destroy();
  if (pos && size) { const b = { x: pos[0], y: pos[1], width: size[0], height: size[1] }; if (!isShot) store.set('bounds', b); }
  createWindow();
}

// ---------- 图钉·桌面钉住:顶层窗口 + 被收起后自动顶回 ----------
// 曾尝试 SetParent 挂进 Progman/WorkerW 桌面带:Electron 透明窗口一旦变成嵌套子窗口,
// per-pixel alpha 无法与壁纸合成(整窗渲染成纯黑),accent/取景玻璃全废 —— 故不再挂载。
// 现保持顶层窗口,图钉只做三件事:不能拖动/缩放;被 显示桌面/Win+D 收起后自动顶回;
// 不占任务栏。常驻 Wallpaper Engine 的壁纸在桌面带(所有普通窗口之下),顶层窗口天然在其之上。
let pinApiCache = null;
function pinApi() {
  if (pinApiCache !== null) return pinApiCache;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    pinApiCache = {
      // ACCENT_POLICY 不做结构体定义:koffi 3.x 移除了 koffi.define,改为 16 字节裸内存(void*)传参
      SetWindowCompositionAttribute: user32.func('int32 __stdcall SetWindowCompositionAttribute(int64 hwnd, void* policy)'),
      // 显示桌面检测与临时置顶:Win+D 不 hide、不最小化,而是把桌面窗口抬到非置顶窗口之上盖住我们
      GetWindow: user32.func('int64 __stdcall GetWindow(int64 hwnd, uint32 cmd)'),
      GetWindowLongPtrW: user32.func('int64 __stdcall GetWindowLongPtrW(int64 hwnd, int32 idx)'),
      IsWindowVisible: user32.func('int32 __stdcall IsWindowVisible(int64 hwnd)'),
      GetClassNameW: user32.func('int32 __stdcall GetClassNameW(int64 hwnd, char16_t* buf, int32 max)'),
      GetForegroundWindow: user32.func('int64 __stdcall GetForegroundWindow(void)'),
      SetWindowPos: user32.func('int32 __stdcall SetWindowPos(int64 hwnd, int64 after, int32 x, int32 y, int32 cx, int32 cy, uint32 flags)'),
    };
    try {
      const dwm = koffi.load('dwmapi.dll');
      pinApiCache.DwmGetWindowAttribute = dwm.func('int32 __stdcall DwmGetWindowAttribute(int64 hwnd, uint32 attr, void* pvout, uint32 cb)');
      pinApiCache.DwmSetWindowAttribute = dwm.func('int32 __stdcall DwmSetWindowAttribute(int64 hwnd, uint32 attr, void* pvin, uint32 cb)');
    } catch { /* dwmapi 不可用:斗篷检测降级关闭 */ }
  } catch (err) { logHide('koffi 加载失败,accent 底材不可用:' + err.message); pinApiCache = false; }
  return pinApiCache;
}
function hwndOf() {
  if (!win || win.isDestroyed()) return 0;
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}
let pinTopTimer = null;
let pinUserHidden = false; // 用户主动隐藏(托盘/关闭到托盘)时不自动顶回
let lastPinLog = 0;
// 显示桌面态的斗篷:shell 用 DWM CLOAK 藏窗,WS_VISIBLE 仍在 → Electron 判定可见、'hide' 事件也不来,
// 但画面不渲染(用户视角=消失,点开任意应用解除桌面态才弹出)。DWMWA_CLOAKED 只读检测,DWMWA_CLOAK 可写
const DWMWA_CLOAK = 13, DWMWA_CLOAKED = 14;
function isCloaked(hwnd) {
  const api = pinApi();
  if (!api || !api.DwmGetWindowAttribute) return null;
  try {
    const out = Buffer.alloc(4);
    if (api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out, 4) !== 0) return null;
    return out.readInt32LE(0) !== 0;
  } catch { return null; }
}
function uncloak(hwnd) {
  const api = pinApi();
  if (!api || !api.DwmSetWindowAttribute) return false;
  try {
    const val = Buffer.alloc(4); val.writeInt32LE(0, 0); // FALSE
    return api.DwmSetWindowAttribute(hwnd, DWMWA_CLOAK, val, 4) === 0;
  } catch { return false; }
}
// 显示桌面(Win+D/右下角)的真相:shell 不 SW_HIDE、不最小化、也不 DWM 斗篷,而是把桌面窗口
// (Progman/WorkerW)抬到普通窗口带最顶端盖住我们 —— Electron 的 isVisible/isMinimized 照常返回、
// hide 事件也不来,用户视角却是消失;点任意应用时桌面回落,被盖住的窗口"同步弹出"。
// 对策:桌面窗口占据普通带顶端(=显示桌面态)时临时挂 WS_EX_TOPMOST(SWP_NOACTIVATE 不抢焦点)
// 把面板抬到桌面之上;桌面态一结束立即摘掉,恢复"其他窗口可覆盖"的图钉语义。
// 判定与前台窗口无关(从任务栏唤起全屏应用时前台常停在任务栏,fg 判定会让置顶迟迟不摘)。
// 实测这台机器的窗口带很脏:置顶带下压着十几个 SoPY/Overwolf 隐身窗,普通带顶端还有隐身的
// MSCTFIME UI —— "从任务栏向下走"会先撞上它,永远判不出桌面。所以两个方向都以"自己"为锚点:
//   普通态(未置顶):沿 Z 序向上,越过普通带全部窗口 —— 先碰到 Progman/WorkerW = 桌面盖着
//     我们(显示桌面态);先碰到置顶带 = 桌面在普通带之下(v2 实测可触发)
//   置顶态(已抬):沿 Z 序向下,越过置顶带与隐身窗口,第一个可见普通窗口 —— 是桌面 = 桌面
//     仍在顶;是应用 = 桌面已回落,把自己插到该应用之下,保证立即被盖住(NOTOPMOST 会落在
//     普通带顶端,反压在新唤起的全屏应用上,正是 v2 用户报告的残留症状)
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, GW_HWNDNEXT = 2, GW_HWNDPREV = 3, GWL_EXSTYLE = -20, WS_EX_TOPMOST = 0x8n;
let pinDeskTopmost = false; // 显示桌面态期间的临时置顶标记
function classNameOf(hwnd) {
  const api = pinApi();
  if (!hwnd || !api || !api.GetClassNameW) return '';
  try {
    const buf = new Uint16Array(64);
    const n = api.GetClassNameW(hwnd, buf, 64);
    return n > 0 ? String.fromCharCode(...buf.slice(0, n)) : '';
  } catch { return ''; }
}
function setPinTopmost(on) {
  const api = pinApi();
  if (!api || !api.SetWindowPos) return;
  try {
    const hwnd = hwndOf();
    if (hwnd) api.SetWindowPos(hwnd, on ? -1 : -2, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  } catch { /* 忽略瞬时抖动 */ }
}
function isDesktopCls(hwnd) {
  const cls = classNameOf(hwnd);
  return cls === 'Progman' || cls === 'WorkerW';
}
// 普通态入口判定:向上走,先遇桌面 = 盖板成立;先遇置顶带 = 桌面在下面
function findDesktopAbove() {
  const api = pinApi();
  const me = hwndOf();
  if (!api || !api.GetWindow || !api.GetWindowLongPtrW || !me) return null;
  try {
    let hwnd = me;
    for (let i = 0; hwnd && i < 120; i++) {
      hwnd = api.GetWindow(hwnd, GW_HWNDPREV);
      if (!hwnd) return false;                        // 走到顶:桌面在普通带之下
      if (BigInt(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) return false; // 到置顶带了
      if (isDesktopCls(hwnd)) return true;            // 桌面压在我们之上
    }
    return false;
  } catch { return null; }
}
// 置顶态出口判定:向下走,越过置顶带与隐身窗口,返回第一个可见普通窗口(0 = 没有)
function findBandTopVisible() {
  const api = pinApi();
  const me = hwndOf();
  if (!api || !api.GetWindow || !api.GetWindowLongPtrW || !api.IsWindowVisible || !me) return null;
  try {
    let hwnd = me;
    for (let i = 0; hwnd && i < 160; i++) {
      hwnd = api.GetWindow(hwnd, GW_HWNDNEXT);
      if (!hwnd) return 0;                            // 走到栈底:没有任何可见普通窗口
      if (BigInt(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST) continue;
      if (!api.IsWindowVisible(hwnd)) continue;       // MSCTFIME UI 等隐身窗不算
      return hwnd;
    }
    return 0;
  } catch { return null; }
}
function syncDesktopCover() {
  const api = pinApi();
  if (!api || !api.SetWindowPos) return;
  try {
    if (!pinDeskTopmost) {
      if (findDesktopAbove() === true) {
        // 前台是普通应用时不抬:用户在应用里(全屏游戏等),桌面盖板压着也无需现身;回桌面(前台变 shell/桌面)
        // 下个轮询周期自会抬起 —— 同时防住"跟前台落下→桌面仍在普通带顶→再抬起"的振荡
        if (foregroundDropTarget()) return;
        pinDeskTopmost = true;
        logPin('显示桌面态:桌面窗口盖板,临时置顶抬起', true);
        setPinTopmost(true);
      }
    } else {
      const top = findBandTopVisible();
      if (top === null) return;
      let drop = top;
      if (top && isDesktopCls(top)) {
        // 桌面仍是最高的普通窗时不再干等它让位:看前台 —— 前台已是普通可见应用(全屏游戏/应用被唤起,
        // 其窗口可能始终没升到桌面之上)就直接跟前台落,插到它之下
        drop = foregroundDropTarget();
        if (!drop) return;                            // 前台也在桌面/任务栏上:维持抬起
      }
      pinDeskTopmost = false;
      logPin(`桌面态结束:恢复普通层级,落回 ${classNameOf(drop) || '?'} 之下`, true);
      const me = hwndOf();
      if (drop && me) api.SetWindowPos(me, drop, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE); // 插到该应用之下
      else setPinTopmost(false);                      // 没有可见应用:常规摘除即可
    }
  } catch { /* 忽略瞬时抖动 */ }
}
// 置顶态出口第二判据:前台窗。用户唤起的普通应用即落点;前台是桌面/任务栏/置顶窗(Start 菜单、Overwolf)/
// 隐身窗时不作为。抬起期间我们自己就在置顶带,fg===me 或 fg 带置顶位都会被排除,不会自己落到自己下面
function foregroundDropTarget() {
  const api = pinApi();
  const me = hwndOf();
  if (!api || !api.GetForegroundWindow || !api.GetWindowLongPtrW || !api.IsWindowVisible || !me) return null;
  try {
    const fg = api.GetForegroundWindow();
    if (!fg || fg === me) return null;
    if (BigInt(api.GetWindowLongPtrW(fg, GWL_EXSTYLE)) & WS_EX_TOPMOST) return null;
    if (!api.IsWindowVisible(fg)) return null;
    if (isDesktopCls(fg)) return null;
    return fg;
  } catch { return null; }
}
let cloakTries = 0;
function logPin(msg, force) { // 保活动作留痕:最小化没被顶回时,看这份日志判断计时器是否在场/restore 是否失败
  const now = Date.now();
  if (!force && now - lastPinLog < 5000) return; // 5s 节流,防病态循环刷爆日志;状态迁移(force)必留痕
  lastPinLog = now;
  try { fs.appendFile(path.join(app.getPath('userData'), 'hide-log.txt'), `${new Date().toISOString()} pin: ${msg}\n`, () => {}); } catch { /* 忽略 */ }
}
// 顶回+补射:显示桌面状态下 shell 批量收尾时可能对刚 show 回来的窗口再补一刀,单次 show 会被吃掉 ——
// 0/250/700/1500ms 四次校验,期间任一刻发现不在桌面就再顶,把"顶回"钉死
function reassertBurst(reason) {
  for (const ms of [0, 250, 700, 1500]) setTimeout(() => {
    try {
      if (!win || win.isDestroyed() || !store.get('deskPin') || pinUserHidden) return;
      if (win.isMinimized()) { logPin(`顶回 restore(${reason} +${ms}ms)`); win.showInactive(); win.moveTop(); }
      else if (!win.isVisible()) { logPin(`顶回 show(${reason} +${ms}ms)`); win.showInactive(); win.moveTop(); }
    } catch { /* 忽略瞬时抖动 */ }
  }, ms);
}
function startPinKeepTop() {
  stopPinKeepTop();
  // 150ms 轮询兜底(Win+D 的外部 SW_HIDE 不派发事件,轮询是唯一可靠手段):被收起后最迟 150ms 回到桌面;
  // 两次轻量状态检查,无常驻开销
  pinTopTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return stopPinKeepTop();
    if (!store.get('deskPin') || pinUserHidden) return;
    try {
      if (win.isMinimized()) reassertBurst('定时器·被最小化');
      else if (!win.isVisible()) reassertBurst('定时器·被隐藏');
      else {
        // 显示桌面不改变任何可见性状态,只把桌面窗口盖上来 —— 专检这种"盖板"并临时置顶抬起
        syncDesktopCover();
        // 可见≠在桌面上:显示桌面态下被斗篷的窗口全套可见性检查都过,只有 DWM 属性能看出来
        const hwnd = hwndOf();
        if (hwnd && isCloaked(hwnd)) {
          cloakTries++;
          if (cloakTries === 1 || cloakTries % 8 === 0) logPin(`保活:揭开斗篷 cloak(第${cloakTries}次)`);
          uncloak(hwnd);
          win.moveTop();
          if (cloakTries === 3) { logPin('保活:斗篷未褪,show 周期强制重评估'); win.hide(); win.show(); win.moveTop(); }
        } else cloakTries = 0;
      }
    } catch { /* 忽略瞬时抖动 */ }
  }, 150);
}
function stopPinKeepTop() { if (pinTopTimer) { clearInterval(pinTopTimer); pinTopTimer = null; } }
function mountToDesktop() {
  try {
    // 钉在桌面=尺寸位置固定:面板可点可滚,但不能拖动/缩放;
    // setMinimizable(false) 排除最小化路径;Win+D 的"桌面窗口盖板"由轮询 syncDesktopCover 临时置顶对抗
    win.setMovable(false); win.setResizable(false); win.setMinimizable(false);
    win.setAlwaysOnTop(false); // 任何路径进图钉都不在置顶带(托盘/设置路径已设,这里兜底迷你+图钉组合等残留)
  } catch { /* 忽略 */ }
  pinUserHidden = false;
  win.show();
  startPinKeepTop();
  applyGlassCapture();
  applyGlassMaterial();
  return true;
}
function unmountFromDesktop() {
    stopPinKeepTop();
    if (pinDeskTopmost) { pinDeskTopmost = false; setPinTopmost(false); } // 摘掉显示桌面态的临时置顶
    try {
      if (win && !win.isDestroyed()) { win.setResizable(true); win.setMovable(true); win.setMinimizable(true); applyGlassCapture(); applyGlassMaterial(); }
    } catch { /* 窗口已销毁等情况,忽略 */ }
  }

// ---------- 毛玻璃底材:两条 OS 模糊链路 ----------
//  · 取景玻璃关 + frost/liquid:窗口不透明 + DWM 系统背板(backgroundMaterial),恒挂 acrylic(真模糊);
//    失焦由系统去饱和,渲染层加深打底(push:focus),不再切 mica(部分 24H2 上 mica 渲染成黑窗,形似被隐藏)。
//  · 透明窗口(取景玻璃开 / clear 主题):accent acrylic(SetWindowCompositionAttribute),失焦不失效;
//    但 Win11 24H2 起系统已移除该效果(调用成功、无视觉变化),仅 23H2 及以前有效。
const ACCENT_DISABLED = 0, ACCENT_ACRYLIC_BLURBEHIND = 3;
// ACCENT_POLICY → 16 字节小端裸内存:{AccentState:int32, AccentFlags:uint32, GradientColor:uint32, AnimationId:int32}
function accentPolicy(state, color) {
  const buf = Buffer.alloc(16);
  buf.writeInt32LE(state | 0, 0);
  buf.writeUInt32LE(0, 4);          // AccentFlags
  buf.writeUInt32LE(color >>> 0, 8);
  buf.writeInt32LE(0, 12);          // AnimationId
  return buf;
}
function applyGlassMaterial() {
  if (!win || win.isDestroyed()) return;
  // 系统背板链路:恒挂 acrylic。失焦切 mica 的方案废弃——部分 Win11 24H2 上 Electron+mica 直接渲染成黑/不渲染,
  // 窗口看起来像"凭空消失";acrylic 失焦只是系统级去饱和,配合渲染层失焦加深(push:focus)可读且始终可见
  if (wantsOsBackdrop()) {
    try { win.setBackgroundMaterial('acrylic'); } catch { /* 老系统无此 API */ }
    return;
  }
  // 透明窗口链路:accent acrylic(24H2- 有效)
  const wantBlur = !!acrylic();
  const api = pinApi();
  if (!api) return;
  try {
    const me = hwndOf();
    if (!me) return;
    api.SetWindowCompositionAttribute(me, accentPolicy(
      wantBlur ? ACCENT_ACRYLIC_BLURBEHIND : ACCENT_DISABLED,
      wantBlur ? 0x01000000 : 0, // 1% 深色,blur 本体由 CSS 底色负责
    ));
  } catch { /* 不支持则退化为纯透明窗口 */ }
}

// ---------- 取景玻璃:渲染层经 getDisplayMedia 直采桌面视频流(GPU 合成,零轮询零 IPC 大图) ----------
// 旧的 900ms 全屏截图轮询(每次 getSources 自带百毫秒级开销 + JPEG 编码 + dataURL 传渲染层整窗重绘)
// 会持续抢占主进程与合成器,导致启动慢、滚轮延迟高 —— 已改为常驻视频流;截图轮询仅作视频流失败时的兜底。
let glassTimer = null, glassBusy = false;

function applyGlassCapture() {
  // 取景玻璃开着时必须开内容保护:视频流拍到自己的窗口会形成反馈回路,越叠越黑
  const on = captureGlassOn();
  if (win && !win.isDestroyed()) { try { win.setContentProtection(on); } catch { /* 忽略 */ } }
}

function registerDisplayMedia() {
  // 自动放行渲染层的 getDisplayMedia:免选择器,直接选窗口所在显示器
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      const disp = (win && !win.isDestroyed()) ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
      const src = sources.find(s => s.display_id === String(disp.id)) || sources[0];
      if (src) callback({ video: src }); else callback({});
    }).catch(() => callback({}));
  });
}

async function pushGlassFrame() {
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return;
  if (glassBusy) return;
  glassBusy = true;
  try {
    const b = win.getBounds();
    const disp = screen.getDisplayMatching(b);
    const sf = disp.scaleFactor || 1;
    // 限幅:整屏截图总量控制在 ~2.2M 物理像素(模糊场景足够,控制 IPC 与内存开销)
    const pw = disp.size.width * sf, ph = disp.size.height * sf;
    const k = Math.min(1, Math.sqrt(2200000 / Math.max(1, pw * ph)));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(pw * k), height: Math.round(ph * k) },
    });
    const src = sources.find(s => s.display_id === String(disp.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return;
    const esf = sf * k; // 截图相对逻辑坐标的有效缩放
    const dim = src.thumbnail.getSize();
    const cx = Math.max(0, Math.min(Math.round((b.x - disp.bounds.x) * esf), dim.width - 2));
    const cy = Math.max(0, Math.min(Math.round((b.y - disp.bounds.y) * esf), dim.height - 2));
    const cw = Math.max(2, Math.min(Math.round(b.width * esf), dim.width - cx));
    const ch = Math.max(2, Math.min(Math.round(b.height * esf), dim.height - cy));
    let crop = src.thumbnail.crop({ x: cx, y: cy, width: cw, height: ch });
    if (cw > 640) crop = crop.resize({ width: 640 }); // 模糊后无需高分辨率
    if (win && !win.isDestroyed()) win.webContents.send('glass-frame', crop.toDataURL());
  } catch { /* 截屏偶发失败时保留上一帧 */ }
  finally { glassBusy = false; }
}

function startGlassFrameFallback() {
  stopGlassCapture();
  if (!captureGlassOn()) return;
  try { win.setContentProtection(true); } catch { /* 排除自身,防止取到自己的画面造成递归 */ }
  glassTimer = setInterval(pushGlassFrame, 900);
  setTimeout(pushGlassFrame, 120);
}

function stopGlassCapture() {
  if (glassTimer) { clearInterval(glassTimer); glassTimer = null; }
  if (win && !win.isDestroyed()) { try { win.setContentProtection(false); } catch { /* 忽略 */ } }
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  pinUserHidden = false; // 用户唤回:图钉定时器恢复自动顶回
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop(); // 仅 focus 可能被前台锁定策略拒绝,moveTop 保证置前提至最前
  win.focus();
  if (store.get('deskPin')) startPinKeepTop(); // 自愈:托盘唤回时确保保活计时器在场
}

function setMini(mini, opts = {}) {
  store.set('mini', mini);
  if (!win || win.isDestroyed()) return;
  applyModeBounds(); // 先放宽/收紧尺寸范畴,再 setBounds,否则被旧 max 钳住
  if (mini) {
    miniBounds = win.getBounds(); // 用当前实际尺寸还原,避免保存延迟导致尺寸过期
    win.setBounds({ x: miniBounds.x, y: miniBounds.y, ...MINI_SIZE });
    win.setSkipTaskbar(true);
    win.setAlwaysOnTop(true);
  } else {
    const b = win.getBounds();
    const ob = opts.keepCurrent
      ? { width: Math.max(NORM_BOX.min.width, b.width), height: Math.max(NORM_BOX.min.height, b.height) }
      : (miniBounds || store.get('bounds') || { width: 380, height: 700 });
    win.setBounds({ x: b.x, y: b.y, width: ob.width || 380, height: ob.height || 700 });
    miniBounds = null;
    win.setSkipTaskbar(!!store.get('hideTaskbar') || !!store.get('deskPin'));
    win.setAlwaysOnTop(!!store.get('onTop')); // 迷你条强制置顶是临时行为,退出迷你须恢复用户的置顶设置(图钉模式下始终不置顶)
    if (opts.keepCurrent && !isShot) store.set('bounds', win.getBounds()); // 拖拽还原的新尺寸要持久化;截图模式不落盘
  }
  win.webContents.send('push:settings', store.all());
  win.webContents.send('push:mini', mini);
  if (storeTrayRebuild) storeTrayRebuild(); // 同步托盘"迷你模式"勾选
}

// ---------- 更新检测(GitHub Releases) ----------
// 仓库转公开前 API 会 404:状态置 unavailable,设置页如实显示"暂无法检测",不弹窗不打扰。
// 弹窗策略:启动自动检测发现新版时每个版本只弹一次(updateSeen);手动检测只在设置页显示结果
const UPD = { repo: 'likeravine233/RainyWatch', state: 'idle', version: '', url: '', canInstall: false, notes: null };
// release 说明首行约定为「中文代号|寄语」,是版本代号/寄语的在线通道:复用 releases/latest
// 的既有响应解析,零新增请求;解析失败静默回退应用内 RELEASE_NOTES,不发版也能修订文案
function parseRelNotes(body) {
  const line = String(body || '').split('\n').map(s => s.trim()).find(Boolean) || '';
  const m = line.match(/^([^|\n]{1,24})\|(.{1,200})$/);
  return m ? { code: m[1].trim(), quote: m[2].trim() } : null;
}
// 一键更新状态机:idle→downloading→verifying→ready(重启生效)|error;进度走 push:upd-dl 专用通道,payload 只带快照
const UPDDL = { phase: 'idle', received: 0, total: 0, msg: '' };
const updDlPush = () => { if (win && !win.isDestroyed()) win.webContents.send('push:upd-dl', { ...UPDDL }); };
const verNums = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
function newerVer(a, b) { // a 是否比 b 新(三段数字逐段比)
  const x = verNums(a), y = verNums(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
function ghGet(url) { // GitHub API 小助手:gzip + UA;不走 fetcher 的 LP 限速队列,两套节奏互不干扰
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'RainyWatch-Updater', 'Accept': 'application/vnd.github+json', 'Accept-Encoding': 'gzip' }, timeout: 10000 }, (res) => {
      const chunks = [];
      const stream = /^gzip/.test(res.headers['content-encoding'] || '') ? zlib.createGunzip() : res;
      if (stream !== res) res.pipe(stream);
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
async function checkUpdate(manual) {
  lastUpdCheckAt = Date.now();
  if (process.env.RW_UPD_DEMO) { // 审阅用临时钩子(发布打包前删除):伪造"有新版本",走与真实完全相同的展示路径;不发请求、不写 updateSeen
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
  if (win && !win.isDestroyed() && win.isVisible() && !store.get('mini') && !mouseLocked) {
    win.webContents.send('push:upd-dialog', { version: UPD.version, url: UPD.url, canInstall: UPD.canInstall, notes: UPD.notes });
    return;
  }
  dialogShowUpdate();
}

// ---------- 一键更新:应用内下载 → SHA256 校验 → 退出后由助手脚本换文件并重启 ----------
// 便携包无法在运行中覆盖自己:把新 exe 下到临时目录,校验通过后落一个 PowerShell 助手,
// 它等本进程退出 → 拷贝覆盖原 exe → 重新拉起。仓库私有期间 release 拉不到,按钮自然不出现。
function ghDownload(url, dest, onProg) { // 下载 release 资产(跟随最多 3 次重定向);onProg(已收, 总长)
  return new Promise((resolve, reject) => {
    const go = (u, n) => {
      if (n > 3) return reject(new Error('redirect'));
      const req = https.get(u, { headers: { 'User-Agent': 'RainyWatch-Updater' }, timeout: 15000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return go(res.headers.location, n + 1); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'], 10) || 0;
        if (total > 220 * 1024 * 1024) { res.resume(); return reject(new Error('size')); } // 便携包远小于此,防呆
        const f = fs.createWriteStream(dest);
        let got = 0;
        res.on('data', (c) => { got += c.length; if (onProg) onProg(got, total); });
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve(got)));
        f.on('error', (e) => { try { fs.rmSync(dest, { force: true }); } catch { } reject(e); });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    };
    go(url, 0);
  });
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
    UPDDL.phase = 'ready'; UPDDL.msg = exePath; updDlPush();
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
  if (!win || win.isDestroyed()) return;
  dialog.showMessageBox(win, {
    type: 'info', title: ui('upd.dlg.title'), message: ui('upd.dlg.title'),
    detail: ui('upd.dlg.msg', { v: UPD.version }),
    buttons: [ui('upd.dlg.go'), ui('upd.dlg.later')], defaultId: 0, cancelId: 1, noLink: true,
  }).then((r) => { if (r.response === 0 && UPD.url) shell.openExternal(UPD.url); });
}
// ---------- 全量队伍池(LP/Panda/VRS 供数,比赛条目规范字段的唯一出处) ----------
// payload() 每次组装都过一遍:各源并入池子→把规范名/href/队标/VRS 装饰到三区条目→内容有变才回写 store(跨启动保留)
let _pool = null, _poolSaved = '', _aliasSaved = '';
function poolSync() {
  if (_pool == null) { // 启动首轮:池子与学习别名一起回灌,保证重启后第一次装饰就已归并
    _pool = store.get('teamPool') || {};
    loadAliasCanon(store.get('teamAlias'));
    for (const e of Object.values(_pool)) { // 存量池自愈:带 LP 页链的历史劈叉键(展示名键≠页链身份键)立即归并,不等行重现
      if (e && e.name && e.href) learnAlias(_pool, e);
    }
    _aliasSaved = JSON.stringify(aliasCanon());
  }
  enrichFromRankings(_pool, data.rankings);
  enrichFromMatches(_pool, data.matches); // LP 行页链顺带学「展示名键→页链身份键」别名(LG↔Luminosity 实例)
  capPool(_pool, 800);
  decorateMatches(data.matches, _pool);
  const j = JSON.stringify(_pool);
  if (j !== _poolSaved) { _poolSaved = j; store.set('teamPool', JSON.parse(j)); }
  const ja = JSON.stringify(aliasCanon());
  if (ja !== _aliasSaved) { _aliasSaved = ja; store.set('teamAlias', JSON.parse(ja)); }
}
function pushData() {
  if (win && !win.isDestroyed()) win.webContents.send('push:data', payload());
}
const gpuStatus = () => { try { return app.getGPUFeatureStatus(); } catch { return null; } }; // 调试面板诊断软渲染(gpu_compositing=disabled_software=整窗 CPU 光栅)
function payload() {
  tierArchiveLoad(); // 换表后挂回评级归档(幂等,顺带按级别剪枝)
  matchArchiveLoad(); // 同上,赛果档案
  poolSync(); // 队伍池:并入各源供数,规范字段装饰到比赛条目(幂等)
  decorateEvents(); // 赛事池:Panda 系行换装 LP 赛事名/页链/图标,评级徽章随之恢复(幂等)
  return {
    data,
    version: app.getVersion(),
    meta: { ...meta, newTransferIds, wanjiqi, sync: syncPhase, update: { state: UPD.state, version: UPD.version, url: UPD.url, canInstall: UPD.canInstall, notes: UPD.notes, dl: { ...UPDDL } } },
    settings: store.all(),
    acrylicSupported,
    gpu: gpuStatus(),
    glassCaptureActive: captureGlassOn(),
    maps: shotMapPool || store.get('mapPool') || {},
  };
}

// ---------- 托盘 ----------
// 隐藏来源日志:幽灵隐藏(用户报告"窗口自己藏起来")难以复现,把每条 hide 路径落盘便于定位
function logHide(src) {
  try { fs.appendFile(path.join(app.getPath('userData'), 'hide-log.txt'), `${new Date().toISOString()} hide via ${src}\n`, () => {}); } catch { /* 忽略 */ }
}

// ---------- Win11 语境菜单:右键用无边框小窗自绘 UWP 风菜单;Win10/更老或创建失败回落原生 Menu ----------
// 界面语言文案(设置 lang 驱动):托盘菜单/系统通知/标题随之切换;store 未就绪前默认中文
const uiLang = () => (store && store.get('uiLang')) || 'zh'; // 界面语言独立设置,界面只管界面(赛事文本用 lang)
const ui = (k, vars) => { let x = I18N.uit(k, uiLang()); if (vars) for (const [q, v] of Object.entries(vars)) x = x.split('{' + q + '}').join(String(v)); return x; };

const MODERN_TRAY = process.platform === 'win32' && osBuild >= 22000; // Win11 起系统语境菜单为圆角+亚克力风格
const MENU_W = 252, MENU_ROW = 34, MENU_SEP = 9, MENU_PAD = 12, MENU_STAR = 48; // PAD=上下 5px 内边距+1px 描边×2;STAR=求Star行高(对话框+水月探头,作为普通菜单行嵌在开机自启上方)
let trayMenuWin = null, trayMenuOpen = false, lastAutoHide = 0, mouseLocked = false; // mouseLocked:鼠标穿透锁(托盘切换);最近一次因失焦被藏的时间:右键托盘会先让菜单失焦被藏,再触发 right-click
let trayReveal = null, trayRevealTimer = null; // 待弹菜单的位姿与兜底定时器:菜单页画完回执 ready 才 show(先画后弹)
const trayItems = () => [
  { id: 'toggle', label: ui('tray.toggle'), type: 'action' },
  { id: 'mini', label: ui('tray.mini'), type: 'checkbox', checked: !!store.get('mini') },
  { id: 'onTop', label: ui('tray.ontop'), type: 'checkbox', checked: !!store.get('onTop') },
  { id: 'deskPin', label: ui('tray.deskpin'), type: 'checkbox', checked: !!store.get('deskPin') },
  { id: 'hideTaskbar', label: ui('tray.hidebar'), type: 'checkbox', checked: !!store.get('hideTaskbar') },
  { id: 'lock', label: ui(mouseLocked ? 'tray.unlock' : 'tray.lock'), type: 'action' }, // 锁定后窗口不响应鼠标,本项是唯一出口
  { type: 'separator' },
  { id: 'refresh', label: ui('tray.refresh'), type: 'action' },
  { id: 'wanjiqi', label: ui('tray.wanjiqi'), type: 'action' },
  { type: 'separator' },
  { id: 'star', type: 'star', label: ui('tray.star') }, // 求Star行:对话框+水月探头,整行可点跳仓库主页(嵌在开机自启上方,不抢最后一项=退出;label 供旧系统原生菜单兜底)
  { id: 'autostart', label: ui('tray.autostart'), type: 'checkbox', checked: !!store.get('autostart') },
  { id: 'quit', label: ui('tray.quit'), type: 'action' },
];
const trayData = () => ({ theme: store.get('theme') || 'clear', acrylic: acrylicSupported, lang: uiLang(), items: trayItems() }); // 配色随应用主题(tray-menu 页按 theme 取色);lang 驱动求Star气泡的双语切换
// 菜单窗底色与 tray-menu.html 的 --bg 对齐:acrylic 背板 hide→show 后重挂前的空帧显示底色而不是白
const TRAY_BG = {
  clear: '#0e1118', frost: '#0f121b', liquid: '#111524', tactical: '#0e120a',
  versus: '#0c0d12', crt: '#030704', poster: '#f6f3ea', printstream: '#fbfaf7', blue: '#eef3fa',
};
const trayBg = () => TRAY_BG[store.get('theme')] || '#0e1118';

// 原生下拉弹窗的深浅:页内 color-scheme/option 样式在部分 Win11 弹窗上吃不到,系统 NativeTheme 是硬开关
const LIGHT_THEMES = ['perfect', 'poster', 'printstream', 'blue'];
function syncNativeTheme() { try { nativeTheme.themeSource = LIGHT_THEMES.includes(store.get('theme')) ? 'light' : 'dark'; } catch { } }
const menuHeight = (items) => MENU_PAD + items.reduce((h, it) => h + (it.type === 'separator' ? MENU_SEP : it.type === 'star' ? MENU_STAR : MENU_ROW), 0);

function createTrayMenuWin() {
  try {
    trayMenuWin = new BrowserWindow({
      width: MENU_W, height: 100, frame: false, show: false, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      alwaysOnTop: true, hasShadow: false, transparent: !acrylicSupported,
      backgroundColor: acrylicSupported ? trayBg() : '#00000000', // 透明路径必须全透明;acrylic 路径用主题底色防空帧白闪
      ...(acrylicSupported ? { backgroundMaterial: 'acrylic' } : {}), // 22H2+ 系统亚克力托底;页面再画主题色层+自绘圆角
      webPreferences: { preload: path.join(__dirname, 'src', 'tray-preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }, // 节流关掉:窗口隐藏期间也要渲染帧(预热内容,先画后弹)
    });
    trayMenuWin.setAlwaysOnTop(true, 'screen-saver'); // 档位需高于主窗的 floating
    trayMenuWin.on('blur', hideTrayMenu);
    // hide→show 后 DWM 会丢 acrylic 背板(表现为托盘旁整窗闪白底),show 后立即补挂
    trayMenuWin.on('show', () => { if (acrylicSupported) { try { trayMenuWin.setBackgroundMaterial('acrylic'); } catch { } } });
    trayMenuWin.loadFile(path.join(__dirname, 'src', 'tray-menu.html'));
    trayMenuWin.webContents.on('did-finish-load', () => trayMenuWin.webContents.send('tray-menu:data', trayData())); // 无条件预热的兜底:菜单页晚加载/开菜单前主题切换都不空白
  } catch { trayMenuWin = null; } // 创建失败不影响托盘:右键回落原生
}

function hideTrayMenu() {
  if (trayMenuOpen) lastAutoHide = Date.now(); // 记录"因这次交互被藏"的时刻,供 toggleTrayMenu 识别
  trayMenuOpen = false;
  trayReveal = null; clearTimeout(trayRevealTimer); trayRevealTimer = null; // 撤销还没 show 的待弹菜单
  if (trayMenuWin && !trayMenuWin.isDestroyed() && trayMenuWin.isVisible()) trayMenuWin.hide();
  // 白闪根因:窗口 hide→show 会丢 acrylic 背板,重挂回来前的第一帧是白的。用完即毁、后台重建,
  // 下次右键拿到的是"从未 hide 过"的新窗 —— 与首次右键(无白闪)完全相同的体验
  if (trayMenuWin && !trayMenuWin.isDestroyed()) {
    const old = trayMenuWin;
    trayMenuWin = null;
    setImmediate(() => { try { old.destroy(); } catch { } if (!quitting) createTrayMenuWin(); }); // quitting 中重建菜单窗会顶住 app.quit,进程关不掉只能任务管理器杀
  }
}

function toggleTrayMenu() {
  try {
    if (trayMenuOpen) { hideTrayMenu(); return; } // 连续右键=开/关(失焦尚未处理时的兜底)
    if (Date.now() - lastAutoHide < 350) { lastAutoHide = 0; return; } // 刚因这次右键失焦被藏:本次视作"关闭",不再重开(与其他应用一致)
    if (!trayMenuWin || trayMenuWin.isDestroyed()) createTrayMenuWin();
    if (!trayMenuWin) throw new Error('menu win unavailable');
    const items = trayItems(), H = menuHeight(items);
    const cur = screen.getCursorScreenPoint(), wa = screen.getDisplayNearestPoint(cur).workArea;
    let x = Math.round(cur.x - 14), y = Math.round(cur.y - H - 10); // 菜单右缘贴光标上方,同系统语境菜单习惯
    if (x + MENU_W > wa.x + wa.width) x = wa.x + wa.width - MENU_W - 4;
    if (x < wa.x) x = wa.x;
    if (y < wa.y) y = Math.min(wa.y + wa.height - H - 4, Math.round(cur.y) + 24); // 光标贴顶(任务栏在上)则改弹下方
    if (acrylicSupported) { try { trayMenuWin.setBackgroundColor(trayBg()); } catch { } } // 主题可能已切换
    // 先画后弹:数据发给隐藏中的菜单窗,页面画完回执 ready 再落位 show。旧流程 send 完立刻 show,
    // 首帧常是"空菜单壳"(条目还没渲染),观感即"闪一下才出字,闪时顶部一条黑"(空 .menu 的底色+描边)
    trayReveal = { x, y, h: H };
    trayMenuWin.webContents.send('tray-menu:data', trayData());
    clearTimeout(trayRevealTimer);
    trayRevealTimer = setTimeout(revealTrayMenu, 220); // 页面异常不回执时兜底,退化为旧时序
  } catch { // 自绘菜单任何异常都回落原生菜单,右键功能不能丢
    hideTrayMenu();
    try { if (tray && !tray.isDestroyed() && trayMenu) tray.popUpContextMenu(trayMenu); } catch { }
  }
}

function revealTrayMenu() { // 菜单页画完(tray-menu:ready 回执)或 220ms 兜底到点:落位再 show
  clearTimeout(trayRevealTimer); trayRevealTimer = null;
  const b = trayReveal; trayReveal = null;
  if (!b) return;
  try {
    if (!trayMenuWin || trayMenuWin.isDestroyed()) return;
    trayMenuWin.setBounds({ x: b.x, y: b.y, width: MENU_W, height: b.h });
    trayMenuWin.show();
    trayMenuWin.focus(); // 聚焦以支持失焦即关 + Esc 关闭
    trayMenuOpen = true;
  } catch { // 自绘菜单任何异常都回落原生菜单,右键功能不能丢
    hideTrayMenu();
    try { if (tray && !tray.isDestroyed() && trayMenu) tray.popUpContextMenu(trayMenu); } catch { }
  }
}

function runTrayAction(id) { // 与原原生菜单 click 处理器逐条等价(重构自旧模板)
  if (id === 'toggle') { if (win && !win.isDestroyed() && win.isVisible()) { pinUserHidden = true; win.hide(); logHide('tray-menu'); } else showWindow(); } // 显隐=纯可见性翻转:菜单弹出期间焦点在菜单窗,旧 isFocused() 条件令"隐藏"分支永远不可达(点无效)
  else if (id === 'mini') setMini(!store.get('mini'));
  else if (id === 'onTop') {
    const checked = !store.get('onTop'); const wasPinned = store.get('deskPin');
    store.set('onTop', checked); if (checked) store.set('deskPin', false);
    if (win && !win.isDestroyed()) { win.setAlwaysOnTop(checked); if (checked) win.setSkipTaskbar(store.get('hideTaskbar') || store.get('mini')); if (checked && wasPinned) { unmountFromDesktop(); showWindow(); } }
    pushSettings();
  }
  else if (id === 'deskPin') {
    const checked = !store.get('deskPin');
    store.set('deskPin', checked); if (checked) store.set('onTop', false);
    if (win && !win.isDestroyed()) { win.setAlwaysOnTop(false); win.setSkipTaskbar(checked || store.get('hideTaskbar') || store.get('mini')); if (checked) mountToDesktop(); else { unmountFromDesktop(); showWindow(); } }
    pushSettings();
  }
  else if (id === 'hideTaskbar') { const checked = !store.get('hideTaskbar'); store.set('hideTaskbar', checked); if (win && !win.isDestroyed() && !store.get('mini')) win.setSkipTaskbar(checked); pushSettings(); }
  else if (id === 'lock') { // 切换锁定:锁上后窗口完全穿透(点不到任何 UI),解锁只能回到托盘点本项
    mouseLocked = !mouseLocked;
    if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(mouseLocked); win.webContents.send('push:locked', mouseLocked); }
  }
  else if (id === 'refresh') bootstrapData();
  else if (id === 'star') shell.openExternal('https://github.com/likeravine233/RainyWatch'); // 托盘水月/求Star气泡:点小人和对话框都跳仓库主页
  else if (id === 'wanjiqi') shell.openExternal('https://www.douyu.com/6657');
  else if (id === 'autostart') { store.set('autostart', !store.get('autostart')); applyAutoLaunch(); }
  else if (id === 'quit') { quitting = true; app.quit(); return; }
  if (storeTrayRebuild) storeTrayRebuild(); // 刷新两套菜单(原生模板/开着的自绘菜单)的勾选态
}

ipcMain.on('tray-menu:click', (e, id) => { hideTrayMenu(); if (typeof id === 'string' && id) runTrayAction(id); });
ipcMain.on('tray-menu:ready', () => { if (trayReveal) revealTrayMenu(); }); // 菜单页每画完一帧数据回执一次;仅在有待弹菜单时生效
ipcMain.on('tray-menu:hide', hideTrayMenu);

function makeTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('RainyWatch · 小暴雨助手');
  const rebuild = () => {
    trayMenu = Menu.buildFromTemplate(trayItems().map((it) => it.type === 'separator'
      ? { type: 'separator' }
      : { label: it.label, type: it.type === 'checkbox' ? 'checkbox' : 'normal', checked: !!it.checked, click: () => runTrayAction(it.id) }));
    if (!tray || tray.isDestroyed()) return;
    if (MODERN_TRAY) { // Win11:原生菜单不挂载(挂了会拦截右键事件),有开着的自绘菜单就同步勾选态
      if (trayMenuOpen && trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.webContents.send('tray-menu:data', trayData());
    } else tray.setContextMenu(trayMenu); // 重建后必须重新挂载,否则右键无菜单
  };
  rebuild();
  // 单击托盘固定=唤出并置前。旧切换逻辑有误触:窗口被其他窗口完全遮挡时 isVisible() 仍为 true,
  // 此时点击托盘反而把窗口藏起来,用户感知就是"点了没反应,再点一下才出来"。
  tray.on('click', () => showWindow());
  if (MODERN_TRAY) { tray.on('right-click', () => toggleTrayMenu()); createTrayMenuWin(); } // Win11:右键弹自绘 UWP 风菜单;旧系统保持原生 setContextMenu
  storeTrayRebuild = rebuild;
}
let storeTrayRebuild = null;
let trayMenu = null; // 最近一次构建的托盘菜单(探针验证勾选同步用)

function applyAutoLaunch() {
  try {
    app.setLoginItemSettings({ openAtLogin: store.get('autostart'), path: process.execPath });
  } catch { }
}

// 解除鼠标穿透(渲染层双击或托盘操作)
ipcMain.on('glass-fallback', () => startGlassFrameFallback()); // 视频流采集失败→回落低频截图帧
ipcMain.on('unlock', () => {
  mouseLocked = false; // 与托盘标签保持同步
  if (win && !win.isDestroyed()) { win.setIgnoreMouseEvents(false); win.webContents.send('push:locked', false); if (storeTrayRebuild) storeTrayRebuild(); }
});
ipcMain.on('app:quit', () => { quitting = true; app.quit(); });

// ---------- IPC ----------
ipcMain.handle('get:initial', () => payload());
// 手动刷新(题头同步点)冷却:bootstrapData 是 4 个页面 + 图序采集的串行队列,
// 连点会把整条队列反复堆进共享限速器,容易触发 Liquipedia 封禁。30s 冷却 + 重入保护。
let lastManualRefreshAt = 0;
const REFRESH_CD = 30e3;
ipcMain.on('refresh', (e) => {
  const now = Date.now();
  if (booting) { try { e.sender.send('push:refresh-denied', { wait: -1 }); } catch { } return; }
  const waitSec = Math.ceil((lastManualRefreshAt + REFRESH_CD - now) / 1000);
  if (waitSec > 0) { try { e.sender.send('push:refresh-denied', { wait: waitSec }); } catch { } return; }
  lastManualRefreshAt = now;
  bootstrapData();
  setTimeout(() => { if (!isShot) checkUpdate(false); }, 5000); // 启动 5s 后首查更新:有新版亮题头角标(弹窗每版本一次)
});
ipcMain.on('open-external', (e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.on('win:hide', () => { if (win && !win.isDestroyed()) { pinUserHidden = true; win.hide(); logHide('ipc-win-hide'); } });
ipcMain.on('set:mini', (e, m) => setMini(!!m));
// 尺寸预设:mini=迷你条;s=小卡(只留主卡+接下来几场);m=标准;l=大窗(更多行、更大字号)
const SIZE_PRESETS = { s: { width: 300, height: 420 }, m: { width: 380, height: 700 }, l: { width: 480, height: 900 } };
ipcMain.on('set:size', (e, preset) => {
  if (preset === 'mini') { store.set('sizePreset', 'mini'); setMini(true); return; }
  const b = SIZE_PRESETS[preset];
  if (!b) return;
  store.set('sizePreset', preset);
  if (store.get('mini')) setMini(false);
  if (win && !win.isDestroyed()) {
    applyModeBounds();
    win.setBounds({ ...b });
    win.webContents.send('push:settings', store.all());
  }
});
ipcMain.on('transfers-seen', () => {
  const rows = data.transfers || [];
  if (rows.length) store.set('lastSeenTransferId', rows[0].id);
  newTransferIds = [];
  pushData();
});
ipcMain.on('set:setting', (e, kv) => {
  if (!kv || typeof kv !== 'object') return;
  const transModeBefore = transMode(); // transparent 是创建期属性:改设置前先记下档位
  for (const [k, v] of Object.entries(kv)) {
    store.set(k, v);
    if (k === 'autostart') applyAutoLaunch();
    if (k === 'onTop' && v && store.get('deskPin')) { // 置顶与图钉互斥:开置顶则退出图钉并解除桌面挂载
      store.set('deskPin', false);
      if (win && !win.isDestroyed()) {
        unmountFromDesktop();
        win.setSkipTaskbar(!!store.get('hideTaskbar') || store.get('mini'));
        showWindow();
      }
    }
    if (k === 'onTop' && win && !win.isDestroyed()) win.setAlwaysOnTop(!!v);
    // 图钉=钉在桌面:挂进壁纸层 WorkerW,任何"显示桌面"都动不了它
    if (k === 'deskPin') {
      if (v) store.set('onTop', false);
      if (win && !win.isDestroyed()) {
        win.setAlwaysOnTop(false);
        win.setSkipTaskbar(!!v || store.get('hideTaskbar') || store.get('mini'));
        if (v) mountToDesktop();
        else { unmountFromDesktop(); showWindow(); } // 解除图钉:回到普通窗口并提到最前
      }
    }
    // 不占任务栏:实时生效;迷你模式本来就不占任务栏,恢复时按设置决定
    if (k === 'hideTaskbar' && win && !win.isDestroyed() && !store.get('mini')) win.setSkipTaskbar(!!v || store.get('deskPin'));
  }
  const onlyCollapsed = Object.keys(kv).length === 1 && 'collapsedSections' in kv; // 折叠持久化:渲染层已本地生效,回推会整树重建、杀掉折叠过渡动画
  if ('theme' in kv) syncNativeTheme();
  if ('theme' in kv || 'captureGlass' in kv) {
    applyGlassMaterial(); // 档位内换主题:accent/背板实时重挂即可
    applyGlassCapture();
    if (transMode() !== transModeBefore) recreateWindow(); // 只有透明档位变了(玻璃主题进出/取景玻璃开关)才重建窗口
    else if (win && !win.isDestroyed()) win.webContents.send('push:settings', store.all());
  }
  else if (win && !win.isDestroyed() && !onlyCollapsed) win.webContents.send('push:settings', store.all());
  if (storeTrayRebuild) storeTrayRebuild(); // 置顶/不占任务栏等在托盘有对应勾选,保持同步
});

// ---------- 关注(高光选手/队伍) ----------
ipcMain.handle('search:players', async (e, q) => {
  const query = String(q || '').trim().slice(0, 40);
  // 双源合并:PandaScore 优先(带当前队伍,免二次解析),LP opensearch 始终并入——
  // 教练/分析员等角色 PandaScore 不收录(zonic/xtqzzz 实测),旧逻辑只在 Panda 空手时才问 LP,全职教练永远搜不出
  const token = store.get('pandaToken');
  const items = [];
  let pandaErr = false;
  if (token) {
    try { items.push(...await searchPandaPlayers(query, token)); }
    catch { pandaErr = true; /* token 失效/配额尽/网络问题 */ }
  }
  let lpErr = null;
  try {
    const seen = new Set(items.map(j => String(j.title || '').toLowerCase()));
    for (const it of await searchPlayers(query)) {
      const key = String(it.title || '').toLowerCase();
      if (!key || seen.has(key)) continue; // 同人双源去重(Panda 游戏名 vs LP 页名,大小写归一)
      seen.add(key);
      items.push(it);
    }
  } catch (err) { lpErr = err; }
  if (!items.length) {
    if (lpErr && (pandaErr || !token)) return { items: [], err: String(lpErr.message || lpErr) };
    return { items: [], err: '' };
  }
  for (const it of items.slice(0, 8)) cacheUpsertPlayer({ title: it.title, slug: it.slug || '', href: it.href || '', team: it.team || '', teamSlug: it.teamSlug || '', source: it.slug ? 'panda' : 'lp' });
  pushSettings(); // 缓存更新同步渲染层:下次输入的本地即时建议立刻可见
  return { items: items.slice(0, 8), err: '' };
});
ipcMain.handle('copy-text', (e, t) => { clipboard.writeText(String(t ?? '').slice(0, 500)); return true; });
ipcMain.handle('upd:check', () => checkUpdate(true));
ipcMain.handle('upd:install', () => updInstall());
ipcMain.handle('upd:apply', () => updApplyRestart());

// 回合级比分数据源(可选)
ipcMain.handle('set:panda', async (e, token) => {
  store.set('pandaToken', String(token || '').trim());
  if (!store.get('pandaToken')) return { ok: true };
  const err = await enrichLive();
  return err ? { ok: false, err } : { ok: true };
});

// Twitch 开播检测凭证(可选):仅存本机;保存后立即换发 app token 试跑一轮,尽快点亮/熄灭英文主播绿点
ipcMain.handle('set:twitch', async (e, v) => {
  const id = String((v && v.id) || '').trim(), secret = String((v && v.secret) || '').trim();
  store.set('twitchClientId', id);
  store.set('twitchSecret', secret);
  twitchTok = null; // 凭证已变,弃用缓存的 app token
  streamerStatus.twitchOn = !!(id && secret);
  if (!streamerStatus.twitchOn) for (const s of streamerStatus.list) if (s.platform === 'twitch') { s.live = false; s.coolUntil = 0; }
  if (win && !win.isDestroyed()) win.webContents.send('push:streamers', streamerStatus);
  if (streamerStatus.twitchOn && !streamerPolling) refreshStreamers().catch(() => { });
  return { ok: true };
});

ipcMain.handle('star:add-player', async (e, { name, href, slug: slugIn, pandaTeam, pandaTeamSlug, hintTeam, hintHref }) => {
  // PandaScore 来源:slug + 当前队伍已随搜索结果带出,无需再爬 Liquipedia 选手页
  const slug = String(slugIn || '') || slugOf(href);
  if (!slug) return { ok: false };
  const list = store.get('starPlayers') || [];
  const dup = (s) => String(s || '').toLowerCase();
  const exist = list.find(p => dup(p.id) === dup(slug) || (name && dup(p.name) === dup(name)));
  if (exist) {
    // 重复关注不做白回:缺状态/出错/超 24h 的旧条目顺手补解析(用户重复关注常就是想"刷新")
    if (exist.status === undefined || exist.err || Date.now() - (exist.resolvedAt || 0) > 24 * 3600e3) resolvePlayer(exist);
    return { ok: true, dup: true };
  }
  const entry = {
    id: slug, name: name || slug, href: href || '',
    team: pandaTeam || hintTeam || '', teamSlug: pandaTeam ? String(pandaTeamSlug || '') : hintTeam ? slugOf(hintHref) : '',
    panda: !!pandaTeam,
    resolvedAt: (pandaTeam || hintTeam) ? Date.now() : 0,
    resolving: true, // 队伍/状态解析在途:列表先亮"正在同步中",不闪"未解析到队伍"(完成/失败时落位)
  };
  list.push(entry);
  store.set('starPlayers', list);
  pushSettings();
  resolvePlayer(entry); // 队伍未知才需要解析;已知也要拉 Status——下放不离队的选手只有选手页 Status 行能看出来
  return { ok: true };
});
ipcMain.on('star:remove-player', (e, id) => {
  store.set('starPlayers', (store.get('starPlayers') || []).filter(p => p.id.toLowerCase() !== String(id).toLowerCase()));
  pushSettings();
});
ipcMain.handle('star:add-team', (e, { name, href }) => {
  const slug = slugOf(href) || name;
  if (!slug) return { ok: false };
  const list = store.get('starTeams') || [];
  if (list.some(t => (t.id || '').toLowerCase() === slug.toLowerCase())) return { ok: true, dup: true };
  list.push({ id: slug, name: name || slug, href: href || '' });
  store.set('starTeams', list);
  pushSettings();
  checkReminders();
  return { ok: true };
});
ipcMain.on('star:remove-team', (e, id) => {
  store.set('starTeams', (store.get('starTeams') || []).filter(t => (t.id || '').toLowerCase() !== String(id).toLowerCase()));
  pushSettings();
});

// ---------- 截图验证模式(--shot=clear,frost,liquid [--mock] [--extra]) ----------
async function runShots() {
  const outDir = path.join(__dirname, '_dev', 'shots');
  fs.mkdirSync(outDir, { recursive: true });
  const extra = process.argv.includes('--extra');
  const langEn = process.argv.includes('--lang=en'); // 整轮英文界面截图:产物文件名加 en- 前缀,结束恢复中文
  const setView = (process.argv.find((a) => a.startsWith('--setview=')) || '').split('=')[1] || ''; // 设置面板截图前滚到的分区(如 theme)
  const shotWait = parseInt((process.argv.find((a) => a.startsWith('--wait=')) || '').split('=')[1], 10) || 3500; // 主题载入后等待毫秒;拍真实数据(不带 --mock)时加 --wait=55000 等首抓落定
  // 快照 store 文件原文:必须在任何 store 变更之前读取——放后的话 bootstrap 注入的演示星标已随该次 save() 落盘,快照带着演示数据,还原等于没还
  try { preShotStoreFile = fs.readFileSync(store.file, 'utf8'); } catch { preShotStoreFile = null; }
  const themes = shotThemes.split(',').filter(Boolean);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  win.setBounds({ width: 440, height: 830 }); await sleep(400); // 固定取景尺寸,不随用户上次窗口大小漂移
  store.set('collapsedSections', {}); // 截图展开全部分区(用户的真实折叠偏好在结束时随文件快照还原)
  const snap = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, (langEn ? 'en-' : '') + name + '.png'), img.toPNG());
    if (process.argv.includes('--dbg')) {
      const dbg = await win.webContents.executeJavaScript(`(function(){
        const tb = document.getElementById('titlebar'), ft = document.getElementById('footer');
        const r = (el) => el ? Math.round(el.getBoundingClientRect().top) : -999;
        return JSON.stringify({
          mini: document.body.classList.contains('mini'),
          vw: window.innerWidth, vh: window.innerHeight,
          scrollY: window.scrollY, docScroll: document.documentElement.scrollTop,
          appTop: Math.round(document.getElementById('app').getBoundingClientRect().top),
          titlebar: r(tb), footer: r(ft),
        });
      })()`).catch(e => 'dbg-err ' + e.message);
      console.log('[shot-dbg]', name, dbg);
    }
    console.log('[shot]', name, 'saved');
  };
  const runJs = (code) => win.webContents.executeJavaScript(code).catch(e => console.error('[js]', e.message));
  if (langEn) {
    await runJs(`window.csapi.setSetting({ uiLang: 'en', lang: 'en', mapLang: 'en', roleLang: 'en' })`);
    // 演示:让 ESL 频道显示为在播,英文主卡才有「▶ ESL CS」按钮(真实探测大多数时候都不在播);
    // coolUntil 让轮询跳过该频道,保住演示态,进程退出即失效
    const esl = streamerStatus.list.find((s) => s.key === 'esl');
    if (esl) { esl.live = true; esl.coolUntil = Date.now() + 10 * 60e3; }
    if (win && !win.isDestroyed()) win.webContents.send('push:streamers', streamerStatus);
    await sleep(800);
  }
  for (const theme of themes) {
    await new Promise(resolve => {
      store.set('theme', theme);
      const once = () => { setTimeout(async () => {
        try { await snap(theme); } catch (e) { console.error('[shot]', theme, e.message); }
        resolve();
      }, shotWait); };
      if (win && !win.isDestroyed()) { win.webContents.once('did-finish-load', once); win.webContents.reload(); }
      else { createWindow(); win.webContents.once('did-finish-load', once); }
    });
    if (extra) {
      await runJs(`switchTab('events')`); await sleep(700); await snap(theme + '-events');
      await runJs(`switchTab('transfers')`); await sleep(300);
      // 截图需要展示 NEW 徽章,但 switchTab 会触发 seen 清除——重新注入
      newTransferIds = (data.transfers || []).slice(0, 2).map(t => t.id); pushData();
      await sleep(600); await snap(theme + '-transfers');
      await runJs(`switchTab('matches'); document.getElementById('btn-settings').click()`); await sleep(700); // 走真实打开路径(placeSettings 锚位+滚位复位);手动 remove hidden 会跳过锚位
      if (setView) await runJs(`(function(){ const b=[...document.querySelectorAll('.set-nav')].find(x=>x.dataset.stab===${JSON.stringify(setView)}); if (b) b.click(); })()`), await sleep(900); // 滚到指定分区再截(如主题区的滑块开关);锚点是 smooth 滚动,远分区需要等它滚完
      await snap(theme + '-settings');
      await runJs(`document.getElementById('set-close').click()`);
      await runJs(`document.getElementById('app').scrollTop = 0`); // switchTab 的 scrollIntoView 会程序化滚动 overflow:hidden 的 #app,必须复位
      setMini(true); await sleep(900); await snap(theme + '-mini');
      setMini(false); await runJs(`switchTab('matches')`); await sleep(500);
    }
    // --upd:更新弹窗每主题一张(应用内自绘;showUpdDialog/hideUpdDialog 由 renderer 全局暴露)
    if (process.argv.includes('--upd')) {
      await runJs(`showUpdDialog({ version: '0.0.2', url: 'https://github.com/likeravine233/RainyWatch/releases', canInstall: true, notes: { code: '惊蛰', quote: '微雨众卉新,一雷惊蛰始。' } })`);
      await sleep(1400); await snap(theme + '-upd');
      await runJs(`hideUpdDialog()`); await sleep(200);
    }
  }
  // --probe-row:量测带星标注的比赛行内部宽度,排查队名/星标注截断归属
  if (process.argv.includes('--probe-row')) {
    await sleep(400);
    const v = await win.webContents.executeJavaScript(`(function(){
      const row = [...document.querySelectorAll('.m-row')].find(r => r.querySelector('.m-starnote'));
      if (!row) return 'no starred row';
      const w = (el) => Math.round(el.getBoundingClientRect().width);
      const mline = row.querySelector('.mline'), mname = row.querySelector('.mname'), sn = row.querySelector('.m-starnote');
      const names = row.querySelector('.names'), teams = row.querySelector('.m-teams');
      return JSON.stringify({ teams: w(teams), names: w(names), mline: w(mline), mname: w(mname) + '/sw' + mname.scrollWidth,
        sn: w(sn) + '/sw' + sn.scrollWidth, snText: sn.textContent.trim(), mnameText: mname.textContent.trim() });
    })()`).catch(e => 'err ' + e.message);
    console.log('[row-probe]', v);
  }
  // --sizes:尺寸预设分级布局截图(s=小卡只留主卡+几场 / m=标准 / l=大窗更多行 / mini=迷你条)
  if (process.argv.includes('--sizes')) {
    if (store.get('mini')) setMini(false);
    await runJs(`switchTab('matches')`); await sleep(400);
    for (const [name, b] of Object.entries(SIZE_PRESETS)) {
      win.setBounds({ ...b }); await sleep(1000); await snap('size-' + name);
    }
    setMini(true); await sleep(700);
    win.webContents.invalidate(); await sleep(500); // 快速连跳尺寸后强制重绘,capturePage 才能拿到新帧
    await snap('size-mini');
    setMini(false); await sleep(400);
  }
  // --abbr:迷你模式队名缩写演示(注入全称长名,应显示 NaVi/EtFi 式缩写)
  if (process.argv.includes('--abbr')) {
    setMini(true); await sleep(800);
    await runJs(`DATA.matches.live[0].teamA.name='Natus Vincere'; DATA.matches.live[0].teamB.name='Eternal Fire'; renderAll(true);`);
    await sleep(600); await snap('mini-abbr');
    setMini(false); await sleep(300);
  }
  // --langen:英文界面抽查(星标注/主卡/设置文案应随词典全换,token 状态行不再挂中文)
  if (process.argv.includes('--langen')) {
    await runJs(`window.csapi.setSetting({ uiLang: 'en', lang: 'en', mapLang: 'en', roleLang: 'en' })`);
    await sleep(800); await snap('en-matches');
    await runJs(`switchTab('matches'); document.getElementById('btn-settings').click()`);
    await sleep(400);
    const sd = await win.webContents.executeJavaScript(`(function(){
      const tf=document.querySelector('.token-field'), st=document.getElementById('set-scroll');
      const target = Math.max(0, tf.offsetTop - st.clientHeight/2 + tf.offsetHeight/2);
      st.scrollTop = target;
      return JSON.stringify({ off: tf.offsetTop, ch: st.clientHeight, sh: st.scrollHeight, target, after: st.scrollTop });
    })()`).catch(e => 'err ' + e.message);
    console.log('[scroll-dbg]', sd);
    await sleep(400); await snap('en-settings-token');
    const v = await win.webContents.executeJavaScript(`(function(){
      const tf=document.querySelector('.token-field'), inp=tf.querySelector('input'), btn=tf.querySelector('button'), q=tf.querySelector('.set-q');
      const a=inp.getBoundingClientRect(), b=btn.getBoundingClientRect(), t=tf.getBoundingClientRect(), g=q.getBoundingClientRect();
      return JSON.stringify({ tfH: Math.round(t.height), inpH: Math.round(a.height), btnMidOffInput: ((b.top+b.bottom)/2-(a.top+a.bottom)/2).toFixed(1), qTopInpTop: (g.top-a.top).toFixed(1), qRight: Math.round(t.right-g.right) });
    })()`).catch(e => 'err ' + e.message);
    console.log('[token-probe]', v);
    await runJs(`window.csapi.setSetting({ uiLang: 'zh', lang: 'zh', mapLang: 'zh', roleLang: 'zh' })`);
    await sleep(400);
  }
  if (langEn) { await runJs(`window.csapi.setSetting({ uiLang: 'zh', lang: 'zh', mapLang: 'zh', roleLang: 'zh' })`); await sleep(300); }
  // 还原截图前的用户设置(主题/图序缓存):截图只是演示,不在用户 store 里留演示数据
  try { if (preShotTheme) store.set('theme', preShotTheme); if (preShotMapPool) store.set('mapPool', preShotMapPool); } catch { }
  // 整文件还原:覆盖截图期间的一切写盘(演示星标/bounds/etag/lastSeenTransferId 等);
  // 先取消窗口 bounds 的 400ms 防抖落盘,防止还原后再被旧定时器覆盖
  try { clearTimeout(saveTimer); } catch { }
  try { if (preShotStoreFile != null) fs.writeFileSync(store.file, preShotStoreFile); } catch { }
  console.log('[shot] all done');
  app.exit(0);
}

// ---------- 启动 ----------
// --probe:模式边界/托盘同步/倒计时的确定性自检(搭配 --mock)
function probeModes() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const log = (...a) => console.log('[probe]', ...a);
    try {
      setMini(true); await sleep(700);
      let b = win.getBounds();
      log('1.mini进入:', store.get('mini') === true && b.width === 240 && b.height === 104, `${b.width}x${b.height}`);
      win.setBounds({ width: 240, height: 340 }); await sleep(120); // 模拟用户把迷你条往下拖
      autoModeBySize(); await sleep(500);
      b = win.getBounds();
      log('2.拖大退出迷你:', store.get('mini') === false, '尺寸≥普通最小档:', b.width >= 300 && b.height >= 420, `${b.width}x${b.height}`);
      log('3.新尺寸已持久化:', JSON.stringify(store.get('bounds')?.width) === String(b.width));
      const ctx = trayMenu;
      log('4.托盘勾选同步:', ctx ? (ctx.items[1].label === '迷你模式' && ctx.items[1].checked === store.get('mini')) : 'n/a(无菜单)');
      const r = await win.webContents.executeJavaScript(`(function(){ if (!DATA?.matches?.upcoming?.length) return { skip: true, cd: '' }; DATA.matches.live = []; renderAll(true); return { skip: false, cd: document.querySelector('[data-cd]')?.textContent || '' }; })()`);
      log('5.倒计时同步填充:', r.skip ? 'n/a(无 upcoming)' : /^\d{2}:\d{2}:\d{2}$/.test(r.cd), r.cd || '');
      log('6.普通模式最小档钳制:', (() => { win.setBounds({ width: 200, height: 200 }); return win.getBounds().width >= 300; })());
      log('7.MiSans加载:', await win.webContents.executeJavaScript(`document.fonts.check('12px MiSans')`));
      // 8: 置顶开关注入序列(外部 PS1 采样真实 WS_EX_TOPMOST 对齐验证)
      log('8.置顶序列: OFF开始'); win.setAlwaysOnTop(false); await sleep(1500);
      log('8.置顶序列: ON'); win.setAlwaysOnTop(true); await sleep(1500);
      log('8.置顶序列: OFF'); win.setAlwaysOnTop(false); await sleep(1500);
      log('9.置顶序列结束 isAlwaysOnTop:', win.isAlwaysOnTop());
      // 10/11: 迷你往返后须恢复用户的置顶设置(回归:迷你强制置顶曾永久残留)
      const onTopSaved = store.get('onTop');
      store.set('onTop', false); setMini(true); setMini(false); await sleep(150);
      log('10.退出迷你恢复置顶(off):', win.isAlwaysOnTop() === false);
      store.set('onTop', true); setMini(true); setMini(false); await sleep(150);
      log('11.退出迷你恢复置顶(on):', win.isAlwaysOnTop() === true);
      store.set('onTop', onTopSaved);
    } catch (e) {
      log('ERR', e.message);
    }
    app.exit(0);
  }, 3000);
}

// 图钉(桌面钉住)专项探针(--probe-pin):ToggleDesktop(=Win+D)前后窗口必须保持可见
function probePin() {
  const { execFile } = require('child_process');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const log = (...a) => console.log('[probe-pin]', ...a);
    const toggleDesktop = () => new Promise(res => execFile('powershell.exe',
      ['-NoProfile', '-Command', '(New-Object -ComObject Shell.Application).ToggleDesktop()'],
      () => res()));
    try {
      await sleep(1500);
      // 普通窗口:Win+D 应最小化/隐藏(对照组)
      log('normal before:', win.isVisible(), 'min:', win.isMinimized());
      await toggleDesktop(); await sleep(1500);
      log('normal after-ToggleDesktop:', win.isVisible(), 'min:', win.isMinimized());
      // 图钉模式:Win+D 后必须仍可见
      store.set('deskPin', true); win.setAlwaysOnTop(false); win.setSkipTaskbar(true); mountToDesktop();
      showWindow(); await sleep(800);
      log('pinned before:', win.isVisible(), 'min:', win.isMinimized());
      await toggleDesktop(); await sleep(1500);
      log('pinned after-ToggleDesktop:', win.isVisible(), 'min:', win.isMinimized());
      // 还原
      store.set('deskPin', false); win.setSkipTaskbar(store.get('hideTaskbar') || store.get('mini')); unmountFromDesktop();
      showWindow();
      log('restored:', win.isVisible());
    } catch (e) { log('ERR', e.message); }
    app.exit(0);
  }, 3000);
}

// 阴影层级探针(--probe-shade):titlebar/hero 位置最顶层元素 + shade 计算样式
function probeShade() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const log = (...a) => console.log('[probe-shade]', ...a);
    try {
      await sleep(2000);
      const r = await win.webContents.executeJavaScript(`(function(){
        const pick = (x, y) => { const el = document.elementFromPoint(x, y); return el ? (el.id || el.tagName + '.' + el.className) : 'none'; };
        const shade = document.getElementById('glass-shade');
        const cs = shade ? getComputedStyle(shade) : null;
        const bg = document.getElementById('glass-bg');
        return {
          atTitlebar: pick(190, 20),
          atHero: pick(190, 90),
          shadeDisplay: cs ? cs.display : 'no-shade',
          shadeBg: cs ? (cs.backgroundImage || cs.background).slice(0, 90) : '',
          shadeZ: cs ? cs.zIndex : '',
          bgZ: bg ? getComputedStyle(bg).zIndex : '',
          bgFilter: bg ? getComputedStyle(bg).filter.slice(0, 60) : ''
        };
      })()`);
      log(JSON.stringify(r, null, 1));
    } catch (e) { log('ERR', e.message); }
    app.exit(0);
  }, 3000);
}

// 窗口重建专项探针(--probe-recreate):主题/取景玻璃切换触发 recreateWindow 后窗口必须重新可见
function probeRecreate() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const log = (...a) => console.log('[probe-recreate]', ...a);
    try {
      await sleep(1500);
      log('initial visible:', win.isVisible());
      store.set('theme', 'frost'); recreateWindow(); await sleep(2000);
      log('after theme->frost visible:', win.isVisible(), 'destroyed:', !win || win.isDestroyed());
      store.set('captureGlass', false); recreateWindow(); await sleep(2000);
      log('after captureGlass->off visible:', win.isVisible());
      store.set('theme', 'liquid'); store.set('captureGlass', true); recreateWindow(); await sleep(2000);
      log('after restore(liquid,on) visible:', win.isVisible());
      await sleep(800);
      log('final visible:', win && !win.isDestroyed() ? win.isVisible() : 'destroyed');
    } catch (e) { log('ERR', e.message); }
    app.exit(0);
  }, 3000);
}

// 取景玻璃专项探针(--probe-glass):帧链路/位移贴图/折射滤镜状态
function probeGlass() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  setTimeout(async () => {
    const log = (...a) => console.log('[probe-glass]', ...a);
    try {
      await sleep(1600); // 等前几帧到达
      const r = await win.webContents.executeJavaScript(`(function(){
        const bg = document.getElementById('glass-bg');
        const map = document.getElementById('lg-map');
        const edge = document.getElementById('glass-edge');
        const cs = edge ? getComputedStyle(edge) : null;
        return {
          glasscap: document.body.dataset.glasscap,
          theme: document.body.dataset.theme,
          videoLive: !!(document.getElementById('glass-video') && document.getElementById('glass-video').srcObject),
          bgFrameArrived: !!(bg && (bg.style.backgroundImage || '').includes('data:image')),
          mapHrefSet: !!(map && (map.getAttribute('href') || '').startsWith('data:image')),
          edgeDisplay: cs ? cs.display : 'no-edge',
          edgeBackdropFilter: cs ? (cs.backdropFilter || '') : ''
        };
      })()`);
      log('normal', JSON.stringify(r));
      setMini(true); await sleep(1300);
      const r2 = await win.webContents.executeJavaScript(`(function(){
        const bg = document.getElementById('glass-bg');
        const app = document.getElementById('app');
        const tb = document.getElementById('titlebar');
        const hero = document.getElementById('hero');
        const ft = document.getElementById('footer');
        const r = (el) => el ? { top: Math.round(el.getBoundingClientRect().top), h: Math.round(el.getBoundingClientRect().height) } : null;
        return {
          mini: document.body.classList.contains('mini'), glasscap: document.body.dataset.glasscap,
          videoLive: !!(document.getElementById('glass-video') && document.getElementById('glass-video').srcObject),
          frame: (bg.style.backgroundImage || '').includes('data:image'),
          vh: window.innerHeight,
          app: r(app), appScroll: app ? app.scrollHeight : 0, appClient: app ? app.clientHeight : 0,
          titlebar: r(tb), hero: r(hero), footer: r(ft),
          heroTop: r(document.querySelector('#hero .hero-top')),
          heroMain: r(document.querySelector('#hero .hero-main')),
          heroEv: r(document.querySelector('#hero .hero-ev')),
          heroEvText: document.querySelector('#hero .hero-ev')?.textContent || '',
          hmKids: [...document.querySelectorAll('#hero .hero-main > *')].map(el => {
            const b = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return { cls: el.className, top: Math.round(b.top), h: Math.round(b.height), w: Math.round(b.width), fs: cs.fontSize };
          }),
          heroScroll: hero ? hero.scrollHeight : 0, heroClient: hero ? hero.clientHeight : 0,
        };
      })()`);
      log('mini', JSON.stringify(r2));
    } catch (e) { log('ERR', e.message); }
    app.exit(0);
  }, 3000);
}

app.whenReady().then(async () => {
  try { logHide('GPU加速状态: ' + JSON.stringify(app.getGPUFeatureStatus())); } catch { /* 诊断用,忽略 */ }
  // 诊断改为后台补跑(不再 await):GPU 进程异常的机器上 getGPUInfo 要等数秒,窗口迟迟不出。
  // 启动速度优先 —— createWindow 立即执行,首屏"正在同步"由渲染层展示
  try {
    app.getGPUInfo('basic').then((gi) => {
      const g = (gi && gi.gpuDevice && gi.gpuDevice.find(d => d.active)) || (gi && gi.gpuDevice && gi.gpuDevice[0]);
      if (g) logHide(`GPU适配器: vendor=${g.vendor} device=${g.device} active=${!!g.active}`);
    }).catch(() => {});
  } catch { /* 诊断用,忽略 */ }
  setTimeout(() => { try { logHide('GPU加速状态(25s后): ' + JSON.stringify(app.getGPUFeatureStatus())); } catch { /* 忽略 */ } }, 25000);
  // 进程级 CPU 画像:光效烧 CPU 必须分清进程——Renderer=主线程/光栅,GPU=合成/呈现,Browser=主进程。
  // 每 30s 打一次,只打占用 >3% 的进程,无占用不刷屏;与设置里逐个关光效配合可锁定元凶层
  setInterval(() => {
    try {
      const rows = app.getAppMetrics().filter((m) => m.cpu && m.cpu.percentCPUUsage > 3).map((m) => `${m.type}#${m.pid} ${m.cpu.percentCPUUsage.toFixed(1)}%`);
      if (rows.length) console.log('[cpu]', rows.join(' | '));
    } catch { /* 诊断用 */ }
  }, 30e3);
  store = new Store(path.join(app.getPath('userData'), 'widget-store.json'), DEFAULTS);
  if (store.get('hoverUnlimited') === true) store.set('flexMode', true); // 旧键迁移:「悬停解除上限」→「灵活模式」
  preShotTheme = store.get('theme'); preShotMapPool = store.get('mapPool'); // 截图模式结束后还原
  syncNativeTheme(); // 原生控件(下拉弹窗)深浅随应用主题
  registerDisplayMedia(); // 取景玻璃:getDisplayMedia 自动放行
  makeTray();
  if (isShot) {
    await bootstrapData(); // 截图模式需要 mock 数据就绪
    createWindow();
    setTimeout(runShots, 1500);
  } else if (process.argv.includes('--probe')) {
    await bootstrapData();
    createWindow();
    probeModes();
  } else if (process.argv.includes('--probe-glass')) {
    await bootstrapData();
    createWindow();
    probeGlass();
  } else if (process.argv.includes('--probe-recreate')) {
    await bootstrapData();
    createWindow();
    probeRecreate();
  } else if (process.argv.includes('--probe-pin')) {
    await bootstrapData();
    createWindow();
    probePin();
  } else if (process.argv.includes('--probe-shade')) {
    await bootstrapData();
    createWindow();
    probeShade();
  } else {
    createWindow(); // 先出窗:启动不再被网络请求阻塞(首屏走缓存,数据后台补)
    startScheduler();
    bootstrapData().catch(() => {});
    if (store.get('autostart')) applyAutoLaunch();
    refreshStarsIfNeeded(); // 补解析缺失队伍的关注选手(异步,不阻塞)
  }
  if (process.argv.includes('--debug-dump')) {
    setTimeout(async () => {
      try {
        const dbg = await win.webContents.executeJavaScript(`({
          metaNewIds: (typeof META !== 'undefined' && META) ? META.newTransferIds : 'no-META',
          firstId: (typeof DATA !== 'undefined' && DATA && DATA.transfers && DATA.transfers[0]) ? DATA.transfers[0].id : 'none',
          badges: document.querySelectorAll('.new-badge').length,
          rows: document.querySelectorAll('.t-row').length,
        })`);
        console.log('DEBUG', JSON.stringify(dbg, null, 2));
      } catch (e) { console.error('DEBUG-ERR', e.message); }
      app.exit(0);
    }, 3500);
  }
});

app.on('window-all-closed', () => { /* 常驻托盘 */ });
app.on('before-quit', () => { quitting = true; });
