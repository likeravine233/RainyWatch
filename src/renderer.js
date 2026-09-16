// RainyWatch 渲染层
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let DATA = null;      // { matches, events, transfers }
let META = null;      // { updatedAt, stale, err, newTransferIds }
let SETTINGS = null;  // settings 对象(含 starPlayers/starTeams)
let MAPPOOL = {}; // push:data.maps:LP 赛事页弹层采到的 BP 图序(key=开赛时间戳)
let ACRYLIC = false;
let GLASS_CAP = false; // 取景玻璃(主进程允许采集,渲染层起 getDisplayMedia 视频流)
let HERO_M = null;    // 当前主卡比赛(复制比分用)
let MATCH_BY_KEY = {}; // matchKey -> 比赛对象(行右键菜单取数,renderMatches 重建)
let searchTimer = null;
let APP_VER = '';     // 应用版本(主进程 payload 带入,GitHub 反馈正文用)
// GitHub 反馈仓库(RainyWatch):当前为私有仓库,公开后反馈按钮对所有人可用。
// 右键"数据不准?"会以 ?title=&body= 预填 issue 模板,用户一打开就是待填的反馈框
const FEEDBACK_REPO = 'https://github.com/likeravine233/RainyWatch';
// —— 发版必要工序:每个 release 在此登记一行 —— 版本号 → 中文代号 + 本版寄语(一句),
// 展示于设置「关于」页签;署名随界面语言自动切换(中:若谷LikeRavine / 英:LikeRavine233)。
// 此表是离线兜底:在线通道走 release 说明首行「代号|寄语」(main.js parseRelNotes),
// 当前版确认已最新时关于页优先展示在线版,可不发版修订文案
const RELEASE_NOTES = {
  '0.0.1': { code: '红狐商会', quote: '“爱如此刻永恒”' },
};
// 界面文案取词(lang 设置驱动),{n} 类占位替换
const UIL = () => (SETTINGS && SETTINGS.uiLang) || 'zh'; // 界面语言(独立设置,界面只管界面;赛事文本用 LANG)
const T = (k, vars) => { let s = window.I18N.uit(k, UIL()); if (vars) for (const [x, v] of Object.entries(vars)) s = s.split('{' + x + '}').join(String(v)); return s; };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Liquipedia 红链(队页不存在)如 index.php?title=WhiteBIT_Team&action=edit&redlink=1:真实页面名在 title 参数里,按 / 前缀取只能得到 "index.php"
const slugOf = (href) => {
  const s = String(href || '');
  const red = /[?&]title=([^&#]+)/.exec(s);
  if (red) return decodeURIComponent(red[1]);
  return decodeURIComponent(s.replace(/^.*\/counterstrike\//, '').replace(/[?#].*$/, ''));
};

// ---------- 取景玻璃 ----------
// 主链路:渲染层 getDisplayMedia 常驻视频流(主进程自动放行、免选择器),GPU 合成高斯模糊,
// 零轮询、零 IPC 大图;液态主题再用 SVG feDisplacementMap 对真实像素做边缘折射。
// 兜底:视频流不可用时由主进程低频截图帧(glass-frame)接管。
function glassWanted() {
  // 图钉保持顶层窗口(不再挂桌面层),accent/背板在图钉下照常可用,无需强制取景玻璃
  return GLASS_CAP && ['frost', 'liquid'].includes(SETTINGS?.theme);
}
let glassStarting = false;
function syncGlassMode() {
  if (!glassWanted()) {
    stopGlassVideo();
    document.body.dataset.glasscap = 'off';
    const bg = $('#glass-bg');
    if (bg) bg.style.backgroundImage = '';
    return;
  }
  if (!glassStream && !glassStarting) startGlassVideo(); // 设置变化(如图钉开关)后自动起流
}
let glassStream = null;
function stopGlassVideo() {
  glassStarting = false;
  stopGlassGeo();
  if (glassStream) { glassStream.getTracks().forEach(t => t.stop()); glassStream = null; }
  const v = $('#glass-video');
  if (v) v.srcObject = null;
  if (document.body.dataset.glasscap === 'on') document.body.dataset.glasscap = 'off';
}
// 视频流是"整屏"帧:#glass-bg 里必须按窗口在屏幕上的真实位置 1:1 取位,
// 否则 object-fit: cover 会居中裁切——小卡显示的是屏幕中央而不是自己正后方那块桌面
function applyGlassGeometry() {
  const v = $('#glass-video');
  if (!v || !v.videoWidth) return;
  const sw = screen.width, sh = screen.height;
  v.style.width = sw + 'px';
  v.style.height = sh + 'px';
  v.style.left = (-window.screenX) + 'px';
  v.style.top = (-window.screenY) + 'px';
  v.style.objectFit = 'fill';
}
let glassGeoTimer = null;
function startGlassGeo() {
  if (glassGeoTimer) return;
  glassGeoTimer = setInterval(applyGlassGeometry, 700); // screenX/screenY 无 DOM 事件,低频轮询跟随窗口拖动
}
function stopGlassGeo() {
  if (glassGeoTimer) { clearInterval(glassGeoTimer); glassGeoTimer = null; }
}
async function startGlassVideo() {
  if (glassStream || glassStarting || !glassWanted()) return;
  glassStarting = true;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('no-getDisplayMedia');
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: { frameRate: { ideal: SETTINGS?.lowPower ? 15 : 20, max: 30 }, width: { ideal: 960 }, height: { ideal: 1600 } }, // 20fps(性能优先 15fps):底材经 28px 模糊,帧率差异不可感知;低分辨率足够,模糊后无细节
    });
    glassStarting = false;
    if (!glassWanted()) { stream.getTracks().forEach(t => t.stop()); return; }
    glassStream = stream;
    const v = $('#glass-video');
    if (v) {
      v.srcObject = stream;
      v.addEventListener('loadedmetadata', applyGlassGeometry, { once: true });
      v.play().catch(() => {});
    }
    applyGlassGeometry();
    startGlassGeo();
    document.body.dataset.glasscap = 'on';
    stream.getVideoTracks()[0]?.addEventListener('ended', () => { stopGlassVideo(); window.csapi.glassFallback(); });
  } catch {
    glassStarting = false;
    window.csapi.glassFallback(); // 采集失败→主进程低频截图帧兜底
  }
}
function bindGlassFrame() {
  window.csapi.onGlassFrame((url) => { // 兜底帧(仅视频流不可用时由主进程推送)
    if (!glassWanted()) return;
    stopGlassVideo();
    const bg = $('#glass-bg');
    if (!bg) return;
    bg.style.backgroundImage = `url(${url})`;
    document.body.dataset.glasscap = 'on';
  });
}
// 生成液态玻璃边缘折射位移贴图:R=x 位移、G=y 位移,四边向内弯折,中心保持中性(128)
function buildLgMap() {
  const S = 256, c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const EW = 0.17; // 边缘弯折区宽度占比
  const K = 0.5;   // 边缘最大位移强度
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const nx = x / (S - 1), ny = y / (S - 1);
      const dx = nx < EW ? 1 - nx / EW : nx > 1 - EW ? -(1 - (1 - nx) / EW) : 0;
      const dy = ny < EW ? 1 - ny / EW : ny > 1 - EW ? -(1 - (1 - ny) / EW) : 0;
      img.data[i] = Math.round((0.5 + Math.max(-1, Math.min(1, dx)) * K * 0.5) * 255);
      img.data[i + 1] = Math.round((0.5 + Math.max(-1, Math.min(1, dy)) * K * 0.5) * 255);
      img.data[i + 2] = 128;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const map = $('#lg-map');
  if (map) map.setAttribute('href', c.toDataURL());
}

// 赛事名显示(根据设置):zh+zh=中文惯称;abbr=简称(去年份/阶段);full=原名
function evName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const mode = SETTINGS?.eventNameMode || 'abbr';
  const lang = SETTINGS?.lang || 'zh';
  if (mode === 'full') return tr(raw, lang);
  if (mode === 'zh' || (lang === 'zh' && mode === 'abbr')) {
    const zh = window.I18N.zhEvent(raw);
    if (zh !== raw) return zh; // 命中中文别名表
  }
  return window.I18N.abbrEvent(raw);
}

// 队标:URL 为空直接给首字母;加载失败由 document 捕获阶段的 error 委托换首字母兜底
// (CSP script-src 'self' 拦内联 onerror,内联处理器在本应用里永远不会触发,必须走委托)
function logoHtml(url, name, cls = '') {
  if (!url) return `<div class="fallback ${cls}">${esc((name || '?')[0])}</div>`;
  return `<img src="${esc(url)}" alt="" loading="lazy" data-fbcls="${esc(cls)}" data-fbl="${esc((name || '?')[0])}">`;
}
document.addEventListener('error', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLImageElement) || !el.dataset.fbl) return;
  el.outerHTML = `<div class="fallback ${el.dataset.fbcls || ''}">${esc(el.dataset.fbl)}</div>`;
}, true);

function fmtCd(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${ss}`;
}
function fmtElapsed(ms) {
  const m = Math.max(0, Math.floor(ms / 60000)); // 调试注入/数据迟到时 ts 可能晚于现在,负数时长显示成"-747 分钟"
  if (m < 60) return T('fmt.min', { n: m });
  return T('fmt.hour', { h: Math.floor(m / 60), m: m % 60 });
}
// 时区:SETTINGS.timezone 为空=本机;IANA 名(Asia/Shanghai 等)=按该时区取时间分量,夏令时由 Intl 自动处理
const _tzFmt = {};
const _WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function tzParts(ts) {
  const tz = (SETTINGS && SETTINGS.timezone) || '';
  if (_tzFmt[tz] === undefined) {
    try {
      _tzFmt[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
    } catch { _tzFmt[tz] = null; } // 时区名非法:回退本机
  }
  const f = _tzFmt[tz];
  if (!f) { const d = new Date(ts); return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), wd: d.getDay() }; }
  const p = {};
  for (const it of f.formatToParts(new Date(ts))) p[it.type] = it.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: _WD[p.weekday] ?? 0 };
}
function fmtStartTime(ts, mode) {
  const t = tzParts(ts), n = tzParts(Date.now());
  const week = (LANG() === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['周日', '周一', '周二', '周三', '周四', '周五', '周六'])[t.wd];
  const hm = `${String(t.h).padStart(2, '0')}:${String(t.mi).padStart(2, '0')}`;
  const dayDiff = Math.round((Date.UTC(t.y, t.mo - 1, t.d) - Date.UTC(n.y, n.mo - 1, n.d)) / 864e5);
  const df = mode || (SETTINGS && SETTINGS.dateFormat) || 'smart';
  if (df === 'weekday') return `${week} ${hm}`;
  if (df === 'date') {
    const md = `${String(t.mo).padStart(2, '0')}-${String(t.d).padStart(2, '0')}`;
    return t.y === n.y ? `${md} ${hm}` : `${t.y}-${md} ${hm}`;
  }
  if (dayDiff === 0) return `${T('day.today')} ${hm}`;
  if (dayDiff === 1) return `${T('day.tomorrow')} ${hm}`;
  if (dayDiff === -1) return `${T('day.yday')} ${hm}`;
  return dayDiff > 1 && dayDiff < 7 ? `${week} ${hm}` : `${t.mo}/${t.d} ${hm}`;
}
// 列表行「即将开始」的时间:A=只看开赛时刻;B=临近 1 小时内换成倒计时;both=临近时「倒计时 · 时刻」同时可见
function upcomingTimeText(ts) {
  const mode = (SETTINGS && SETTINGS.upcomingTime) || 'both';
  const diff = ts - Date.now();
  if (diff <= 0) return T('hero.soon'); // 已到点而数据源还没翻 live:显示等开赛状态,别再挂开赛时刻
  const cd = diff < 3600e3;
  if (mode === 'start' || !cd) return fmtStartTime(ts);
  return mode === 'cd' ? T('hero.cd.suffix', { t: fmtCd(diff) }) : `${T('hero.cd.suffix', { t: fmtCd(diff) })} · ${fmtStartTime(ts)}`;
}
function upcomingSoon(ts) {
  return ((SETTINGS && SETTINGS.upcomingTime) || 'both') !== 'start'
    && ts - Date.now() > 0 && ts - Date.now() < 3600e3;
}
// 已到点未开赛的「即将开赛」:文字后三个小点依次上跳;进态只写一次 innerHTML,每秒重写会重启动画
const CD_DOTS = '<span class="cd-dots"><i></i><i></i><i></i></span>';
function odText(el, str) { // 里程表写入:数字位包 .od,变化位触发一次短滑入;长度/形态变化时整体重建
  if (el._od !== str) {
    if (typeof el._od !== 'string' || el._od.length !== str.length) {
      el._od = str;
      el.innerHTML = [...str].map((ch) => (/\d/.test(ch) ? `<b class="od">${ch}</b>` : `<i class="ods">${ch}</i>`)).join('');
      return;
    }
    const nodes = el.children;
    for (let i = 0; i < str.length; i++) {
      const n = nodes[i];
      if (n.textContent === str[i]) continue;
      n.textContent = str[i];
      if (n.classList.contains('od')) { n.classList.remove('roll'); void n.offsetWidth; n.classList.add('roll'); }
    }
    el._od = str;
  }
}
function upcomingStarted(ts) { return ts - Date.now() <= 0; }
// 玩机器不播所有比赛:斗鱼 6657 探测到未开播就隐藏按钮(探测失败/未知时保留,免得误伤)
let STREAMER_LIST = []; // 主进程推送的开播状态;英文界面下主卡按钮从中挑第一个在播的国际频道
let STREAMER_TWON = false; // Twitch 凭证已配置(主进程随推送携带);语言切换重渲染时要一并带上
const isEnUI = () => document.documentElement.lang === 'en';
function wjBtn() {
  if (isEnUI()) { // 英文界面:中文解说按钮整体换成国际频道,取第一个在播者;都不播则不显示(「观战」按钮兜底)
    const s = STREAMER_LIST.find((x) => x.lang === 'en' && x.live);
    if (!s) return '';
    return `<button class="watch-btn small" data-url="${esc(s.url)}" title="${esc(T('streamer.live'))}">▶ ${esc(s.name)}</button>`;
  }
  const wj = META && META.wanjiqi;
  if (wj && wj.live === false) return '';
  return `<button class="watch-btn small" data-url="${WANJI_URL}" title="${esc(T('wj.title'))}${wj && wj.live ? esc(T('wj.live')) : ''}">▶ 玩机器</button>`;
}

function agoText(ts) {
  if (!ts) return T('ago.none'); // 尚无同步时间 = 启动后正在拉取(窗口先开,数据后台补)
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return T('ago.now');
  if (s < 3600) return T('ago.min', { n: Math.floor(s / 60) });
  return T('ago.hour', { n: Math.floor(s / 3600) });
}

// ---------- 关注(高光选手/队伍)----------
const tColor = (team) => (window.TC ? window.TC.colorFor(team.name, team.href) : '#888888');

// ---------- 赛事文本语言 / 评级徽标 / 玩机器 ----------
const LANG = () => (SETTINGS && SETTINGS.lang) || 'zh';
const ROLELANG = () => (SETTINGS && SETTINGS.roleLang) || 'zh'; // 选手角色显示:与"赛事文本语言"是两个独立设置
const STORYSTYLE = () => (SETTINGS && SETTINGS.storyStyle) || 'pro'; // 变阵解说风格:pro=标准措辞,fun=社区梗([一半生活电视]xx板凳xx)
const tr = (s) => (window.I18N ? window.I18N.tr(s, LANG()) : String(s ?? ''));
// 地图中文名(完美世界国服译名):数据源(PandaScore/未来 LPDB)只给英文,语言=中文时显示译名,表外地图回退原文
const MAP_ZH = {
  mirage: '荒漠迷城', 'dust ii': '炙热沙城Ⅱ', dust2: '炙热沙城Ⅱ', inferno: '炼狱小镇',
  nuke: '核子危机', ancient: '远古遗迹', anubis: '阿努比斯', vertigo: '殒命大厦',
  train: '列车停放站', overpass: '死亡游乐园', cache: '死城之谜', airport: '空港时刻', // 虚构图:决胜图右侧的对称补位图
};
// 玩家圈惯用简称(弹幕/解说叫法,经知乎图池文/NGA/贴吧用例核实);阿努比斯无公认简称,
// 表外地图(office/italy 等)一并退回全称,再退回原文
const MAP_ZH_SHORT = {
  mirage: '米垃圾', 'dust ii': '沙二', dust2: '沙二', inferno: '小镇', nuke: '核子',
  train: '火车', cache: '叉车', ancient: '遗迹', vertigo: '大厦', overpass: '游乐园', airport: '机场',
};
const mapZh = (name) => {
  const s = String(name || '').trim();
  if (!s) return s;
  const mode = SETTINGS?.mapLang || 'zh';
  if (mode === 'en') return s;
  const k = s.toLowerCase().replace(/^de[-_ ]/, '').replace(/\s+/g, ' ');
  return ((mode === 'zhShort' && MAP_ZH_SHORT[k]) || MAP_ZH[k]) || s;
};
const trDates = (s) => (window.I18N ? window.I18N.trDates(s, LANG()) : String(s ?? ''));
const tierLabel = (t) => (window.I18N ? window.I18N.tierLabel(t, LANG()) : t);
const abbr = (n) => (window.I18N ? window.I18N.abbr(n) : n);
const WANJI_URL = 'https://www.douyu.com/6657'; // 玩机器Machine 斗鱼直播间

// ---------- V社全球排名(VRS) ----------
// data.rankings = { bySlug:{slug:{rank,name,points,region}}, byName:{'队名小写':同上}, updatedAt }
let _vrsIdx = null, _vrsSrc = null;
// 名字别名:VRS 名与比赛里的常用短名对齐(FaZe Clan→faze / Team Spirit→spirit)
const aliasKeys = (name) => {
  const out = new Set([name.toLowerCase()]);
  const stripped = String(name).replace(/\b(Team|Clan|Esports|E-sports|eSports|Gaming|Club|The)\b/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (stripped) out.add(stripped);
  return [...out];
};
function vrsIndex() {
  const r = DATA?.rankings;
  if (!r || (!r.bySlug && !r.byName)) return null;
  if (_vrsIdx && _vrsSrc === r) return _vrsIdx;
  _vrsIdx = { bySlug: new Map(), byName: new Map() };
  for (const [k, v] of Object.entries(r.bySlug || {})) {
    _vrsIdx.bySlug.set(k.toLowerCase(), v);
    for (const a of aliasKeys(v.name)) if (!_vrsIdx.byName.has(a)) _vrsIdx.byName.set(a, v);
  }
  for (const [k, v] of Object.entries(r.byName || {})) {
    if (!_vrsIdx.byName.has(k.toLowerCase())) _vrsIdx.byName.set(k.toLowerCase(), v);
  }
  _vrsSrc = r;
  return _vrsIdx;
}
function rankOf(team) {
  const idx = vrsIndex();
  if (!idx || !team) return null;
  const slug = slugOf(team.href).toLowerCase();
  const hit = (slug && idx.bySlug.get(slug)) || idx.byName.get(String(team.name || '').toLowerCase());
  return hit ? hit.rank : null;
}
// 对阵双方的排名徽标:数值小(排名高)的一侧高亮,形成"对比"
function rankBadges(m) {
  const ra = rankOf(m.teamA), rb = rankOf(m.teamB);
  if (!ra && !rb) return ['', ''];
  const mark = (r, best) => r
    ? `<span class="vrank${best ? ' best' : ''}" title="${esc(T('vrs.rank', { n: r }))}">VRS#${r}</span>`
    : `<span class="vrank none" title="${esc(T('vrs.none'))}">—</span>`;
  const aBest = !!ra && (!rb || ra < rb);
  const bBest = !!rb && (!ra || rb < ra);
  return [mark(ra, aBest), mark(rb, bBest)];
}

function tierOf(href) {
  if (!href) return '';
  const slug = slugOf(href).toLowerCase();
  if (DATA?.events) {
    for (const k of ['ongoing', 'upcoming']) {
      for (const e of (DATA.events[k] || [])) {
        if (slugOf(e.href).toLowerCase() === slug) return e.tier || '';
      }
    }
  }
  return DATA?.tierArchive?.[slug]?.t || ''; // 掉榜赛事归档:S 永久/A 30天/B 15天/C 7天(主进程已剪枝,随 payload 下发)
}
function tierChip(href) {
  const t = tierOf(href);
  return t ? `<span class="tier-chip ${esc(t)}" title="${esc(T('tier.title', { t: tierLabel(t) }))}">${esc(tierLabel(t))}</span>` : '';
}
// 赛果结束标记:仿系统推送的粗粒度时间段(刚刚/N分钟前/N小时前/昨天/N天前/日期),不带"约"、不精确到分
function endAgoText(ms, approx) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return T('endAgo.now');
  if (min < 60) return T('endAgo.min', { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return T('endAgo.hour', { n: h });
  const d = Math.floor(h / 24);
  if (d === 1) return T('endAgo.yday');
  if (d < 7) return T('endAgo.day', { n: d });
  const t = tzParts(Date.now() - ms);
  return LANG() === 'en' ? `${t.mo}/${t.d}` : `${t.mo}月${t.d}日`;
}
function endAgoHtml(m) {
  const ts = m.endedAt || m.ts;
  const approx = !m.endedAt || !!m.endedApprox;
  return `<span data-endts="${ts}" data-approx="${approx ? '1' : ''}">${esc(endAgoText(Date.now() - ts, approx))}</span>`;
}
function applyLowop(op) {
  if ((op ?? 1) < 0.65) document.body.dataset.lowop = '1';
  else delete document.body.dataset.lowop;
}

// 与 main.js 同款:队名归一,兼容 PandaScore 队名与 Liquipedia slug 的差异
const normTeam = (s) => String(s || '').toLowerCase()
  .replace(/\b(team|clan|esports|e-?sports|gaming|club|the)\b/g, '')
  .replace(/[^a-z0-9]/g, '');

function sideStars(team) {
  const out = [];
  if (!team) return out;
  const slug = slugOf(team.href).toLowerCase();
  const slugN = normTeam(slug);
  for (const t of (SETTINGS?.starTeams || [])) {
    if ((t.id || '').toLowerCase() === slug || (team.name && (t.name || '').toLowerCase() === String(team.name).toLowerCase())) {
      out.push({ type: 'team', name: t.name, id: t.id });
    }
  }
  for (const p of (SETTINGS?.starPlayers || [])) {
    // PandaScore 的 teamSlug(如 natus-vincere-cs-go)与比赛侧 Liquipedia slug(Natus_Vincere)字面不等,
    // 剥掉 -cs-go 后缀再做队名归一;NAVI 这类"LP 显示缩写、Panda 存全名"的队靠它才置顶
    const ps = p.teamSlug ? normTeam(String(p.teamSlug).replace(/[-_ ]*cs[-_ ]*go$/i, '')) : '';
    if (ps && slugN && ps === slugN) out.push({ type: 'player', name: p.name, id: p.id });
    else if (p.panda && p.team && normTeam(p.team) === normTeam(team.name)) out.push({ type: 'player', name: p.name, id: p.id });
  }
  return out;
}
const starScore = (m) => (sideStars(m.teamA).length ? 1 : 0) + (sideStars(m.teamB).length ? 1 : 0);
const starNames = (m) => [...sideStars(m.teamA), ...sideStars(m.teamB)].map(s => s.name);
// 可见关注标注:选手写"xx 在阵",队伍写"队伍 xx",让 star 有明确含义(文案随界面语言)
const starTags = (m) => [...sideStars(m.teamA), ...sideStars(m.teamB)]
  .map(s => T(s.type === 'player' ? 'star.tip.player' : 'star.tip.team', { n: s.name }));

function sortedMatches() {
  const raw = DATA?.matches || {};
  const byStar = (a, b) => starScore(b) - starScore(a);
  return {
    live: [...(raw.live || [])].sort((a, b) => byStar(a, b)),
    upcoming: [...(raw.upcoming || [])].sort((a, b) => byStar(a, b) || a.ts - b.ts),
    recent: raw.recent || [],
  };
}
// 队伍关注态只查 starTeams,不能并入 sideStars:选手关注会让所在队伍被误判"已关注",右键菜单/星按钮显示与点击全错
// 返回命中的存储条目：移除时按存储 id 删，主卡/列表行 href 变体与存储 id 不一致也能删准
const followedTeam = (t) => {
  if (!t) return null;
  const slug = slugOf(t.href).toLowerCase();
  return (SETTINGS?.starTeams || []).find((s) => (s.id || '').toLowerCase() === slug || (t.name && (s.name || '').toLowerCase() === String(t.name).toLowerCase())) || null;
};
const teamStarred = (t) => !!followedTeam(t);

function starBtnTeam(team) {
  const on = teamStarred(team);
  const slug = slugOf(team.href) || team.name;
  return `<button class="star-btn ${on ? 'on' : ''}" data-star-team data-slug="${esc(slug)}" data-name="${esc(team.name)}" data-href="${esc(team.href)}" title="${on ? esc(T('star.unfollow')) : esc(T('star.follow'))}">★</button>`;
}

function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1600);
}

function pandaNote() {
  const el = $('#panda-note');
  if (!el) return;
  // 静态说明已收进分区题头的圈问号;这行只剩"已启用"动态状态,未配置时整体隐藏
  el.hidden = !(SETTINGS && SETTINGS.pandaToken);
  el.textContent = T('panda.on');
}

// ---------- 主卡 ----------
let prevRoundStr = '';
function roundInfo(m) {
  if (!m.live2) return null;
  const { mapNum, ra, rb, mapName } = m.live2;
  const has = Number.isFinite(ra) && Number.isFinite(rb); // 免费档只有图号没有回合分:降级为"第N图"
  const mn = mapZh(String(mapName || '').trim()); // 地图名:数据源给了才显示(中文语言显示译名),没有则一律"第N图"
  return { mapNum, mapName: mn, ra: has ? ra : null, rb: has ? rb : null, round: has ? ra + rb + 1 : null, str: `${mn}|${has ? `${mapNum}|${ra}|${rb}` : `m${mapNum}`}` };
}

// 主卡队名:迷你模式下用缩写(宽度有限),其余尺寸用全名
const heroName = (t) => (document.body.classList.contains('mini') ? abbr(t.name || 'TBD') : (t.name || 'TBD'));


// ---------- 主卡置顶 ----------
// 列表行悬停浮现 📌 把比赛顶到主卡:pin 持续于该比赛的直播/即将开始阶段;滚出时间窗(进赛果/被取消)
// 自动失效回自动选择,不持久化(重启回自动)。主卡 📌 chip=取消置顶。
const matchKey = (m) => `${m.teamA.name}|${m.teamB.name}`; // 不含 ts:推迟改期后 key 不变,置顶/追踪不丢
let heroPin = null;
function pickHero(s) {
  if (heroPin) {
    const m = [...s.live, ...s.upcoming].find(x => matchKey(x) === heroPin);
    if (m) return m;
    heroPin = null; // 已进赛果/被取消:置顶自然失效,赛果无缝接管主卡
  }
  return s.live.find((m) => !m.pending) || s.live[0] || s.upcoming[0] || s.recent[0] || null; // 占位场(TBD)压到真实对局之后:它占的是直播位,但还没真的开打
}
// 置顶切换后重渲染主卡与列表,并给主卡挂一次进场动效(class 只在点击时挂,强制重排重启,播完即摘)
function swapHero() {
  renderHero(); renderMatches();
  const hero = $('#hero');
  hero.classList.remove('swap-in');
  void hero.offsetWidth;
  hero.classList.add('swap-in');
  clearTimeout(swapHero._t);
  swapHero._t = setTimeout(() => hero.classList.remove('swap-in'), 460);
}

function renderHero() {
  const hero = $('#hero');
  const { live, upcoming, recent } = sortedMatches();
  const src = pickHero({ live, upcoming, recent }); // 置顶优先,失效回自动(直播>即将开始>赛果)
  const m = src;
  const isPinned = !!(src && heroPin && matchKey(src) === heroPin);
  const PIN_CHIP = `<span class="chip pin-chip" data-unpin title="${esc(T('pin.unpin'))}">📌</span>`;
  let HH = ''; // 本轮主卡 HTML:与上一轮一字未变则整卡不重建(修补式更新),行内动画/悬停态/对撞波画布全保留
  if (m && m.status === 'live') {
    HERO_M = m;
    const stars = starTags(m);
    const ri = roundInfo(m);
    const [vA, vB] = rankBadges(m);
    const sa = m.score ? m.score[0] : 0, sb = m.score ? m.score[1] : 0;
    hero.style.setProperty('--tc-a', tColor(m.teamA));
    hero.style.setProperty('--tc-b', tColor(m.teamB));
    // 信息层级(参照转播 HUD):中央大数字=小分(回合比分),正下方副行=大比分,顶部 chips=阶段状态
    // 小分是 PandaScore 付费字段,免费档无 round_score(ri.ra 为 null):中央退回大比分,chip 只标"第N图"
    const riRounds = ri && ri.ra != null;
    // 中央大字=大比分 x - x(无比分数据时 0 - 0 起步);正下方略小字号=当前图名(LP 图序兜底),
    // 再下小字=赛制 BO几。付费档(riRounds)保持转播 HUD:大字=回合比分,大比分挂 .series,图名在 round chip
    const big = riRounds
      ? `<span class="s-a">${ri.ra}</span><span class="sep">:</span><span class="s-b">${ri.rb}</span>`
      : `<span class="s-a">${sa}</span><span class="sep">-</span><span class="s-b">${sb}</span>`;
    const curMap = (ri && ri.mapName) || heroMapName(m);
    // 在打图(大比分正下方):图序带模式=前图/当前图/下张(每张下标图N,末张真实图=最终图,当前图着重);
    // 只显示当前图模式(或无图序数据)=「第N图 · 图名」单行。riRounds(付费回合数据)同样走这套逻辑
    const stripOn = (SETTINGS && SETTINGS.mapStripMode) !== 'cur';
    const mapLine = (() => {
      if (!curMap) return '';
      const siN = ((/bo\s*(\d)/i.exec(m.format || '') || [])[1] | 0);
      const sum = m.score ? m.score[0] + m.score[1] : 0;
      const onFinal = siN >= 3 && sum === siN - 1; // 决胜图进行中
      const mapNo = (ri && ri.mapNum) || sum + 1;
      const e = mapEntryFor(m);
      const games = ((e && e.games) || []).map((g) => g.map).filter(Boolean);
      const hit = games.indexOf(curMap);
      const idx = hit >= 0 ? hit : (riRounds && ri.mapNum ? ri.mapNum - 1 : sum); // Panda 图名与 LP 短名对不上时:回合数据按图号,否则按已胜图数
      const prev = idx > 0 ? (games[idx - 1] || '') : '';
      let next = idx >= 0 && idx < games.length - 1 ? (games[idx + 1] || '') : '';
      let nextNo = idx + 2, nextFin = siN >= 3 && nextNo === siN;
      if (!next && onFinal) { next = 'Airport'; nextNo = siN + 1; nextFin = false; } // 虚构图:决胜图右侧补一张不存在的图(空港时刻)保对称,BO3=图4/BO5=图6
      if (!stripOn || (!prev && !next)) return `<div class="live-map">${esc(T('hero.map', { n: mapNo }))} · ${esc(mapZh(curMap))}</div>`;
      const slot = (cls, name, no, fin) => `<span class="${cls}"><span class="ms-name">${esc(mapZh(name))}</span><span class="ms-tag${fin ? ' fin' : ''}">${fin ? esc(T('hero.mapfinal')) : esc(T('hero.map', { n: no }))}</span></span>`;
      return `<div class="live-map map-strip ms3">${prev ? slot('ms-side ms-prev', prev, idx, false) : ''}${slot('ms-cur', curMap, mapNo, onFinal)}${next ? slot('ms-side ms-next', next, nextNo, nextFin) : ''}</div>`;
    })();
    const boLine = !riRounds && m.format ? `<div class="live-bo">${esc(m.format)}</div>` : '';
    // 大比分挂在小分正下方;迷你条不渲染(chip 小字已带"大x - y"),CSS 兜底隐藏
    const seriesLine = riRounds && m.score
      ? `<div class="series"><span class="series-label">${T('hero.series')}</span><b${sa > sb ? ' class="lead"' : ''}>${sa}</b><span class="sep">-</span><b${sb > sa ? ' class="lead"' : ''}>${sb}</b></div>`
      : '';
    // 转播 HUD 位次:「第X回合·半场」上移到比分上方(计时位),大比分在中央大数字正下方
    const half = riRounds ? window.PHASE.halfLabel(ri.ra, ri.rb, LANG()) : '';
    const preLine = riRounds
      ? `<div class="live-round ${ri.str !== prevRoundStr ? 'flash' : ''}"><span class="lr-round">${T('hero.round', { n: ri.round })}</span>${half && !/^(OT|加时)$/.test(half) ? `<span class="lr-sep">·</span><span class="lr-half">${half}</span>` : ''}</div>`
      : '';
    const isFinal = (!!m.isFinal && !window.PHASE.isThirdPlace(m.stage)) || window.PHASE.isFinalText(m.stage); // 闩锁的决赛语境仍要过季军豁免
    const tags = window.PHASE.phaseTags(m.format, m.score, riRounds ? m.live2 : null, isFinal, LANG())
      .map(([t, cls]) => `<span class="chip tag-${cls}">${esc(t)}</span>`).join('');
    HH = `
      <div class="hero-top">
        <span class="live-dot"></span><span class="chip live">LIVE</span>
        ${isPinned ? PIN_CHIP : ''}
        ${tierChip(m.eventHref)}
        ${m.format ? `<span class="chip fmt">${esc(m.format)}</span>` : ''}
        <span class="hero-ev">${esc(evName(m.event))}${m.stage ? ` <span class="stage">· ${esc(tr(m.stage))}</span>` : ''}</span>
      </div>
      <div class="hero-main">
        <div class="hero-bg-score"><span class="hbg hbg-a">${esc(sa)}</span><span class="hbg hbg-b">${esc(sb)}</span></div>
        <div class="team team-a-block ${m.teamA.isLoser ? 'loser' : ''}" data-url="${esc(m.teamA.href)}" title="${esc(m.teamA.name)}${starNames(m.teamA).length ? T('title.stars') + esc(starNames(m.teamA).join('、')) : ''}">
          ${logoHtml(m.teamA.logo, m.teamA.name)}${vA}<span class="tname"><span class="tname-txt">${esc(heroName(m.teamA))}${sideStars(m.teamA).length ? '<span class="star-mark">★</span>' : ''}</span></span>
        </div>
        <div class="score" title="${T('copy.tip.score')}">
          ${preLine}
          ${tags ? `<div class="ptags">${tags}</div>` : ''}
          <div class="num">${big}</div>
          ${mapLine}
          ${boLine}
          ${seriesLine}
        </div>
        <div class="team team-b-block ${m.teamB.isLoser ? 'loser' : ''}" data-url="${esc(m.teamB.href)}" title="${esc(m.teamB.name)}${starNames(m.teamB).length ? T('title.stars') + esc(starNames(m.teamB).join('、')) : ''}">
          ${logoHtml(m.teamB.logo, m.teamB.name)}${vB}<span class="tname"><span class="tname-txt">${esc(heroName(m.teamB))}${sideStars(m.teamB).length ? '<span class="star-mark">★</span>' : ''}</span></span>
        </div>
        ${riRounds ? `<span class="mini-map mini-only" title="${esc(ri.mapName || T('hero.map', { n: ri.mapNum }))}">${esc(T('hero.map.mini', { n: ri.mapNum }))}</span>` : ''}
        ${riRounds && m.format ? `<span class="mini-bo mini-only" title="${esc(m.format)}${esc(T('chip.rs', { rs: `${ri.ra}:${ri.rb}`, ss: `${sa} - ${sb}` }))}">${esc(m.format)}</span>` : ''}
      </div>
      <div class="hero-sub">
        ${m.pending
          ? `<span>${T('hero.waiting')}</span>`
          : `<span>${T('hero.inprogress')} · ${T('hero.elapsed')} <b data-elapsed data-ts="${m.ts}">${m.ts ? esc(fmtElapsed(Date.now() - m.ts)) : ''}</b>${CD_DOTS}</span>`}
        <span class="grow"></span>
        ${wjBtn()}
        ${m.streams && m.streams[0] ? `<button class="watch-btn" data-url="${esc(m.streams[0])}">▶ ${esc(T('watch.btn'))}</button>` : ''}
      </div>
      ${stars.length ? `<div class="hero-sub"><span class="star-mark">★ ${esc(stars.join(' · '))}</span></div>` : ''}`;
    if (ri) { prevRoundStr = ri.str; setTimeout(() => { const el = $('.live-round'); el && el.classList.remove('flash'); }, 900); }
  } else if (m && m.status === 'upcoming') {
    HERO_M = m;
    const stars = starTags(m);
    const [vA, vB] = rankBadges(m);
    hero.style.setProperty('--tc-a', tColor(m.teamA));
    hero.style.setProperty('--tc-b', tColor(m.teamB));
    // 已开赛但仍标 upcoming（LP 免费档无 running 列表）：有 LP 图序时补图序带
    const started = upcomingStarted(m.ts);
    const pe = started ? mapEntryFor(m) : null;
    const pGames = ((pe && pe.games) || []).map((g) => g.map).filter(Boolean);
    const pSum = m.score ? m.score[0] + m.score[1] : 0;
    const pCur = Math.min(pSum, pGames.length - 1);
    const strip = started && pGames.length
      ? ((SETTINGS && SETTINGS.mapStripMode) !== 'cur'
        ? `<div class="live-map map-strip">${pGames.map((g, gi) => gi === pCur
          ? `<span class="ms-cur"><span class="ms-name">${esc(mapZh(g))}</span><span class="ms-tag">${esc(T('hero.map', { n: gi + 1 }))}</span></span>`
          : `<span class="ms-side ${gi < pCur ? 'ms-prev' : 'ms-next'}"><span class="ms-name">${esc(mapZh(g))}</span><span class="ms-tag">${esc(T('hero.map', { n: gi + 1 }))}</span></span>`).join('')}</div>`
        : `<div class="live-map">${esc(T('hero.map', { n: pCur + 1 }))} · ${esc(mapZh(pGames[pCur]))}</div>`)
      : '';
    HH = `
      <div class="hero-top">
        ${isPinned ? PIN_CHIP : `<span class="chip">${T('hero.next')}</span>`}
        ${tierChip(m.eventHref)}
        ${m.format ? `<span class="chip fmt">${esc(m.format)}</span>` : ''}
        <span class="hero-ev">${esc(evName(m.event))}${m.stage ? ` <span class="stage">· ${esc(tr(m.stage))}</span>` : ''}</span>
      </div>
      <div class="hero-main">
        <div class="hero-bg-score"><span class="hbg hbg-a">0</span><span class="hbg hbg-b">0</span></div>
        <div class="team team-a-block" data-url="${esc(m.teamA.href)}" title="${esc(m.teamA.name)}${starNames(m.teamA).length ? T('title.stars') + esc(starNames(m.teamA).join('、')) : ''}">
          ${logoHtml(m.teamA.logo, m.teamA.name)}${vA}<span class="tname"><span class="tname-txt">${esc(heroName(m.teamA))}${sideStars(m.teamA).length ? '<span class="star-mark">★</span>' : ''}</span></span>
        </div>
        <div class="score" title="${T('copy.tip.pair')}">
          <div class="cd" data-cd data-ts="${m.ts}">${upcomingStarted(m.ts) ? `${T('hero.soon')}${CD_DOTS}` : esc(fmtCd(m.ts - Date.now()))}</div>
          <div class="cd-label">${m.format ? `${esc(m.format)} · ` : ''}${upcomingStarted(m.ts)
            ? `${T('hero.starts.orig', { t: fmtStartTime(m.tsPrev || m.ts) })}${m.tsPrev ? ` · ${esc(fmtShift(m.ts - m.tsPrev))}` : ''}`
            : `${fmtStartTime(m.ts)}${T('hero.starts')}${m.tsPrev ? ` · ${esc(fmtShift(m.ts - m.tsPrev))}` : ''}`}</div>
          ${strip}
        </div>
        <div class="team team-b-block" data-url="${esc(m.teamB.href)}" title="${esc(m.teamB.name)}${starNames(m.teamB).length ? T('title.stars') + esc(starNames(m.teamB).join('、')) : ''}">
          ${logoHtml(m.teamB.logo, m.teamB.name)}${vB}<span class="tname"><span class="tname-txt">${esc(heroName(m.teamB))}${sideStars(m.teamB).length ? '<span class="star-mark">★</span>' : ''}</span></span>
        </div>
      </div>
      ${stars.length ? `<div class="hero-sub"><span class="star-mark">★ ${esc(stars.join(' · '))}</span></div>` : ''}`;
  } else if (m && m.status === 'finished') {
    HERO_M = m;
    // 弃赛:无比分,比分位与背景大字显示 FF/W(W=walkover 胜方)
    const slotA = m.forfeit ? (m.teamA.isWinner ? 'W' : 'FF') : (m.score ? m.score[0] : 0);
    const slotB = m.forfeit ? (m.teamB.isWinner ? 'W' : 'FF') : (m.score ? m.score[1] : 0);
    const [vA, vB] = rankBadges(m);
    hero.style.setProperty('--tc-a', tColor(m.teamA));
    hero.style.setProperty('--tc-b', tColor(m.teamB));
    HH = `
      <div class="hero-top"><span class="chip">${T('hero.recent')}</span>
        ${tierChip(m.eventHref)}
        <span class="hero-ev">${esc(evName(m.event))}${m.stage ? ` <span class="stage">· ${esc(tr(m.stage))}</span>` : ''}</span></div>
      <div class="hero-main">
        <div class="hero-bg-score"><span class="hbg hbg-a">${slotA}</span><span class="hbg hbg-b">${slotB}</span></div>
        <div class="team team-a-block ${m.teamA.isWinner ? 'winner' : 'loser'}" title="${esc(m.teamA.name)}">${logoHtml(m.teamA.logo, m.teamA.name)}${vA}<span class="tname"><span class="tname-txt">${esc(heroName(m.teamA))}</span></span></div>
        <div class="score" title="${T('copy.tip.score')}"><div class="num"><span class="s-a">${m.forfeit ? slotA : (m.score ? m.score[0] : '')}</span><span class="sep">-</span><span class="s-b">${m.forfeit ? slotB : (m.score ? m.score[1] : '')}</span></div></div>
        <div class="team team-b-block ${m.teamB.isWinner ? 'winner' : 'loser'}" title="${esc(m.teamB.name)}">${logoHtml(m.teamB.logo, m.teamB.name)}${vB}<span class="tname"><span class="tname-txt">${esc(heroName(m.teamB))}</span></span></div>
      </div>
      <div class="hero-sub"><span>${fmtStartTime(m.ts)}${T('hero.starts')}${m.forfeit ? ` · ${esc(T('match.forfeit'))}` : ''}</span><span>· ${endAgoHtml(m)}</span></div>`;
  } else {
    HERO_M = null;
    HH = `<div class="empty">${(!META || !META.updatedAt) ? T('hero.syncing') : T('hero.empty')}</div>`;
  }
  setHtml(hero, HH);
  if (window.FXW) window.FXW.sync(); // 对撞波:versus 主题主卡氛围层,随主卡重绘挂载/摘除
}

function matchCopyText(m) { // 对阵/比分文案(主卡点击与右键菜单共用)
  const ri = roundInfo(m);
  const sa = m.score ? m.score[0] : 0, sb = m.score ? m.score[1] : 0;
  if (m.score && m.status !== 'upcoming') {
    // 直播/赛果:有回合级数据时当前图比分为主;免费档只有图号(ra 为 null),退回大比分
    const round = ri && ri.ra != null;
    return ri
      ? `${m.teamA.name} ${round ? `${ri.ra}:${ri.rb} ` : ''}${m.teamB.name} (${ri.mapName || T('hero.map', { n: ri.mapNum })}${round ? ` · ${T('copy.round', { n: ri.round })}` : ''} · ${T('copy.series', { a: sa, b: sb })}) · ${evName(m.event)}`
      : `${m.teamA.name} ${sa}:${sb} ${m.teamB.name} · ${evName(m.event)}`;
  }
  return `${m.teamA.name} vs ${m.teamB.name} · ${fmtStartTime(m.ts)}${T('hero.starts')} · ${evName(m.event)}${m.format ? ' (' + m.format + ')' : ''}`;
}
function copyHero() {
  if (!HERO_M) return;
  const text = matchCopyText(HERO_M);
  window.csapi.copyText(text).then(() => toast(T('copy.ok', { t: text })));
}

// ---------- 右键菜单(主卡/对阵行)+ GitHub 数据反馈 ----------
function fbEnv() { // 反馈环境串:白名单收集(版本/主题/窗口/字号档/不透明度/语言/图序);绝不含 token/路径/缓存
  const nt = (navigator.userAgent.match(/Windows NT ([\d.]+)/) || [])[1] || '';
  const wsize = document.body.dataset.wsize || '';
  const size = document.body.classList.contains('mini') ? '迷你条'
    : ({ xs: '极窄', s: '小卡', m: '标准', l: '大窗' }[wsize] || wsize || '?') + ` ${window.innerWidth}px`;
  const parts = [
    `v${APP_VER || '?'}`,
    (SETTINGS && SETTINGS.theme) || '-',
    size,
    `字号档${(SETTINGS && SETTINGS.fontScale) || 3}/5`,
    `不透明度${Math.round((((SETTINGS && SETTINGS.opacity) == null ? 1 : SETTINGS.opacity)) * 100)}%`,
    `界面${UIL()}`,
  ];
  if (SETTINGS && SETTINGS.mapStripMode) parts.push(SETTINGS.mapStripMode === 'band' ? '图序带' : '仅当前图');
  if (nt) parts.push(`WinNT${nt}`);
  return parts.join(' · ');
}
function fxBuildList() { // 动效设置区:列出当前主题的注册动效,逐个开关(fxOff 存 store)
  const box = $('#fx-list');
  if (!box) return;
  const off = SETTINGS.fxOff || [];
  const list = FX_REGISTRY.filter((f) => f.themes.includes(SETTINGS.theme));
  // 回环守卫:已渲染的动效 id 与勾选态和目标完全一致时不再重建——setSetting 回环触发的
  // 重建会换掉正在过渡的节点,滑块动画当场被吞(看起来瞬间跳变)
  const cur = box.querySelectorAll('input[type="checkbox"]');
  if (cur.length === list.length && list.every((f, i) => cur[i].dataset.fx === f.id && cur[i].checked === !off.includes(f.id))) return;
  box.innerHTML = list.map((f) =>
    `<label class="row-toggle fx-row"><input type="checkbox" data-fx="${f.id}"${off.includes(f.id) ? '' : ' checked'}><span>${esc(T(f.label))}</span></label>`).join('')
    || `<div class="fx-none">${esc(T('fx.none'))}</div>`;
  box.querySelectorAll('input[type="checkbox"]').forEach((inp) => {
    inp.onchange = () => {
      const id = inp.dataset.fx, cur = new Set(SETTINGS.fxOff || []);
      if (inp.checked) cur.delete(id); else cur.add(id);
      SETTINGS.fxOff = [...cur]; // 本地即改:不等主进程回环,下面的 fxApply 立刻生效(辉光这类悬停规则随之停)
      window.csapi.setSetting({ fxOff: SETTINGS.fxOff });
      window.fxApply?.();
    };
  });
}
// 值与 theme_ui.yml 主题下拉的选项文本逐字一致(预填依赖精确匹配),双语让英文用户也能看懂
const THEME_ZH = { blue: '蓝色平台 / Blue Platform', tactical: '战术沙盘 / Tactical', clear: '透明 / Clear', versus: '队色对撞 / Versus', crt: '磷光终端 / Phosphor CRT', poster: '期刊海报 / Poster', printstream: '印花集 / Printstream' };
function fbIssueUrl(kind, m) { // GitHub issue 直达:?template= 定位表单,字段按 id 预填;kind: data(默认)/theme
  if (kind === 'theme') {
    const th = (SETTINGS && SETTINGS.theme) || '';
    const p = new URLSearchParams({ template: 'theme_ui.yml', env: fbEnv() });
    p.set('title', T('fb.theme.title', { th: THEME_ZH[th] || th || '?' }));
    if (THEME_ZH[th]) p.set('theme', THEME_ZH[th]); // 下拉预填:值须与选项文本一致
    return `${FEEDBACK_REPO}/issues/new?${p}`;
  }
  if (kind === 'vrs') { // VRS 排名过期/不准:直达数据表单,标题与上下文预填
    const p = new URLSearchParams({ template: 'bug_report.yml', title: T('fb.vrs.title'), 'what-happened': T('fb.vrs.body', { d: vrsStampText(true), v: APP_VER, th: (SETTINGS && SETTINGS.theme) || '-', time: new Date().toLocaleString() }) });
    return `${FEEDBACK_REPO}/issues/new?${p}`;
  }
  const an = m ? m.teamA.name : '', bn = m ? m.teamB.name : '', ev = m ? evName(m.event) : '';
  const title = an && bn ? T('fb.title', { a: an, b: bn }) : T('fb.title.generic');
  const env = T('fb.body', { a: an, b: bn, e: ev, v: APP_VER, th: (SETTINGS && SETTINGS.theme) || '-', lg: UIL(), time: new Date().toLocaleString() });
  const p = new URLSearchParams({ template: 'bug_report.yml', title, 'what-happened': env });
  if (an && bn) p.set('match', `${an} vs ${bn}${ev ? ' · ' + ev : ''}`);
  return `${FEEDBACK_REPO}/issues/new?${p}`;
}
function openCtx(items, x, y) {
  const el = $('#ctx-menu');
  el.innerHTML = items.map((it, i) => it === '-' ? '<div class="ctx-sep"></div>'
    : `<button class="ctx-i${it.cls ? ' ' + it.cls : ''}" data-ctx-i="${i}">${it.ic ? `<span class="ci-ic">${it.ic}</span>` : ''}<span>${esc(it.label)}</span></button>`).join('');
  el.classList.add('open');
  const w = el.offsetWidth || 200, h = el.offsetHeight || 120;
  el.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
  el.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
  el.querySelectorAll('[data-ctx-i]').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); const it = items[+btn.dataset.ctxI]; closeCtx(); it && it.fn && it.fn(); };
  });
}
function closeCtx() { const el = $('#ctx-menu'); if (el) el.classList.remove('open'); }
function matchCtxItems(m) {
  const items = [];
  if (m) {
    if (m.score && m.status !== 'upcoming') items.push({ ic: '⧉', label: T('ctx.copy.score'), fn: () => copyHero() });
    for (const t of [m.teamA, m.teamB]) {
      if (!t.name) continue;
      const entry = followedTeam(t);
      const on = !!entry;
      const slug = slugOf(t.href) || t.name;
      items.push({ ic: on ? '★' : '☆', label: T(on ? 'ctx.star.unfollow' : 'ctx.star.follow', { n: t.name }), fn: () => {
        if (entry) window.csapi.starRemoveTeam(entry.id || slug);
        else window.csapi.starAddTeam({ name: t.name, href: t.href }).then(r => toast(r?.dup ? T('star.btn.dup') : T('star.btn.add', { n: t.name })));
      } });
    }
    for (const s of [...sideStars(m.teamA), ...sideStars(m.teamB)]) {
      if (s.type !== 'player' || !s.id) continue; // 高光选手单独给“取消高光”入口，队伍条目只管队伍关注
      items.push({ ic: '★', label: T('ctx.player.unstar', { n: s.name }), fn: () => window.csapi.starRemovePlayer(s.id) });
    }
    if (m.status === 'live' || m.status === 'upcoming') {
      if (heroPin === matchKey(m)) items.push({ ic: '📌', label: T('ctx.unpin'), fn: () => { heroPin = null; swapHero(); } });
      else items.push({ ic: '📌', label: T('pin.to'), fn: () => { heroPin = matchKey(m); swapHero(); } });
    }
    const url = m.hltv || m.eventHref || m.teamA.href; // 与 matchRow 行点击同一目标
    if (url) items.push({ ic: '↗', label: T('ctx.matchpage'), fn: () => window.csapi.openExternal(url) });
    if (m.streams && m.streams[0]) items.push({ ic: '▶', label: T('ctx.stream'), fn: () => window.csapi.openExternal(m.streams[0]) });
    items.push('-');
    items.push({ ic: '⧉', label: T('ctx.copy.pair'), fn: () => { const text = matchCopyText(m); window.csapi.copyText(text).then(() => toast(T('copy.ok', { t: text }))); } });
    items.push('-');
  }
  items.push({ ic: '⚑', label: T('ctx.fb'), cls: 'fb', fn: () => window.csapi.openExternal(fbIssueUrl(m)) });
  return items;
}

// ---------- 比赛列表 ----------
// 每组用 <section.list-section data-sec="..."> 包裹:题头固定在区外,行装进 .sec-body 内部滚动
function section(id, title, rowsHtml, totop) {
  const folded = !!SETTINGS?.collapsedSections?.[id];
  // 非弹性分区的收起靠点击处理器写入的内联 max-height:0;重建若只回挂类不回挂样式,
  // 会"外观展开却带着 collapsed 类"——第一次点击被脏类吃掉,第二次才能折(进行中分区 bug)
  const bodyStyle = folded && !['upcoming', 'ev-upcoming', 'recent', 'ev-done', 'ev-ongoing'].includes(id) ? ' style="max-height:0px"' : '';
  return `<section class="list-section${folded ? ' collapsed' : ''}" data-sec="${id}"><div class="list-head" data-toggle="${id}"><span class="caret"></span>${title}</div><div class="sec-body"${bodyStyle}>${rowsHtml}</div>${totop ? '<button class="to-top" data-i18n-title="totop.tip" title="回到顶部">↑</button>' : ''}</section>`;
}
// 数据推送会整树重建 innerHTML,分区滚动位置随之归零("划着划着突然回到最顶层"的根源);
// 按 data-sec 记住各 .sec-body 的 scrollTop,重建后按新内容钳位还原
// 滚动区上下被截断的行打渐隐标记(data-cut-*),视觉上"没入"相邻栏位之下;滚到头/满显时撤掉,不误伤完整行
const updateCut = (b) => {
  b.toggleAttribute('data-cut-top', b.scrollTop > 2);
  b.toggleAttribute('data-cut-bottom', b.scrollTop + b.clientHeight < b.scrollHeight - 2);
};
function setHtml(el, html) { // 修补式更新:与上一轮一字未变就不动 DOM——滚动位置/裁切标记/悬停展开/行内动画全部原样保留
  if (el._html === html) return false;
  el._html = html;
  el.innerHTML = html;
  return true;
}
function renderWithScrollKeep(el, html) {
  const keep = new Map($$('.sec-body', el).map(b => [b.closest('.list-section')?.dataset.sec, b.scrollTop]));
  if (!setHtml(el, html)) return; // 内容没变:整树不重建,滚动位置/裁切标记原样,连恢复动作都省掉
  el.innerHTML = html;
  $$('.sec-body', el).forEach(b => {
    const t = keep.get(b.closest('.list-section')?.dataset.sec);
    if (t) b.scrollTop = Math.min(t, Math.max(0, b.scrollHeight - b.clientHeight));
    updateCut(b);
  });
}
function renderMatches() {
  const el = $('#up-list');
  const { upcoming, recent, live } = sortedMatches();
  const picked = pickHero({ live, upcoming, recent }); // 主卡当前这场(置顶优先)
  MATCH_BY_KEY = {}; // 行右键菜单取数索引:key -> 比赛对象
  if (picked) MATCH_BY_KEY[matchKey(picked)] = picked;
  let html = '';
  const liveOthers = live.filter(m => m !== picked); // 被置顶占主卡的直播从"其他"让位,不重复显示
  if (liveOthers.length) { // xs/s 也渲染:最小尺寸下页签隐藏时,"直播中"分区不再跟着消失
    let rows = '';
    for (const m of liveOthers) { MATCH_BY_KEY[matchKey(m)] = m; rows += matchRow(m); } // 不设上限,区内滚动
      html += section('live-others', T('sec.live.others', { n: liveOthers.length }), rows, true);
  }
  const upsTitle = T('sec.upcoming') + (starCount(upcoming) ? T('sec.upcoming.star') : '');
  const ups = upcoming.filter(m => m !== picked); // 主卡显示谁就从列表排除谁;全量渲染,超出由区内滚动消化
  let upRows = '';
  if (!upcoming.length) upRows = `<div class="empty">${T('empty.upcoming')}</div>`;
  else for (const m of ups) { MATCH_BY_KEY[matchKey(m)] = m; upRows += matchRow(m); }
  html += section('upcoming', upsTitle, upRows, true);
  // 最近赛果:与"直播中"同位显示,故不因 short 尺寸隐藏,而做成可折叠
  if (recent.length) {
    let reRows = '';
    for (const m of recent) { MATCH_BY_KEY[matchKey(m)] = m; reRows += matchRow(m); } // 分区自带滚动,条目不设上限
    html += section('recent', T('sec.recent'), reRows, true);
  }
  renderWithScrollKeep(el, html);
  // 绑定折叠(经主进程持久化)
  $$('#up-list .list-head[data-toggle]').forEach(h => {
    h.style.cursor = 'pointer';
    h.onclick = () => {
      const sec = h.closest('.list-section');
      const id = h.dataset.toggle;
      const cur = { ...(SETTINGS?.collapsedSections || {}) };
      cur[id] = !sec.classList.contains('collapsed') ? true : false;
      if (!cur[id]) delete cur[id];
      if (SETTINGS) SETTINGS.collapsedSections = cur; // 本地同步:折叠不再回推设置,数据刷新整树重建时不会弹回
      const flexible = ['upcoming', 'ev-upcoming', 'recent', 'ev-done', 'ev-ongoing'].includes(id); // 弹性分区走纯 CSS 过渡;内容自适应分区 basis 恒为 auto,高度动画走 max-height
      const body = sec.querySelector('.sec-body');
      if (!flexible && body) {
        if (cur[id]) {
          body.style.maxHeight = body.scrollHeight + 'px';
          void body.offsetHeight; // 先定值再 reflow,否则 px→0 不产生过渡
          sec.classList.add('collapsed');
          body.style.maxHeight = '0px';
        } else {
          sec.classList.remove('collapsed');
          body.style.maxHeight = body.scrollHeight + 'px';
          setTimeout(() => { if (body.style.maxHeight) body.style.maxHeight = ''; }, 300);
        }
      } else {
        sec.classList.toggle('collapsed');
      }
      const tt = sec.querySelector(':scope > .to-top'); // 折叠即隐;展开按滚动深度立即评估(scroll 不因折叠而触发)
      if (tt) tt.classList.toggle('show', !sec.classList.contains('collapsed') && body.scrollTop > 48);
      window.csapi.setSetting({ collapsedSections: cur });
    };
  });
}
const starCount = (arr) => arr.filter(m => starScore(m) > 0).length;

// 图序:LP 赛事页弹层采到的 BP 结果(push:data.maps,key=开赛时间戳;弹层里是队伍短名,宽松匹配)
function mapEntryFor(m) {
  const arr = MAPPOOL[String(m.ts)] || [];
  if (!arr.length) return null;
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  const eq = (x, y) => { x = key(x); y = key(y); return !!x && !!y && (x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)))); };
  return arr.find((x) => eq(x.a, m.teamA?.name) && eq(x.b, m.teamB?.name))
    || arr.find((x) => eq(x.a, m.teamB?.name) && eq(x.b, m.teamA?.name))
    || (arr.length === 1 ? arr[0] : null); // 同一时间戳唯一场次直接认(并行场次靠宽松名兜底)
}
function mapsChipsHtml(m) { // 即将开始行:整条 BP 图序
  const e = mapEntryFor(m);
  if (!e || !(e.games || []).some((g) => g.map)) return '';
  return `<div class="m-maps">${e.games.filter((g) => g.map).map((g) => `<i>${esc(mapZh(g.map))}</i>`).join('')}</div>`;
}
const fmtShift = (ms) => { // 改期幅度文案:推迟/提前 X 小时(分钟)
  const adv = ms < 0;
  const mins = Math.round(Math.abs(ms) / 60000);
  const t = mins >= 60 ? (mins % 60 ? (mins / 60).toFixed(1) : String(Math.round(mins / 60))) + T('shift.hours') : String(mins) + T('shift.minutes');
  return T(adv ? 'shift.advance' : 'shift.postpone', { t });
};
function heroMapName(m) { // 无 Panda 增强时:LP 图序按已胜图数定位当前图(第1图=index 0)
  const e = mapEntryFor(m);
  if (!e || !(e.games || []).length) return '';
  return (e.games[m.score ? m.score[0] + m.score[1] : 0] || {}).map || '';
}
function curMapChip(m) { // 直播行(Panda 无回合数据时):按大小分定位当前图
  const n = heroMapName(m);
  return n ? ` · <b class="m-curmap">${esc(mapZh(n))}</b>` : '';
}
function matchRow(m) {
  const starred = starScore(m) > 0;
  const isLive = m.status === 'live';
  const ri = isLive ? roundInfo(m) : null;
  const sa = m.score ? m.score[0] : 0, sb = m.score ? m.score[1] : 0;
  // 直播行:有回合级数据→当前图比分为主、大比分为辅;无回合级数据(PandaScore 未收录/队名对不上)→
  // 大比分或"进行中",绝不显示开赛时刻——否则看起来像没同步的旧数据
  const right = ri
    ? (ri.ra != null
      ? `<div class="m-right"><div class="m-score"><span class="m-live-score">${ri.ra}:${ri.rb}</span></div><div class="m-ev">${T('copy.series', { a: sa, b: sb })} · ${T('copy.round', { n: ri.round })} · ${tierChip(m.eventHref)}${esc(evName(m.event))}</div></div>`
      : `<div class="m-right"><div class="m-score"><span class="m-live-score">${T('hero.map', { n: ri.mapNum })}</span></div><div class="m-ev">${tierChip(m.eventHref)}${esc(evName(m.event))}</div></div>`)
    : (isLive
      ? (m.pending
        ? `<div class="m-right"><div class="m-score"><span class="m-live-score">${T('hero.waiting')}</span></div><div class="m-ev">${tierChip(m.eventHref)}${esc(evName(m.event))}</div></div>`
        : m.score
        ? `<div class="m-right"><div class="m-score"><span class="m-live-score">${sa} - ${sb}</span></div><div class="m-ev">${tierChip(m.eventHref)}${esc(evName(m.event))}${curMapChip(m)}</div></div>`
        : `<div class="m-right"><div class="m-score"><span class="m-live-score">${T('hero.inprogress')}</span></div><div class="m-ev">${tierChip(m.eventHref)}${esc(evName(m.event))}${curMapChip(m)}</div></div>`)
      : ((m.forfeit || m.score) && m.status !== 'upcoming' // 弃赛(FF:W)无比分也算赛果;时间戳照旧,「弃赛」旗标写在赛事行首,阶段不被省略号吃掉
        ? `<div class="m-right"><div class="m-score"><span class="m-ago">${endAgoHtml(m)}</span></div><div class="m-ev m-evfin" title="${esc(evName(m.event))}${m.stage ? ' · ' + esc(tr(m.stage)) : ''} · ${esc(endAgoText(Date.now() - (m.endedAt || m.ts), !m.endedAt || !!m.endedApprox))}">${tierChip(m.eventHref)}<span class="m-evname">${esc(evName(m.event))}</span>${m.stage ? `<i class="m-evstage"> · ${esc(tr(m.stage))}</i>` : ''}</div></div>`
        : `<div class="m-right"><div class="m-time ${upcomingStarted(m.ts) ? 'started' : upcomingSoon(m.ts) ? 'soon' : ''}" data-mtime data-ts="${m.ts}">${upcomingStarted(m.ts) ? `${T('hero.soon')}${CD_DOTS}` : esc(upcomingTimeText(m.ts))}</div><div class="m-ev">${m.tsPrev ? `<i class="m-shift">${esc(fmtShift(m.ts - m.tsPrev))}</i>` : ''}${tierChip(m.eventHref)}${esc(evName(m.event))}${m.format ? ' · ' + esc(m.format) : ''}</div>${mapsChipsHtml(m)}</div>`));
  const url = m.hltv || m.eventHref || m.teamA.href;
  // 星标对阵:本体只保留队伍标记(左渐变+边条);悬停时行向下舒展一行,露出"xx 在阵/队伍 xx"关注内容
  const starLine = starred ? `<div class="m-star-line"><span>★ ${starTags(m).map((s) => esc(s)).join(' · ')}</span></div>` : '';
  // 奖牌标记(赛果行):总决赛胜者=冠军🏆,季军赛(3rd Place)胜者=季军🥉;isFinalText 排除半决赛
  const champ = m.status !== 'upcoming' && window.PHASE.isFinalText(m.stage);
  const bronze = m.status !== 'upcoming' && /3rd[\s_-]*place/i.test(String(m.stage || ''));
  const medal = (t) => !t.isWinner ? '' : champ ? `<span class="medal" title="${T('medal.champ')}">🏆</span>` : bronze ? `<span class="medal" title="${T('medal.bronze')}">🥉</span>` : '';
  const line = (t, side) => {
    const c = tColor(t);
    const nm = t.name || 'TBD';
    const rk = rankOf(t);
    const rkEl = rk ? `<i class="m-vrank" title="${esc(T('vrs.rank', { n: rk }))}">VRS#${rk}</i>` : '';
    // 弃赛旗标跟在弃赛队伍名后(W 侧胜者不带;FF:FF 双弃则两队都带)
    const ftag = m.forfeit && !t.isWinner ? `<i class="m-ftag">${esc(T('match.forfeit'))}</i>` : '';
    return `<span class="mline ${t.isLoser ? 'lose' : ''}"><i class="tcbar ${side}" style="--tcb:${c}"></i><span class="mname" style="--tcl:${c}" title="${esc(t.name)}${sideStars(t).length ? T('title.stars') + esc(sideStars(t).map(s => s.name).join('、')) : ''}">${esc(nm)}</span>${ftag}${medal(t)}${rkEl}${starBtnTeam({ ...t, name: nm })}</span>`;
  };
  // 大比分槽位所有行都渲染(赛果/有增强的直播=数字,即将开始/未收录直播=占位"–"),
  // 四个分区的队标 X 位才能纵向对齐;占位与数字同宽(mono 等宽 + min-width 兜底)
  const scored = !!((m.forfeit || m.score) && m.status !== 'upcoming');
  // 比分槽:正常赛果=数字;弃赛=LP 原样的 FF/W(W 侧 walkover 胜,FF:FF 双弃则两侧 FF)
  const slotA = m.forfeit ? (m.teamA.isWinner ? 'W' : 'FF') : sa;
  const slotB = m.forfeit ? (m.teamB.isWinner ? 'W' : 'FF') : sb;
  const logoCell = (t, s) => `<span class="m-lpair"><i class="m-tscore ${s == null ? 'none' : (t.isWinner ? 'w' : 'l')}">${s == null ? '–' : s}</i>${logoHtml(t.logo, t.name)}</span>`;
  const pinable = m.status === 'live' || m.status === 'upcoming'; // 赛果行不给按钮:置顶只对在赛/未赛有意义
  return `<div class="m-row ${starred ? 'starred' : ''}${pinable ? ' pin-able' : ''}" data-key="${esc(matchKey(m))}" data-url="${esc(url)}">
    <div class="m-logos" title="${esc(m.teamA.name)} vs ${esc(m.teamB.name)}">${logoCell(m.teamA, scored ? slotA : null)}${logoCell(m.teamB, scored ? slotB : null)}</div>
    <div class="m-teams"><div class="names">
      ${line(m.teamA, 'ct')}
      ${line(m.teamB, 't')}
    </div></div>
    ${right}
    ${pinable ? `<button class="pin-btn" data-pin-to="${esc(matchKey(m))}" title="${T('pin.to')}">📌</button>` : ''}
    ${starLine}
  </div>`;
}

// 解析 LP 列表行日期段字符串("Sep 05 – Sep 13" / "Sep 06–23" / "Aug 31 – Dec 12",不带年份)→ {d1,d2}(UTC 正午)。
// 年份推断:默认当年;会落在未来就整体退一年(归档条目必已完赛);跨年("Dec 30 – Jan 3")终点取次年
function dateRangeTs(s) {
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const mon = (t) => MON[String(t || '').slice(0, 3).toLowerCase()];
  const m = String(s || '').match(/([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:\s*[–—-]\s*(?:([A-Za-z]{3,9})\.?\s*)?(\d{1,2}))?/);
  if (!m || mon(m[1]) === undefined) return null;
  const y = new Date().getFullYear();
  const mk = (mo, d, yr) => Date.UTC(yr, mo, d, 12);
  const m2 = m[3] ? mon(m[3]) : mon(m[1]);
  if (m2 === undefined) return null;
  let d1 = mk(mon(m[1]), +m[2], y);
  let d2 = m[4] ? mk(m2, +m[4], y) : d1;
  if (d1 > Date.now() + 2 * 864e5) { d1 = mk(mon(m[1]), +m[2], y - 1); d2 = m[4] ? mk(m2, +m[4], y - 1) : d1; }
  if (d2 < d1) d2 = mk(m2, +m[4], y);
  return { d1, d2 };
}
// 完赛行日期副标:首选赛事级日期段(信息框 Dates 的 d1/d2,或列表行日期段字符串解析),日级精度;
// "48h 最近赛果窗口里最早一场"不是赛事开赛时间(打了好几周的赛事,窗口里只剩决赛),start 不再上屏;
// 无日期段但有真实终点(掉榜时刻)→ "结束于 X";两者皆缺 → LP 日期段原文 / "已完赛"
function doneSpan(a) {
  const loc = UIL() === 'en' ? 'en-US' : 'zh-CN';
  const day = (ts) => new Date(ts).toLocaleDateString(loc, { month: 'short', day: 'numeric' });
  const hm = (ts) => new Date(ts).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  const r = (a?.d1 && a?.d2) ? { d1: a.d1, d2: a.d2 } : dateRangeTs(a?.dates);
  if (r) {
    const span = r.d1 === r.d2 ? day(r.d1) : `${day(r.d1)} - ${day(r.d2)}`;
    const endBit = a?.end && new Date(a.end).toDateString() === new Date(r.d2).toDateString() ? ' ' + hm(a.end) : '';
    return T('ev.done.range') + span + endBit;
  }
  if (a?.end) return `${T('ev.done.ended')} ${day(a.end)} ${hm(a.end)}`;
  return a?.dates || T('ev.done.dates');
}

// 题头更新角标:只在"发现新版本"时亮起(位置常驻预留,未发现时隐藏)
function applyUpdateBadge() {
  const b = $('#upd-badge');
  if (b) b.classList.toggle('hidden', META?.update?.state !== 'available');
}

// ---------- 更新弹窗(应用内自绘) ----------
// 主进程在"窗口可见、未锁穿透、非迷你"时把新版本推到这里;否则它自己弹原生对话框兜底。
// canInstall 时多一颗「一键更新」:应用内下载 → SHA256 校验 → 重启由主进程的助手脚本换文件生效
let updUrl = '';
let updPhase = 'idle'; // idle|downloading|verifying|ready|error(镜像主进程 UPDDL.phase)
const updFailText = (m) => m === 'sha256' ? T('upd.dlg.fail.hash')
  : (m === 'no-asset' || m === 'HTTP 404') ? T('upd.dlg.fail.asset')
  : T('upd.dlg.fail', { m });
function showUpdDialog(v) {
  if (!v || !v.version) return;
  updUrl = v.url || '';
  document.body.classList.add('upd-shown'); // 主界面整体模糊化,突出弹窗
  $('#upd-ver').textContent = v.version;
  // 新版代号与寄语来自 release 说明首行(在线同步);缺失则整行隐藏,回退纯版本号
  const nc = $('#upd-code'), nq = $('#upd-quote');
  const hasNotes = !!(v.notes && v.notes.code);
  if (nc) { nc.textContent = hasNotes ? `「${v.notes.code}」` : ''; nc.classList.toggle('hidden', !hasNotes); }
  if (nq) { nq.textContent = hasNotes ? (v.notes.quote || '') : ''; nq.classList.toggle('hidden', !(hasNotes && v.notes.quote)); }
  const inst = $('#upd-install');
  if (inst) {
    updPhase = 'idle';
    inst.classList.toggle('hidden', !v.canInstall);
    inst.disabled = false;
    inst.textContent = T('upd.dlg.install');
    $('#upd-go').classList.toggle('ghost', !!v.canInstall); // 一键更新在场时,前往 GitHub 退为次按钮
  }
  $('#upd').classList.remove('hidden');
}
function hideUpdDialog() { document.body.classList.remove('upd-shown'); $('#upd').classList.add('hidden'); }

// ---------- 赛事列表 ----------
function renderEvents() {
  const el = $('#ev-list');
  const { ongoing = [], upcoming = [] } = DATA.events || {};
  const pend = META && META.sync && META.sync.events === 'pending'; // 首抓还没回来:挂起态,不显示"没有赛事"
  const bfPend = !!(DATA && DATA.tierBackfillPending); // 评级回填进行中:完赛分区亮"回填中"提示(每拍最多采一页,陆续出现)
  let liveRows = '';
  if (!ongoing.length) liveRows = `<div class="empty${pend ? ' syncing' : ''}">${pend ? T('empty.events.syncing') : T('empty.events')}</div>`;
  for (const e of ongoing) liveRows += eventRow(e, true);
  let upRows = '';
  for (const e of upcoming) upRows += eventRow(e, false);
  if (!upcoming.length && pend) upRows = `<div class="empty syncing">${T('empty.events.syncing')}</div>`;
  // 最近完赛:已掉榜、但仍在归档保留期内的赛事(名称/图标/日期沿用归档;同步未回来时不冒空分区)
  const evSlug = (h) => decodeURIComponent(String(h || '').replace(/^.*\/counterstrike\//, '').replace(/[?#].*$/, '')).toLowerCase();
  const onList = new Set([...ongoing, ...upcoming].map((e) => evSlug(e.href)));
  // 完赛判定:信息框日期段走完才算;没采到日期的必须已过掉榜宽限(end 转正)——
  // 阶段间歇(小组赛打完、淘汰赛未开)掉榜的赛事不再被当成"已完赛"
  const endedOk = (a) => {
    const d2 = a?.d2 || (a?.dates ? (dateRangeTs(a.dates) || {}).d2 : 0);
    if (d2) return Date.now() > d2 + 2 * 36e5; // 日期段结束 2h 后才进完赛分区,留时区/解析余量
    return !!a?.end;
  };
  const doneRows = Object.entries(DATA.tierArchive || {})
    .filter(([slug, a]) => slug && !onList.has(slug.toLowerCase()) && endedOk(a))
    .sort((x, y) => (y[1]?.ts || 0) - (x[1]?.ts || 0))
    .slice(0, 8)
    .map(([slug, a]) => eventRow({
      name: a?.name || slug.split('/').join(' ').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), // 旧条目没存名称时退化为美化 slug
      tier: a?.t || 'C', icon: a?.icon, href: '/counterstrike/' + slug,
      dates: doneSpan(a),
    }, false));
  const html =
    section('ev-ongoing', T('sec.ongoing'), liveRows, true) +
    section('ev-upcoming', T('sec.upcoming'), upRows, true) +
    ((doneRows.length || bfPend) && !pend ? section('ev-done', T('sec.done'), doneRows.join('') + (bfPend ? `<div class="empty syncing">${T('ev.done.syncing')}</div>` : ''), true) : '');
  renderWithScrollKeep(el, html);
  $$('#ev-list .list-head[data-toggle]').forEach(h => {
    h.style.cursor = 'pointer';
    h.onclick = () => {
      const sec = h.closest('.list-section');
      const id = h.dataset.toggle;
      const cur = { ...(SETTINGS?.collapsedSections || {}) };
      cur[id] = !sec.classList.contains('collapsed') ? true : false;
      if (!cur[id]) delete cur[id];
      if (SETTINGS) SETTINGS.collapsedSections = cur; // 本地同步:折叠不再回推设置,数据刷新整树重建时不会弹回
      const flexible = ['upcoming', 'ev-upcoming', 'recent', 'ev-done', 'ev-ongoing'].includes(id); // 弹性分区走纯 CSS 过渡;内容自适应分区 basis 恒为 auto,高度动画走 max-height
      const body = sec.querySelector('.sec-body');
      if (!flexible && body) {
        if (cur[id]) {
          body.style.maxHeight = body.scrollHeight + 'px';
          void body.offsetHeight; // 先定值再 reflow,否则 px→0 不产生过渡
          sec.classList.add('collapsed');
          body.style.maxHeight = '0px';
        } else {
          sec.classList.remove('collapsed');
          body.style.maxHeight = body.scrollHeight + 'px';
          setTimeout(() => { if (body.style.maxHeight) body.style.maxHeight = ''; }, 300);
        }
      } else {
        sec.classList.toggle('collapsed');
      }
      const tt = sec.querySelector(':scope > .to-top'); // 折叠即隐;展开按滚动深度立即评估(scroll 不因折叠而触发)
      if (tt) tt.classList.toggle('show', !sec.classList.contains('collapsed') && body.scrollTop > 48);
      window.csapi.setSetting({ collapsedSections: cur });
    };
  });
}
function eventRow(e, live) {
  return `<div class="e-row" data-url="${esc(e.href)}">
    <span class="tier ${esc(e.tier)}" title="${esc(T('tier.title', { t: tierLabel(e.tier) }))}">${esc(tierLabel(e.tier))}</span>
    ${logoHtml(e.icon, e.name)}
    <div class="e-body">
      <div class="e-name">${esc(evName(e.name))}</div>
      <div class="e-dates">${esc(trDates(e.dates))}</div>
    </div>
    ${live ? `<span class="e-live-tag">LIVE</span>` : ''}
  </div>`;
}

// ---------- 变阵列表 ----------
function renderTransfers() {
  const el = $('#tr-list');
  const rows = DATA.transfers || [];
  const newIds = (META && META.newTransferIds) || [];
  const starredPlayers = new Set((SETTINGS?.starPlayers || []).map(p => (p.id || '').toLowerCase()));
  const pend = META && META.sync && META.sync.transfers === 'pending'; // 首抓还没回来:挂起态
  if (!rows.length) { setHtml(el, `<div class="empty${pend ? ' syncing' : ''}">${pend ? T('empty.transfers.syncing') : T('empty.transfers')}</div>`); return; }
  setHtml(el, rows.map(t => {
    const dir = window.I18N.transferDir ? window.I18N.transferDir(t) : t.direction; // 青训⇄一线队:擢升修正为"加入"流向
    const arrow = dir === 'in' ? '→' : dir === 'out' ? '←' : '~';
    const toTeam = dir === 'out' ? t.oldTeam : t.newTeam;
    const fromTeam = dir === 'out' ? '' : (t.oldTeam ? t.oldTeam + ' → ' : '');
    const isNew = newIds.includes(t.id);
    const pSlug = slugOf(t.playerHref);
    const pOn = starredPlayers.has(pSlug.toLowerCase());
    const hintTeam = dir === 'out' ? t.oldTeam : t.newTeam;
    const hintHref = dir === 'out' ? t.oldTeamHref : t.newTeamHref;
    return `<div class="t-row ${pOn ? 'starred' : ''}" data-url="${esc(t.ref || t.playerHref)}">
      ${logoHtml(t.newLogo || t.oldLogo, toTeam)}
      <span class="t-dir ${esc(dir)}">${arrow}</span>
      <div class="t-body">
        <div class="t-player"><span class="t-pname">${esc(t.player)}</span><span class="flag">${esc(window.I18N.country(t.flag, UIL()))}</span>${t.note ? `<span class="t-note">${esc(window.I18N.transferNote ? window.I18N.transferNote(t, ROLELANG()) : window.I18N.roleLabel(t.note, ROLELANG()))}</span>` : ''}</div>
        <div class="t-teams">${esc(fromTeam)}<b>${esc(toTeam || T('ntf.free'))}</b></div>
        <div class="t-story"><span>${esc(window.I18N.transferStory(t, UIL(), STORYSTYLE()))}</span></div>
      </div>
      ${isNew ? '<span class="new-badge">NEW</span>' : ''}
      <button class="star-btn ${pOn ? 'on' : ''}" data-star-player data-slug="${esc(pSlug)}" data-name="${esc(t.player)}" data-hint-team="${esc(hintTeam)}" data-hint-href="${esc(hintHref)}" title="${pOn ? T('player.unstar.btn') : T('player.star.btn')}">★</button>
      <span class="t-date">${esc(t.date.slice(5))}</span>
    </div>`;
  }).join(''));
}

// ---------- 设置面板:关注列表 + 搜索建议 ----------
function renderStars() {
  const pl = $('#star-players'), tl = $('#star-teams');
  if (!pl || !tl) return;
  const players = SETTINGS?.starPlayers || [];
  const teams = SETTINGS?.starTeams || [];
  pl.innerHTML = players.map(p => `<div class="star-item">
    <span class="s-glyph">★</span><span class="s-name">${esc(p.name)}</span>
    <span class="s-team">${p.resolving && !p.team ? T('player.resolving') : (p.team ? esc(p.team) : (p.err ? T('player.err') : T('player.unk')))}</span>
    <button class="s-del" data-del-player="${esc(p.id)}" title="${T('del.tip')}">✕</button>
  </div>`).join('');
  tl.innerHTML = teams.map(t => `<div class="star-item">
    <span class="s-glyph">☆</span><span class="s-name">${esc(t.name)}</span>
    <span class="s-team">${T('star.team.tag')}</span>
    <button class="s-del" data-del-team="${esc(t.id)}" title="${T('del.tip')}">✕</button>
  </div>`).join('');
}

async function doSearch(q) {
  const box = $('#star-sugs');
  if (!q || q.length < 2) { box.classList.add('hidden'); return; }
  const res = await window.csapi.searchPlayers(q);
  if (!$('#star-search').matches(':focus')) { // 请求回来时已失焦:防抖迟到结果不再弹出挡住下方内容
    box.classList.add('hidden');
    return;
  }
  if (res?.err) { // 限流/网络错误显式反馈,不再静默变"没反应"
    box.innerHTML = `<div class="sug-err">${esc(res.err)}</div>`;
    box.classList.remove('hidden');
    return;
  }
  const items = res?.items || [];
  if (!items.length) { box.innerHTML = `<div class="sug-empty">${esc(T('sug.none'))}</div>`; box.classList.remove('hidden'); return; }
  // PandaScore 结果带 slug+当前队伍,点击即可入库免二次解析;Liquipedia 回退结果只有 href
  box.innerHTML = items.map(r => `<div class="sug" data-sug-name="${esc(r.title)}" data-sug-href="${esc(r.href || '')}"${r.slug ? ` data-sug-slug="${esc(r.slug)}" data-sug-team="${esc(r.team || '')}" data-sug-team-slug="${esc(r.teamSlug || '')}"` : ''}>${esc(r.title)}${r.team ? `<span class="sug-team">${esc(r.team)}</span>` : ''}</div>`).join('');
  box.classList.remove('hidden');
}

// ---------- 设置分区 ----------
// 左侧分区条是锚点导航:右侧五个分区一页连滚到底,不再有页签显隐;滚动时左条高亮当前分区(scrollspy)
// 分区归属由 index.html 的 .set-sec[data-sec] 包裹表达,不再依赖与 DOM 顺序耦合的位置数组
function setScrollTo(sec) {
  const sc = $('#set-scroll'), el = $(`#settings .set-sec[data-sec="${sec}"]`);
  if (!sc || !el) return;
  sc.scrollTo({ top: el.offsetTop, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); // .set-scroll 是定位父级,offsetTop 即目标滚位
}
function applySetSpy() {
  const sc = $('#set-scroll');
  if (!sc) return;
  const secs = $$('#settings .set-sec');
  if (!secs.length) return;
  let cur = secs[0];
  secs.forEach((s) => { if (s.offsetTop <= sc.scrollTop + 8) cur = s; });
  if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) cur = secs[secs.length - 1]; // 滑到底时末区可能不满一屏、顶部够不到阈值,强制高亮末区
  $$('#set-rail .set-nav').forEach((b) => b.classList.toggle('on', b.dataset.stab === cur.dataset.sec));
}
// 设置面板锚位：顶边贴主卡底缘，只盖下方比赛/赛事列表区（不盖主卡/标题栏）；窗口过矮时保底留 140px
function placeSettings() {
  const s = $('#settings');
  if (s.classList.contains('hidden')) return;
  const hero = $('#hero');
  const bottom = hero ? hero.getBoundingClientRect().bottom : 0;
  s.style.top = Math.max(0, Math.min(bottom + 4, window.innerHeight - 140)) + 'px';
}
// VRS 更新时间(full=设置行完整日期时间;题头只出 月/日):信源是 LP 页面自带的数据更新标注,主进程记 changedAt
function vrsStampText(full) {
  const r = DATA && DATA.rankings;
  const ts = r && r.stampSrc ? (r.changedAt || 0) : 0; // 只信页面标注写入的日期(stampSrc=page):旧缓存里本地抓取出的日期一律显示'—',首轮全量刷新后自愈
  if (!ts) return '—';
  const d = new Date(ts), loc = UIL() === 'en' ? 'en-US' : 'zh-CN';
  return full
    ? d.toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' }) // 数据日期只有"日":不展示时分,避免冒出精确到分的假精度
    : d.toLocaleDateString(loc, { month: 'numeric', day: 'numeric' });
}
// ---------- 同步状态 ----------
function renderMeta() {
  const dot = $('#sync-dot');
  dot.className = 'sync-dot ' + (META.err ? 'err' : META.stale ? 'stale' : 'ok');
  dot.title = META.err ? T('sync.err', { e: META.err }) : META.stale ? T('sync.stale') : T('sync.dot');
  $('#updated').textContent = agoText(META.updatedAt);
  const vf = $('#vrs-foot');
  if (vf) vf.textContent = 'VRS · ' + vrsStampText(false);
  footFit(); // VRS 日期刚变长:挤了就撤未开播主播
  const vs = $('#vrs-updated');
  if (vs) vs.textContent = vrsStampText(true);
  const badge = $('#tr-badge');
  const n = ((META.newTransferIds) || []).length;
  badge.textContent = n;
  badge.classList.toggle('hidden', !n);
}

// ---------- 每秒更新的动态文本 ----------
setInterval(() => {
  // 倒计时目标以主卡元素自带的 data-ts 为准:置顶的未来场次在数据源有其他直播比赛时也要照常走秒
  // (旧实现取"数据源最近一场"且要求无任何直播才更新,会冻结主卡、或把别场比赛的倒计时写进来)
  const cdEl = $('[data-cd]');
  if (cdEl && +cdEl.dataset.ts) {
    const ts = +cdEl.dataset.ts;
    if (upcomingStarted(ts)) {
      if (cdEl.dataset.dot !== '1') { cdEl.dataset.dot = '1'; cdEl.innerHTML = `${T('hero.soon')}${CD_DOTS}`; } // 进态只写一次,保住动画
    } else {
      delete cdEl.dataset.dot;
      odText(cdEl, fmtCd(ts - Date.now()));
    }
  }
  $$('[data-elapsed]').forEach(el => {
    const ts = +el.dataset.ts;
    if (ts) el.textContent = fmtElapsed(Date.now() - ts);
  });
  $$('[data-mtime]').forEach(el => {
    const ts = +el.dataset.ts;
    if (!ts) return;
    if (upcomingStarted(ts)) {
      if (el.dataset.dot !== '1') { el.dataset.dot = '1'; el.innerHTML = `${T('hero.soon')}${CD_DOTS}`; } // 同主卡:进态只写一次
    } else {
      delete el.dataset.dot;
      el.textContent = upcomingTimeText(ts);
    }
    el.classList.toggle('soon', upcomingSoon(ts));
    el.classList.toggle('started', upcomingStarted(ts));
  });
  $$('[data-endts]').forEach(el => {
    el.textContent = endAgoText(Date.now() - +el.dataset.endts, !!el.dataset.approx);
  });
  const upd = $('#updated');
  if (upd && META) upd.textContent = agoText(META.updatedAt);
}, 1000);

// ---------- 自绘下拉:原生 select 弹窗在部分 Win11 上是系统白底,页面任何配色都吃不到 ----------
// <select> 隐藏保留为数据源(值/onchange 绑定全不动),点击弹出全 DOM 列表,样式完全随主题变量
function initSelWrap() {
  document.querySelectorAll('#settings select').forEach((sel) => {
    if (sel.dataset.selx) return;
    sel.dataset.selx = '1';
    const wrap = document.createElement('div');
    wrap.className = 'selwrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    const face = document.createElement('div');
    face.className = 'sel-face';
    const pop = document.createElement('div');
    pop.className = 'sel-pop hidden';
    wrap.appendChild(face);
    wrap.appendChild(pop);
    const label = () => { const o = sel.options[sel.selectedIndex]; return o ? o.textContent : ''; };
    const closePop = () => { pop.classList.add('hidden'); document.removeEventListener('pointerdown', onDoc, true); };
    const onDoc = (e) => { if (!wrap.contains(e.target)) closePop(); };
    const syncPop = () => {
      pop.innerHTML = '';
      [...sel.options].forEach((o) => {
        const it = document.createElement('div');
        it.className = 'sel-opt' + (o.value === sel.value ? ' on' : '');
        it.textContent = o.textContent;
        it.onclick = () => {
          if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          face.textContent = label();
          closePop();
        };
        pop.appendChild(it);
      });
    };
    face.onclick = () => {
      if (pop.classList.contains('hidden')) {
        document.querySelectorAll('.sel-pop:not(.hidden)').forEach((p) => p.classList.add('hidden')); // 先收其他开着的
        syncPop();
        pop.classList.remove('hidden');
        document.addEventListener('pointerdown', onDoc, true);
      } else closePop();
    };
    sel.addEventListener('change', () => { face.textContent = label(); });
    face.textContent = label();
  });
  document.addEventListener('keydown', (e) => { // Esc 收起自绘下拉
    if (e.key === 'Escape') document.querySelectorAll('.sel-pop:not(.hidden)').forEach((p) => p.classList.add('hidden'));
  });
}
function syncSelFaces() { // i18n 重译选项文案 / applySettings 写值后,自绘面板文字同步刷新
  document.querySelectorAll('#settings select[data-selx]').forEach((sel) => {
    const face = sel.closest('.selwrap')?.querySelector('.sel-face');
    if (face) { const o = sel.options[sel.selectedIndex]; face.textContent = o ? o.textContent : ''; }
  });
}
initSelWrap();

// ---------- 界面静态文案(data-i18n* 属性 -> UI 词典) ----------
// 「关于」页签:版本行(版本号 · 中文代号 · 更新状态)与本版寄语;署名随界面语言切换
function refreshAbout() {
  const av = $('#about-ver');
  if (av) av.textContent = 'v' + (APP_VER || '?');
  // 本版代号/寄语优先取在线修订(远端已确认当前版为最新时,update.notes 即当前版的 release 说明),
  // 离线或检测失败回退随包的 RELEASE_NOTES,保证永不空白
  const remote = META?.update?.state === 'latest' ? META.update.notes : null;
  const rn = (remote && remote.code) ? remote : (RELEASE_NOTES[APP_VER] || null);
  const ac = $('#about-code');
  if (ac) { ac.textContent = rn ? '「' + rn.code + '」' : ''; ac.hidden = !rn; }
  const box = $('#about-quote-box');
  if (box) box.hidden = !rn;
  if (rn) {
    const q = $('#about-quote');
    if (q) q.textContent = rn.quote;
  }
  const sg = $('#about-sign'); // 署名贴在应用徽记旁(作者),与寄语无关
  if (sg) sg.textContent = UIL() === 'en' ? '© LikeRavine233' : '© 若谷LikeRavine';
}
function applyI18n() {
  const lang = UIL();
  const langChanged = applyI18n.last && applyI18n.last !== lang;
  applyI18n.last = lang;
  $$('[data-i18n]').forEach(el => { el.textContent = window.I18N.uit(el.dataset.i18n, lang); });
  $$('[data-i18n-title]').forEach(el => { el.title = window.I18N.uit(el.dataset.i18nTitle, lang); });
  $$('[data-i18n-tip]').forEach(el => { el.dataset.tip = window.I18N.uit(el.dataset.i18nTip, lang); });
  $$('[data-i18n-ph]').forEach(el => { el.placeholder = window.I18N.uit(el.dataset.i18nPh, lang); });
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  if (STREAMER_LIST.length) renderStreamers({ list: STREAMER_LIST, twitchOn: STREAMER_TWON }); // 语言切换:页脚解说立即换阵营(不等下轮推送)
  pandaNote(); // token 状态行随词典立即重译(旧语言文字会一直挂到下轮推送才消失)
  if (langChanged && DATA) { renderAll(); renderStars(); } // 语言真的切了才重渲染:列表/主卡/星标注(队伍 xx 等)立即换语言
  syncSelFaces(); // 自绘下拉的面板文字随词典重译同步
  refreshAbout(); // 关于页签:寄语署名随语言、版本号随主进程 payload 刷新
}

// ---------- 主题/设置应用 ----------
let themeClickAt = null; // 最近一次主题卡片点击的视口坐标(扩散动画起点;程序性切主题不带坐标则直切)
function applySettings(s, rerender = true) {
  // 主题切换圆形扩散:本次设置的【全部】视觉变更都延后到 View Transition 回调里执行。
  // 若只包主题属性,对撞波摘除/卡片高亮等仍会抢在扩散前同步变化,旧快照截不到"切换前"的样子。
  const rv = themeClickAt && document.startViewTransition
    && s.theme !== document.body.dataset.theme
    && !matchMedia('(prefers-reduced-motion: reduce)').matches
    ? { ...themeClickAt } : null;
  themeClickAt = null;
  if (!rv) { applySettingsNow(s, rerender); return; }
  // 终径取点击点到四角的最远距离,保证扩散收尾时旧主题无残留
  const r = Math.hypot(Math.max(rv.x, innerWidth - rv.x), Math.max(rv.y, innerHeight - rv.y));
  const toClear = s.theme === 'clear';
  const vt = document.startViewTransition(() => applySettingsNow(s, rerender));
  vt.ready.then(() => {
    const opt = { duration: 480, easing: 'cubic-bezier(.4, 0, .2, 1)' };
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${rv.x}px ${rv.y}px)`, `circle(${r}px at ${rv.x}px ${rv.y}px)`] },
      { ...opt, pseudoElement: '::view-transition-new(root)' }
    );
    // 切去透明主题:窗口级透明快照表达不了(快照只含 DOM 画出的内容),给旧快照同步反向挖洞,
    // 洞里露出真实桌面(窗口本身常驻透明);新快照圈外被裁、旧快照圈内被挖,两圆严格同步互补。
    if (toClear) {
      const hole = (rad) => `radial-gradient(circle ${rad}px at ${rv.x}px ${rv.y}px, transparent 99.5%, #000 100%)`;
      document.documentElement.animate(
        { maskImage: [hole(0), hole(r)], webkitMaskImage: [hole(0), hole(r)] },
        { ...opt, pseudoElement: '::view-transition-old(root)' }
      );
    }
    // 从透明切来不用挖洞:旧快照的透明区直接透到桌面,与切换前的真实样子一致。
  }).catch(() => {}); // 连续快速切换时后一次会使前一次 skip,ready 随之 reject,静默即可
}
function applySettingsNow(s, rerender = true) {
  SETTINGS = s;
  applyI18n(); // 界面静态文案随语言刷新(设置面板/标题栏)
  document.body.dataset.theme = s.theme;
  document.body.dataset.acrylic = ACRYLIC ? 'on' : 'off';
  syncGlassMode();
  // 深色主题挂 theme-active 触发斜向条纹缓慢滚动(蓝色平台是亮色不透明风,不挂:overlay 混合层是
  // 合成器最贵的动效,且会盖色)
  document.body.classList.toggle('theme-active', ['crt', 'tactical', 'versus'].includes(s.theme));
  document.body.dataset.lowpower = s.lowPower ? '1' : '0';
  document.body.dataset.fx = fxEnabledIds().join(' '); // 主题动效注册表:当前主题且未被单独关闭的动效 id
  if (window.FXW) window.FXW.sync(); // 主题/动效开关/低功耗变化:对撞波同步挂载或摘除
  fxBuildList();
  document.documentElement.style.setProperty('--op', String(s.opacity ?? 1));
  applyLowop(s.opacity);
  document.body.classList.toggle('mini', !!s.mini);
  document.body.dataset.fs = String(s.fontScale || 3); // 五档字号:CSS 端 --fs 变量驱动内容文字缩放
  document.documentElement.dataset.zhfont = s.zhFont || 'noto'; // 中文字体:noto(默认)/misans/yahei,驱动 CSS --zh 变量(须挂 html,见 style.css :root)
  // 设置面板控件状态
  $$('.theme-card').forEach(c => c.classList.toggle('active', c.dataset.themePick === s.theme));
  $('#op-slider').value = Math.round((s.opacity ?? 1) * 100);
  $('#op-val').textContent = Math.round((s.opacity ?? 1) * 100) + '%';
  const ul = $('#uilang-sel');
  if (ul) ul.value = s.uiLang || 'zh';
  const ls = $('#lang-sel');
  if (ls) ls.value = s.lang || 'zh';
  const ml = $('#map-lang-sel');
  if (ml) ml.value = s.mapLang || 'zh';
  const rl = $('#role-lang-sel');
  if (rl) rl.value = s.roleLang || 'zh';
  const ssSel = $('#story-style-sel');
  if (ssSel) ssSel.value = s.storyStyle || 'pro';
  const msSel = $('#map-strip-sel');
  if (msSel) msSel.value = s.mapStripMode || 'band';
  const fsSel = $('#fs-sel');
  if (fsSel) fsSel.value = String(s.fontScale || 3);
  const ut = $('#upcoming-time-sel');
  if (ut) ut.value = s.upcomingTime || 'both';
  const en = $('#ev-name-sel');
  if (en) en.value = s.eventNameMode || 'abbr';
  $('#interval-sel').value = String(s.intervalMin ?? 3);
  const rcSel = $('#rowclick-sel');
  if (rcSel) rcSel.value = s.rowClickAction || 'open';
  $('#tg-ontop').checked = !!s.onTop;
  // 顶栏图钉按钮的 active 态:置顶时高亮、未置顶时弱化
  const pin = $('#btn-pin');
  if (pin) { pin.setAttribute('aria-pressed', s.deskPin ? 'true' : 'false'); pin.classList.toggle('on', !!s.deskPin); pin.title = s.deskPin ? T('pin.title.on') : T('pin.title.off'); }
  const blurSlider = $('#glass-blur');
  if (blurSlider) {
    blurSlider.value = Math.round(s.glassBlur ?? 28);
    const bv = $('#blur-val');
    if (bv) bv.textContent = Math.round(s.glassBlur ?? 28) + 'px';
  }
  document.documentElement.style.setProperty('--glass-blur', (s.glassBlur ?? 28) + 'px');
  const mini = $('#btn-mini');
  if (mini) { mini.setAttribute('aria-pressed', s.mini ? 'true' : 'false'); mini.classList.toggle('on', !!s.mini); }
  const th = $('#tg-hidebar');
  if (th) th.checked = !!s.hideTaskbar;
  const tgg = $('#tg-glass');
  if (tgg) tgg.checked = s.captureGlass !== false;
  $('#tg-notify').checked = !!s.notifyTransfers;
  $('#tg-autostart').checked = !!s.autostart;
  $('#tg-prematch').checked = s.notifyPreMatch !== false;
  $('#tg-prematch-starred').checked = s.preMatchStarredOnly !== false;
  $('#tg-results').checked = s.notifyResults !== false;
  $('#tg-lowpower').checked = !!s.lowPower;
  $('#prematch-min').value = String(s.preMatchMin ?? 10);
  const df = $('#date-fmt-sel');
  if (df) df.value = s.dateFormat || 'smart';
  const tzSel = $('#tz-sel');
  if (tzSel) tzSel.value = s.timezone || '';
  const zfSel = $('#zhfont-sel');
  if (zfSel) zfSel.value = s.zhFont || 'noto';
  $$('.size-card').forEach(c => c.classList.toggle('active', c.dataset.sizePick === (s.sizePreset || 'm')));
  const pt = $('#panda-token');
  if (pt && document.activeElement !== pt) pt.value = s.pandaToken || '';
  const twIdIn = $('#twitch-id'), twSecIn = $('#twitch-secret');
  if (twIdIn && document.activeElement !== twIdIn) twIdIn.value = s.twitchClientId || '';
  if (twSecIn && document.activeElement !== twSecIn) twSecIn.value = s.twitchSecret || '';
  renderStars();
  syncSelFaces(); // 设置值写入 select 后同步自绘面板文字
  if (rerender) renderAll(true);
}

// ---------- 尺寸分级布局 ----------
// 参照 Apple HIG 小组件阶梯 + Win11 体育组件"拖大显示更多":
// xs/s(<365px):只保留主卡+接下来几场(隐藏页签/页脚);m:标准; l(≥450px):加大字号与行距、显示更多
// short(<560px 高):收起页脚与最近赛果
let WSIZE = 'm';
let sizeTimer = null;

function applySize(rerender = true) {
  const w = window.innerWidth, h = window.innerHeight;
  const ws = w < 330 ? 'xs' : w < 365 ? 's' : w < 450 ? 'm' : 'l';
  const short = h < 560;
  const changed = ws !== WSIZE;
  WSIZE = ws;
  document.body.dataset.wsize = ws;
  document.body.classList.toggle('short', short);
  if ((ws === 'xs' || ws === 's') && tab !== 'matches') switchTab('matches'); // 小尺寸只留比赛页
  if (changed && rerender) renderAll(true);
  placeSettings();
  return { ws, short };
}

function renderAll(keepScroll = false) {
  const appEl = $('#app');
  if (appEl && appEl.scrollTop) appEl.scrollTop = 0; // #app 是 overflow:hidden 容器,可能被 scrollIntoView 程序化滚走,渲染时兜底复位
  const body = $(`.tab-body:not(.hidden)`);
  const st = keepScroll && body ? body.scrollTop : 0;
  renderHero(); renderMatches(); renderEvents(); renderTransfers(); renderMeta();
  if (keepScroll && body) body.scrollTop = st;
  placeSettings(); // 主卡高度随数据变化(如进图/换局)时，开着的设置面板跟随锚位
  foldMeasure(); // 题头内容宽变了(如"x分钟前同步"):重测各档所需窗宽并归位当前档
}

// ---------- 题头折叠:实测驱动,不用固定像素断点 ----------
// 各档位"所需最小窗宽"在内容变化时实测缓存(foldMeasure,短暂关过渡;拖窗路径不经过它);
// 拖窗时只做纯算术比较+换类(foldEval),过渡全程不被打断,中间档位逐级出现。
// 不能"穿上档位立刻量"来定档:max-width 过渡 300ms 才放完空间,当场量到的还是旧布局,
// 会把档位一路推到全收/全开(上一版的教训)。
let foldReq = []; // foldReq[l] = 折到 l 档时题头内容所需的最小窗宽
function foldMeasure() {
  const tb = $('#titlebar');
  const pill = tb && $('.sync-pill', tb);
  if (!tb || !pill || !tb.clientWidth) return; // mini/隐藏态:量不了,维持现状
  tb.classList.add('fold-measure'); // 测量态:试档瞬时生效,不触发过渡
  foldReq = [];
  for (let l = 0; l <= 4; l++) {
    tb.classList.remove('fold1', 'fold2', 'fold3', 'fold4');
    for (let i = 1; i <= l; i++) tb.classList.add('fold' + i);
    foldReq.push(pill.offsetLeft + pill.offsetWidth + 6 + 96); // 胶囊右缘+6px 余量+按钮保留区
  }
  // 归位前仍在测量态(过渡关)提交目标档:测量最后一试是全收态,若带着过渡归位,
  // 题头所有元素会从全收值"放"回目标值——整条题头闪一下(不相关元素也闪,上一版的教训)
  let lvl = 4;
  for (let l = 0; l <= 4; l++) { if (tb.clientWidth >= foldReq[l]) { lvl = l; break; } }
  tb.classList.remove('fold1', 'fold2', 'fold3', 'fold4');
  for (let i = 1; i <= lvl; i++) tb.classList.add('fold' + i);
  void tb.offsetWidth; // 过渡仍关着提交目标值,再恢复过渡:恢复时无值变化,不触发任何动画
  tb.classList.remove('fold-measure');
}
function foldApply() {
  const tb = $('#titlebar'); if (!tb) return;
  let lvl = 4;
  for (let l = 0; l <= 4; l++) { if (!foldReq[l] || tb.clientWidth >= foldReq[l]) { lvl = l; break; } } // 最小的够用档
  tb.classList.remove('fold1', 'fold2', 'fold3', 'fold4');
  for (let i = 1; i <= lvl; i++) tb.classList.add('fold' + i);
}
function foldEval() { foldApply(); } // 拖窗入口:纯算术定档,不打断过渡

// ---------- 事件绑定 ----------
function bindEvents() {
  // 圈问号气泡:body 单例 fixed 浮层(行内 ::after 会撑出窗口被 #app 裁切),悬停时左右钳在视口内、底部不够就翻到圈上方
  const tipEl = document.createElement('div');
  tipEl.id = 'global-tip';
  document.body.appendChild(tipEl);
  const tipShow = (q) => {
    tipEl.textContent = q.dataset.tip || '';
    if (!tipEl.textContent) return;
    tipEl.style.maxWidth = Math.min(260, window.innerWidth - 16) + 'px';
    tipEl.classList.add('open');
    const r = q.getBoundingClientRect();
    let top = r.bottom + 7;
    if (top + tipEl.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - tipEl.offsetHeight - 7);
    tipEl.style.top = top + 'px';
    tipEl.style.left = Math.min(Math.max(8, r.right - tipEl.offsetWidth), window.innerWidth - tipEl.offsetWidth - 8) + 'px';
  };
  document.addEventListener('mouseover', (e) => {
    const q = e.target && e.target.closest ? e.target.closest('.set-q') : null;
    if (q) tipShow(q); else tipEl.classList.remove('open');
  }, true);
  document.addEventListener('click', (e) => { // 点击圈问号同样出提示（悬停之外的第二路径）
    const q = e.target && e.target.closest ? e.target.closest('.set-q') : null;
    if (q) tipShow(q);
  }, true);
  $('#settings').addEventListener('scroll', () => tipEl.classList.remove('open'), { passive: true });
  // 分区滚动混合模式:慢滚逐行步进(一次一格);150ms 内连滚 3 次以上判定高速,放行原生自由滚动。
  // 收尾对齐交给 .sec-body 的 CSS scroll-snap(proximity),自由滚动停在哪都能轻吸回行边
  let wCount = 0, wLast = 0;
  document.addEventListener('wheel', (e) => {
    const sec = e.target && e.target.closest ? e.target.closest('.sec-body') : null;
    if (!sec || e.ctrlKey) return;
    if (sec.scrollHeight <= sec.clientHeight + 1) return;
    const now = Date.now();
    wCount = now - wLast < 150 ? wCount + 1 : 1;
    wLast = now;
    if (wCount >= 3) return; // 高速连滚:解锁,交给原生滚动 + snap 收尾
    e.preventDefault();
    const rows = sec.querySelectorAll('.m-row, .e-row, .t-row');
    const pitch = rows.length > 1 ? rows[1].offsetTop - rows[0].offsetTop : (rows[0] ? rows[0].offsetHeight : 40); // 真实行距,差一点多滑几次必穿帮
    const dir = e.deltaY > 0 ? 1 : -1;
    const maxTop = sec.scrollHeight - sec.clientHeight;
    const target = Math.max(0, Math.min(maxTop, Math.round(sec.scrollTop / pitch) * pitch + dir * pitch));
    sec.scrollTo({ top: target, behavior: 'smooth' });
  }, { passive: false });
  // 分区滚动时刷新上下边界渐隐标记(scroll 不冒泡,用捕获委托;重渲染出的节点无需重新绑定)
  document.addEventListener('scroll', (e) => { // 捕获阶段:分区裁切标记 + 各滚动容器自己的回顶钮亮/熄
    const b = e.target;
    const isSec = !!(b.classList && b.classList.contains('sec-body'));
    if (!isSec && !(b.classList && b.classList.contains('list'))) return;
    if (isSec) updateCut(b);
    const btn = isSec ? b.closest('.list-section')?.querySelector(':scope > .to-top')
      : b.closest('.tab-body')?.querySelector(':scope > .to-top');
    if (btn) btn.classList.toggle('show', b.scrollTop > 48);
  }, { capture: true, passive: true });
  // 失焦态:系统背板 acrylic 失焦会去饱和,渲染层加深打底保对比(主进程 push:focus)
  window.csapi.onFocus?.((f) => { document.body.dataset.unfocused = f ? '0' : '1'; });

  $('#btn-settings').onclick = () => {
    const s = $('#settings');
    const opening = s.classList.contains('hidden');
    s.classList.toggle('hidden');
    if (opening) { placeSettings(); const sc = $('#set-scroll'); if (sc) sc.scrollTop = 0; applySetSpy(); }
  };
  $$('#set-rail .set-nav').forEach((b) => b.onclick = () => setScrollTo(b.dataset.stab));
  $('#set-scroll').addEventListener('scroll', applySetSpy, { passive: true });
  $('#set-close').onclick = () => $('#settings').classList.add('hidden');
  $$('.set-q').forEach(q => q.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); })); // 圈问号悬停出说明;在 label 内时防点击误触开关
  $('#btn-mini').onclick = () => window.csapi.setMini(!SETTINGS?.mini); // 顶栏迷你按钮可切换进出
  $('#btn-pin').onclick = () => { // 图钉:钉在桌面(不置顶,其他窗口可覆盖,不受 Win+D 影响)
    const next = !SETTINGS?.deskPin;
    window.csapi.setSetting({ deskPin: next });
  };
  $('#sync-dot').onclick = () => { $('#sync-dot').title = T('sync.refreshing'); window.csapi.refresh(); }; // 同步点兼任刷新入口,顶栏腾出空间
  window.csapi.onRefreshDenied?.(({ wait }) => { // 冷却期内连点/引导未结束:主进程拒绝,黄点脉冲提示,不发请求
    const dot = $('#sync-dot');
    dot.classList.add('deny');
    dot.title = wait < 0 ? T('sync.busy') : T('sync.cooldown', { n: wait });
    setTimeout(() => dot.classList.remove('deny'), 1400);
  });
  $$('#tabs .tab').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('#hero').addEventListener('dblclick', () => { if (document.body.classList.contains('mini')) window.csapi.setMini(false); });
  $('#hero').addEventListener('click', (e) => { if (e.target.closest('.score')) copyHero(); });

  // 全局点击:优先处理星标按钮,再处理链接跳转
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#star-sugs, #star-search')) $('#star-sugs')?.classList.add('hidden'); // 点击别处立即收起建议,不依赖失焦时机
    const starTeam = e.target.closest('[data-star-team]');
    if (starTeam) {
      e.stopPropagation();
      const { slug, name, href } = starTeam.dataset;
      const entry = followedTeam({ name, href });
      if (starTeam.classList.contains('on')) window.csapi.starRemoveTeam((entry && entry.id) || slug);
      else window.csapi.starAddTeam({ name, href }).then(r => toast(r?.dup ? T('star.btn.dup') : T('star.btn.add', { n: name })));
      return;
    }
    const starPlayer = e.target.closest('[data-star-player]');
    if (starPlayer) {
      e.stopPropagation();
      const { slug, name, hintTeam, hintHref } = starPlayer.dataset;
      if (starPlayer.classList.contains('on')) window.csapi.starRemovePlayer(slug);
      else window.csapi.starAddPlayer({ name, href: 'https://liquipedia.net/counterstrike/' + slug, hintTeam, hintHref }).then(r => toast(r?.dup ? T('player.star.dup') : T('player.star.add', { n: name })));
      return;
    }
    const delP = e.target.closest('[data-del-player]');
    if (delP) { window.csapi.starRemovePlayer(delP.dataset.delPlayer); return; }
    const delT = e.target.closest('[data-del-team]');
    if (delT) { window.csapi.starRemoveTeam(delT.dataset.delTeam); return; }
    const sug = e.target.closest('.sug');
    if (sug) {
      $('#star-sugs').classList.add('hidden');
      $('#star-search').value = '';
      const d = sug.dataset;
      const req = d.sugSlug
        ? { name: d.sugName, slug: d.sugSlug, href: d.sugHref || '', pandaTeam: d.sugTeam, pandaTeamSlug: d.sugTeamSlug }
        : { name: d.sugName, href: d.sugHref };
      window.csapi.starAddPlayer(req).then(r => toast(r?.dup ? T('player.star.dup') : T('player.star.add', { n: d.sugName })));
      return;
    }
    const pinB = e.target.closest('[data-pin-to]'); // 置顶到主卡(排在行跳转之前,免得顺手打开链接)
    if (pinB) { e.stopPropagation(); heroPin = pinB.dataset.pinTo; swapHero(); return; }
    const unpinB = e.target.closest('[data-unpin]'); // 主卡 📌 chip:取消置顶回自动
    if (unpinB) { e.stopPropagation(); heroPin = null; swapHero(); return; }
    const t = e.target.closest('[data-url]');
    if (t && t.classList.contains('m-row')) { // 命中的是对阵行本身:按"左键点击对阵"设置行事;行内队名/直播间按钮有自己的 data-url,closest 返回的是它们,不走这里
      const act = SETTINGS?.rowClickAction || 'open';
      if (act === 'none') return;
      if (act === 'pin') {
        if (!t.classList.contains('pin-able')) return; // 赛果行不可钉
        const k = t.dataset.key;
        if (k) { heroPin = heroPin === k ? null : k; swapHero(); } // 再点一次=取消置顶
        return;
      }
      window.csapi.openExternal(t.dataset.url);
      return;
    }
    if (t && t.dataset.url) window.csapi.openExternal(t.dataset.url);
  });

  // 搜索建议
  $('#star-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => doSearch(q), 400);
  });
  $('#star-search').addEventListener('blur', () => {
    clearTimeout(searchTimer); // 失焦时取消未触发的防抖,否则迟到的结果会重新弹出建议框
    setTimeout(() => $('#star-sugs')?.classList.add('hidden'), 250);
  });

  // 设置项
  $$('.theme-card').forEach(c => c.onclick = (e) => {
    themeClickAt = { x: e.clientX, y: e.clientY }; // 记录点击点,主题真正应用时从这儿扩散
    window.csapi.setSetting({ theme: c.dataset.themePick });
  });
  $$('.size-card').forEach(c => c.onclick = () => window.csapi.setSize(c.dataset.sizePick));
  const dateSel = $('#date-fmt-sel');
  if (dateSel) dateSel.onchange = (e) => { window.csapi.setSetting({ dateFormat: e.target.value }); renderAll(true); };
  const tzSelH = $('#tz-sel');
  if (tzSelH) tzSelH.onchange = (e) => { window.csapi.setSetting({ timezone: e.target.value }); renderAll(true); };
  const zfSelH = $('#zhfont-sel');
  if (zfSelH) zfSelH.onchange = (e) => { window.csapi.setSetting({ zhFont: e.target.value }); document.documentElement.dataset.zhfont = e.target.value; };
  const uiLangSel = $('#uilang-sel');
  if (uiLangSel) uiLangSel.onchange = (e) => { // 语言绑定：界面语言带动全部语言设置；中文分支(地图名)默认取第一项，仍可单独再调
    const v = e.target.value;
    window.csapi.setSetting(v === 'en'
      ? { uiLang: v, lang: 'en', mapLang: 'en', roleLang: 'en' }
      : { uiLang: v, lang: 'zh', mapLang: 'zh', roleLang: 'zh' });
  };
  const langSel = $('#lang-sel');
  if (langSel) langSel.onchange = (e) => { window.csapi.setSetting({ lang: e.target.value }); renderAll(true); };
  const mapLangSel = $('#map-lang-sel');
  if (mapLangSel) mapLangSel.onchange = (e) => { window.csapi.setSetting({ mapLang: e.target.value }); renderAll(true); };
  const fsSelH = $('#fs-sel');
  if (fsSelH) fsSelH.onchange = (e) => { window.csapi.setSetting({ fontScale: +e.target.value }); document.body.dataset.fs = e.target.value; };
  const roleLangSel = $('#role-lang-sel');
  if (roleLangSel) roleLangSel.onchange = (e) => { window.csapi.setSetting({ roleLang: e.target.value }); renderAll(true); };
  const storyStyleSel = $('#story-style-sel');
  if (storyStyleSel) storyStyleSel.onchange = (e) => { window.csapi.setSetting({ storyStyle: e.target.value }); renderAll(true); };
  const mapStripSel = $('#map-strip-sel');
  if (mapStripSel) mapStripSel.onchange = (e) => { window.csapi.setSetting({ mapStripMode: e.target.value }); renderAll(true); };
  const upcomingTimeSel = $('#upcoming-time-sel');
  if (upcomingTimeSel) upcomingTimeSel.onchange = (e) => { window.csapi.setSetting({ upcomingTime: e.target.value }); renderAll(true); };
  const evnSel = $('#ev-name-sel');
  if (evnSel) evnSel.onchange = (e) => { window.csapi.setSetting({ eventNameMode: e.target.value }); renderAll(true); };
  $('#op-slider').oninput = (e) => {
    const v = +e.target.value;
    $('#op-val').textContent = v + '%';
    document.documentElement.style.setProperty('--op', String(v / 100));
    applyLowop(v / 100);
    window.csapi.setSetting({ opacity: v / 100 });
  };
  const glassBlurSlider = $('#glass-blur');
  if (glassBlurSlider) glassBlurSlider.oninput = (e) => { // 拖动即时预览,松手前每次都持久化(与不透明度滑块同策略)
    const v = +e.target.value;
    $('#blur-val').textContent = v + 'px';
    document.documentElement.style.setProperty('--glass-blur', v + 'px');
    window.csapi.setSetting({ glassBlur: v });
  };
  $('#interval-sel').onchange = (e) => window.csapi.setSetting({ intervalMin: +e.target.value });
  const rcSel = $('#rowclick-sel');
  if (rcSel) rcSel.onchange = (e) => { if (SETTINGS) SETTINGS.rowClickAction = e.target.value; window.csapi.setSetting({ rowClickAction: e.target.value }); };
  // 关于与更新:手动检查在设置页就地显示结果;仓库/角标点击直达 Releases
  const updStateText = (r) => {
    if (!r) return '';
    if (r.state === 'latest') return T('upd.latest');
    if (r.state === 'available') return `${T('upd.avail')} v${r.version}`;
    if (r.state === 'unavailable') return T('upd.unavailable');
    return T('upd.fail');
  };
  const updCheck = $('#btn-upd-check');
  if (updCheck) updCheck.onclick = async () => {
    const st = $('#upd-state');
    if (st) { st.textContent = T('upd.checking'); st.className = 'upd-state'; }
    const r = await window.csapi.checkUpdate();
    if (st) { st.textContent = updStateText(r); st.className = 'upd-state' + (r.state === 'latest' ? ' ok' : r.state === 'available' ? ' avail' : ''); }
  };
  const ghBtn = $('#btn-open-github');
  if (ghBtn) ghBtn.onclick = () => window.csapi.openExternal(META?.update?.url || 'https://github.com/likeravine233/RainyWatch/releases');
  const updBadge = $('#upd-badge');
  if (updBadge) updBadge.onclick = () => window.csapi.openExternal(META?.update?.url || 'https://github.com/likeravine233/RainyWatch/releases');
  // 回顶钮(挂在 document 委托:分区整树重建后按钮是新节点,不用重绑):
  // 分区钮只归位自己分区的 .sec-body,页签钮归位该页的 .list,互不牵连
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.to-top');
    if (!btn) return;
    const sec = btn.closest('.list-section');
    const box = sec ? sec.querySelector('.sec-body') : btn.closest('.tab-body')?.querySelector('.list');
    if (box) box.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#tg-ontop').onchange = (e) => window.csapi.setSetting({ onTop: e.target.checked });
  const hideBar = $('#tg-hidebar');
  if (hideBar) hideBar.onchange = (e) => window.csapi.setSetting({ hideTaskbar: e.target.checked });
  const tgGlass = $('#tg-glass');
  if (tgGlass) tgGlass.onchange = (e) => window.csapi.setSetting({ captureGlass: e.target.checked });
  $('#tg-notify').onchange = (e) => window.csapi.setSetting({ notifyTransfers: e.target.checked });
  $('#tg-autostart').onchange = (e) => window.csapi.setSetting({ autostart: e.target.checked });
  $('#tg-prematch').onchange = (e) => window.csapi.setSetting({ notifyPreMatch: e.target.checked });
  $('#tg-prematch-starred').onchange = (e) => window.csapi.setSetting({ preMatchStarredOnly: e.target.checked });
  $('#tg-results').onchange = (e) => window.csapi.setSetting({ notifyResults: e.target.checked });
  $('#tg-lowpower').onchange = (e) => window.csapi.setSetting({ lowPower: e.target.checked });
  $('#prematch-min').onchange = (e) => window.csapi.setSetting({ preMatchMin: +e.target.value });
  const pandaInput = $('#panda-token');
  if (pandaInput) {
    let pandaTimer = null;
    pandaInput.oninput = () => {
      clearTimeout(pandaTimer);
      pandaTimer = setTimeout(async () => {
        const token = pandaInput.value.trim();
        const r = await window.csapi.setPanda(token);
        if (r && r.ok) { SETTINGS.pandaToken = token; toast(token ? T('toast.panda.on') : T('toast.panda.off')); }
        else if (r && r.err === 'TOKEN_INVALID') toast(T('toast.panda.invalid'));
        else if (r && r.err) toast(T('toast.panda.err', { e: r.err }));
        if (!r || !r.err) pandaNote();
      }, 700);
    };
    pandaNote();
    const pandaEye = $('#panda-eye');
    if (pandaEye) pandaEye.onclick = () => { // 隐私遮蔽:默认密文,点按临时显形
      const show = pandaInput.type === 'password';
      pandaInput.type = show ? 'text' : 'password';
      pandaEye.textContent = show ? T('panda.hide') : T('panda.show');
    };
  }
  // Twitch 凭证(Client ID + Secret):两栏任一变化即合并保存;Secret 同样默认密文
  const twId = $('#twitch-id'), twSec = $('#twitch-secret');
  if (twId && twSec) {
    let twTimer = null;
    const twSave = () => {
      clearTimeout(twTimer);
      twTimer = setTimeout(async () => {
        const r = await window.csapi.setTwitch({ id: twId.value.trim(), secret: twSec.value.trim() });
        if (r && r.ok) { SETTINGS.twitchClientId = twId.value.trim(); SETTINGS.twitchSecret = twSec.value.trim(); toast(T('toast.twitch.saved')); }
      }, 700);
    };
    twId.oninput = twSave;
    twSec.oninput = twSave;
    const twEye = $('#twitch-eye');
    if (twEye) twEye.onclick = () => {
      const show = twSec.type === 'password';
      twSec.type = show ? 'text' : 'password';
      twEye.textContent = show ? T('panda.hide') : T('panda.show');
    };
  }
  $('#btn-unlock').onclick = () => window.csapi.unlock();
  $('#btn-feedback').onclick = () => window.csapi.openExternal(`${FEEDBACK_REPO}/issues/new/choose`); // 反馈与支持:打开模板选择页(3 类模板卡片自选)
  const fbTheme = $('#fb-theme');
  if (fbTheme) fbTheme.onclick = () => window.csapi.openExternal(fbIssueUrl('theme')); // 主题区直达:界面/主题问题表单,自动附主题与环境
  const vrsFb = $('#vrs-fb');
  if (vrsFb) vrsFb.onclick = () => window.csapi.openExternal(fbIssueUrl('vrs')); // 设置 VRS 读数行反馈:数据表单预填 VRS 上下文(页脚 VRS 徽标仅展示,不响应点击)
  // versus 主卡:鼠标悬停哪半边,哪边队色提亮(两侧是两个伪元素,CSS 自身感知不到"哪半边",这里写 data-side 交给样式)。
  // 提亮属于「悬停队色辉光」:开关关掉或性能模式时不写 data-side(清掉残留值),CSS 端另有开关门+性能模式双保险
  {
    const heroEl = $('#hero');
    if (heroEl) {
      const sideGlowOn = () => !SETTINGS?.lowPower && /\bversus-aura\b/.test(document.body.dataset.fx || '');
      heroEl.addEventListener('mousemove', (e) => {
        if (!sideGlowOn()) { if (heroEl.dataset.side) delete heroEl.dataset.side; return; }
        const r = heroEl.getBoundingClientRect();
        heroEl.dataset.side = e.clientX - r.left < r.width / 2 ? 'a' : 'b';
      });
      heroEl.addEventListener('mouseleave', () => { delete heroEl.dataset.side; });
    }
  }
  $('#btn-quit').onclick = () => window.csapi.quit();
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#settings').classList.add('hidden'); $('#star-sugs')?.classList.add('hidden'); hideUpdDialog(); closeCtx(); } });
  // 右键菜单:主卡与对阵行(关注双方 / 置顶 / 复制 / GitHub 反馈)
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('#ctx-menu')) return;
    const row = e.target.closest('#up-list .m-row[data-key]');
    const inHero = e.target.closest('#hero');
    if (!row && !inHero) return;
    e.preventDefault();
    const m = row ? MATCH_BY_KEY[row.dataset.key] : HERO_M;
    openCtx(matchCtxItems(m), e.clientX + 2, e.clientY + 2);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('#ctx-menu')) closeCtx(); }, true); // 捕获阶段关闭:行点击等代理 stopPropagation 会吃掉气泡,菜单内点击除外(由菜单项自身处理)
  window.addEventListener('blur', closeCtx);
  document.addEventListener('scroll', closeCtx, { capture: true, passive: true });
  document.addEventListener('wheel', closeCtx, { passive: true });
}

function switchTab(name) {
  tab = name;
  $$('#tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-body').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + name));
  if (name === 'transfers') {
    window.csapi.transfersSeen();
    $('#tr-badge').classList.add('hidden');
  }
}
let tab = 'matches';

// ---------- 主播开播入口(页脚) ----------
// 斗鱼/虎牙由主进程检测房间页;Twitch 走官方 Helix(需用户在设置里自配凭证)——
// twitchOn=false(未配置)时 Twitch 条目不渲染:没有绿点、没有开播提示,页脚只留中文解说
function renderStreamers(v) {
  const box = $('#live-entries');
  if (!box || !v || !Array.isArray(v.list)) return;
  STREAMER_LIST = v.list;
  STREAMER_TWON = v.twitchOn === true;
  const lang = isEnUI() ? 'en' : 'zh'; // 按界面语言只显示对应阵营的解说(zh=玩机器等,en=ESL/BLAST 等)
  box.innerHTML = v.list.filter((s) => (s.lang || 'zh') === lang)
    .filter((s) => s.platform !== 'twitch' || STREAMER_TWON)
    .map((s) => `<button class="link${s.live ? ' wj live-on' : ''}" data-url="${esc(s.url)}" title="${s.live ? T('streamer.live') : T('streamer.off')}">● ${esc(s.name)}</button>`).join('');
  footFit();
}

// ---------- 页脚收纳 ----------
// VRS 日期不许被省略号吃字(flex 里它原先最先被挤瘪):窗口挤不下时先撤未开播主播标记——在线主播/VRS/HLTV/LP 保留;
// 空间回弹(拖大窗口/主播下播列表变短)时逐个还原。隐藏只动 scrollWidth 不动 footer 自身尺寸,ResizeObserver 不会自激
function footFit() {
  const footer = $('#footer');
  if (!footer || !footer.isConnected) return;
  const off = $$('#live-entries .link:not(.live-on)');
  off.forEach((b) => { b.hidden = false; });
  let i = off.length;
  while (i > 0 && footer.scrollWidth > footer.clientWidth + 1) { i -= 1; off[i].hidden = true; }
}

// ---------- 主流程 ----------
window.csapi.onData((p) => {
  DATA = p.data;
  APP_VER = p.version || APP_VER;
  const bv = $('#brand-ver'); if (bv) bv.textContent = APP_VER ? 'v' + APP_VER : ''; // 题头版本角标
  META = p.meta;
  applyUpdateBadge();
  ACRYLIC = !!p.acrylicSupported;
  if (p.maps) MAPPOOL = p.maps;
  GLASS_CAP = !!p.glassCaptureActive;
  syncGlassMode();
  renderAll(true);
});
window.csapi.onSettings((s) => { applySettings(s); });
window.csapi.onMini((m) => { document.body.classList.toggle('mini', !!m); renderAll(true); });
window.csapi.onLocked((l) => { document.body.classList.toggle('locked', !!l); });
window.csapi.onStreamers?.((v) => { renderStreamers(v); if (isEnUI() && HERO_M) renderHero(); }); // en:主卡按钮取第一个在播频道,状态到了重绘 hero
window.csapi.onUpdDialog?.((v) => showUpdDialog(v));
$('#upd-go').onclick = () => { if (updUrl) window.csapi.openExternal(updUrl); hideUpdDialog(); };
$('#upd-later').onclick = hideUpdDialog;
$('#upd-close').onclick = hideUpdDialog;
// 一键更新:点击后按钮转为进度条,完成后变「重启并安装」;主进程经 push:upd-dl 推送每个进度
const updInst = $('#upd-install');
if (updInst) updInst.onclick = async () => {
  if (updPhase === 'ready') { window.csapi.applyUpdate(); return; } // 二次点击=重启生效
  if (updPhase === 'downloading' || updPhase === 'verifying') return;
  updInst.disabled = true;
  await window.csapi.installUpdate(); // 终态由 onUpdDl 事件渲染,这里只是触发
};
window.csapi.onUpdDl?.((d) => {
  updPhase = d.phase;
  const inst = $('#upd-install'), msg = $('#upd-msg');
  if (!inst || !msg || $('#upd').classList.contains('hidden')) return;
  if (d.phase === 'downloading') {
    inst.disabled = true;
    inst.textContent = T('upd.dlg.dling', { p: d.total ? Math.min(99, Math.round((d.received / d.total) * 100)) : 0 });
  } else if (d.phase === 'verifying') {
    inst.disabled = true;
    inst.textContent = T('upd.dlg.verify');
  } else if (d.phase === 'ready') {
    inst.disabled = false;
    inst.textContent = T('upd.dlg.restart');
  } else if (d.phase === 'error') {
    inst.disabled = false;
    inst.textContent = T('upd.dlg.install');
    msg.textContent = updFailText(d.msg);
  }
});

// ---------- FILM×PLAIN 胶片带背景(队色对撞主题;参数全在 .vhs 的 CSS 变量上) ----------
// 条数按容器宽自动推导(搬常量不搬条数);窗口缩放/迷你切换由 ResizeObserver 跟随重建。
// 无缝三原则:齿孔节距锁死画格周期(tile/8)、画格按 tile 整数摆放、刻字 6 条重复走 -50%。
function vhsBuild(root) {
  if (!root || !root.clientHeight || !root.clientWidth) return; // 隐藏态(非该主题/迷你):空箱不建
  const num = (v) => parseFloat(v) || 0;
  const cs = getComputedStyle(root);
  const bw = num(cs.getPropertyValue('--bw'));
  const tile = num(cs.getPropertyValue('--tile'));
  const dur = num(cs.getPropertyValue('--dur'));
  const gap = num(cs.getPropertyValue('--gap'));
  const rad = Math.abs(num(cs.getPropertyValue('--ang'))) * Math.PI / 180;
  const W = (root.clientWidth * Math.cos(rad) + root.clientHeight * Math.sin(rad)) * 1.15;
  const L = (root.clientWidth * Math.sin(rad) + root.clientHeight * Math.cos(rad)) * 1.15;
  const deck = root.querySelector('.deck');
  deck.style.width = W + 'px';
  deck.style.height = L + 'px';
  const n = Math.max(3, Math.floor((W + gap) / (bw + gap)));
  deck.textContent = '';
  for (let i = 0; i < n; i++) {
    const r = document.createElement('div');
    r.className = 'ribbon ' + (i % 2 ? 'p' : 'f');
    const f = document.createElement('div');
    f.className = 'film';
    // 每条带独立的时长系数(0.85~1.24)与负延迟相位:永不齐步
    f.style.animationDuration = (dur * (0.85 + ((i * 37) % 40) / 100)).toFixed(2) + 's';
    f.style.animationDelay = (-((i * 1.37) % dur)).toFixed(2) + 's';
    if (i % 2 === 0) {
      // 胶片带:圆角画窗按 tile 周期摆放(细缝堆叠:窗高 86% 画格)
      const count = Math.ceil((L + 2 * tile) / tile) + 1;
      for (let k = 0; k < count; k++) {
        const d = document.createElement('div');
        d.className = 'frm';
        d.style.top = (k * tile + tile * 0.07) + 'px';
        f.appendChild(d);
      }
    } else {
      // 图像带:巨型 ///RAINYWATCH/// 书脊式竖排,6 条重复(位移 -50% = 恰好三条 → 无缝)
      const run = document.createElement('div');
      run.className = 'run';
      for (let k = 0; k < 6; k++) {
        const t = document.createElement('b');
        t.textContent = '///RAINYWATCH///';
        run.appendChild(t);
      }
      f.appendChild(run);
    }
    r.appendChild(f);
    deck.appendChild(r);
  }
}

(async () => {
  const p = await window.csapi.getInitial();
  DATA = p.data; META = p.meta; APP_VER = p.version || ''; ACRYLIC = !!p.acrylicSupported;
  const bv = $('#brand-ver'); if (bv) bv.textContent = APP_VER ? 'v' + APP_VER : ''; // 题头版本角标
  applyUpdateBadge();
  if (p.maps) MAPPOOL = p.maps; // 图序缓存随首屏一起到:缓存首屏也要能画图序带,不等第一次 push
  GLASS_CAP = !!p.glassCaptureActive;
  applySettings(p.settings, false);
  bindEvents();
  bindGlassFrame();
  buildLgMap();
  setTimeout(startGlassVideo, 800); // 首帧渲染完再起视频流,不抢启动窗口
  renderAll();
  applySize(false);
  new ResizeObserver(() => foldEval()).observe($('#titlebar')); // 拖窗改宽即重测折叠档位:时机跟手,不依赖像素断点
  new ResizeObserver(footFit).observe($('#footer')); // 拖窗改宽即重排页脚:挤了先撤未开播主播,VRS 日期始终完整
  const vhsEl = $('#vhs'); // 胶片带背景:主题选中即由 CSS 显示,尺寸随窗口/主题切换由 RO 重建
  if (vhsEl) { vhsBuild(vhsEl); new ResizeObserver(() => vhsBuild(vhsEl)).observe(vhsEl); }
  // 拖拽过程中即时重排布局(80ms 节流,避免拖得快时事件堆积;松开鼠标后 'resized' 再确保一次)
  let sizeRaf = 0, sizeLast = 0;
  window.addEventListener('resize', () => {
    const now = Date.now();
    if (now - sizeLast < 80) return;
    sizeLast = now;
    cancelAnimationFrame(sizeRaf);
    sizeRaf = requestAnimationFrame(() => applySize(true));
  });
})();
