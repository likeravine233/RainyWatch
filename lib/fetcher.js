// Liquipedia API 抓取:礼貌限速(≥2s/请求,其 API 使用条款的底线)、ETag 条件请求、超时控制
const API = 'https://liquipedia.net/counterstrike/api.php';
// UA 按条款要求携带项目标识与联系方式(项目仓库即联系渠道);分发后所有用户同此 UA,
// Liquipedia 侧看到的是"同一开源项目的众多低频用户",出了问题他们能顺链找到我们
const UA = 'RainyWatch/0.0.1 (+https://github.com/likeravine233/RainyWatch; contact: GitHub issues)';

// 主进程内优先走 Electron net.fetch:与浏览器同款网络栈,跟随系统代理——
// "浏览器能打开 Liquipedia = 小助手也能连上" 才成立;裸 Node 环境(诊断脚本)回退全局 fetch
let _pf = null, _pfTried = false;
function pf(url, opts = {}) {
  if (!_pfTried) {
    _pfTried = true;
    try { _pf = require('electron').net.fetch; } catch { _pf = null; }
    if (typeof _pf !== 'function') _pf = null;
  }
  return _pf ? _pf(url, opts) : fetch(url, opts);
}

let lastReqAt = 0;
let coolUntil = 0; // 429 后全局冷却窗:期间所有请求排队等待,避免搜索键入/刷新重试风暴加剧限流

// 真串行队列:gap 只是"睡到上次请求+minMs",并发调用(启动 bootstrap 与调度器首拍重叠、手动刷新连点)
// 会算出同一时刻同时发出,违反 parse 1次/30s。用 promise 链把并发压成队,间隔无条件成立
let gapChain = Promise.resolve();

// ---------- 跨实例共享限速:多实例双开时,通过共享状态文件合并 LP 请求槽位与 429 冷却 ----------
let sharedPaths = null;
function sharedPaths_() {
  if (sharedPaths === null) {
    sharedPaths = false;
    try {
      const { app } = require('electron'); // 仅主进程可用;诊断脚本等裸 Node 环境自动跳过
      const fs_ = require('fs'), path_ = require('path');
      const dir = path_.join(app.getPath('appData'), 'CSWatchShared');
      fs_.mkdirSync(dir, { recursive: true });
      sharedPaths = { dir, fs: fs_, state: path_.join(dir, 'lp-state.json'), lock: path_.join(dir, 'lp-state.lock') };
    } catch { sharedPaths = false; }
  }
  return sharedPaths || null;
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
async function sharedSlot(minMs) {
  const paths = sharedPaths_();
  if (!paths) return;
  let fd = null;
  for (let i = 0; i < 30 && fd == null; i++) { // 互斥锁:另一实例排队时等它;持有者崩溃超 10s 视为死锁清掉
    try { fd = paths.fs.openSync(paths.lock, 'wx'); }
    catch {
      try { if (Date.now() - paths.fs.statSync(paths.lock).mtimeMs > 10000) paths.fs.unlinkSync(paths.lock); } catch { }
      await sleepMs(50);
    }
  }
  if (fd == null) return; // 锁竞争失败:退回进程内节流,不影响功能
  try {
    let st = { lastReqAt: 0, coolUntil: 0 };
    try { st = JSON.parse(paths.fs.readFileSync(paths.state, 'utf8')); } catch { }
    const cool = (st.coolUntil || 0) - Date.now();
    const wait = Math.max(cool, (st.lastReqAt || 0) + minMs - Date.now(), 0);
    if (wait > 0) await sleepMs(wait);
    paths.fs.writeFileSync(paths.state, JSON.stringify({ lastReqAt: Date.now(), coolUntil: Math.max(st.coolUntil || 0, coolUntil) }));
  } finally {
    try { paths.fs.closeSync(fd); paths.fs.unlinkSync(paths.lock); } catch { }
  }
}
function sharedCool(until) { // 429 冷却镜像进共享文件:另一实例立刻看到并一起退避
  const paths = sharedPaths_();
  if (!paths) return;
  try {
    let st = { lastReqAt: 0, coolUntil: 0 };
    try { st = JSON.parse(paths.fs.readFileSync(paths.state, 'utf8')); } catch { }
    paths.fs.writeFileSync(paths.state, JSON.stringify({ ...st, coolUntil: Math.max(st.coolUntil || 0, until) }));
  } catch { }
}

async function gap(minMs = 2000) {
  const run = gapChain.then(async () => {
    const cool = coolUntil - Date.now();
    if (cool > 0) await new Promise(r => setTimeout(r, cool));
    const wait = lastReqAt + minMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastReqAt = Date.now();
    await sharedSlot(minMs); // 双开时跨实例排队:多实例合计仍 ≤1 次/minMs
  });
  gapChain = run.catch(() => { /* 队列不断链 */ });
  return run;
}

// 命中 429:按 Retry-After 进入冷却,返回给上层展示的错误文案。
// 连续 429 时指数退避(60s→120→240→480→600 封顶):Liquipedia 政策是"封禁期间继续请求会延长封禁",
// 固定 60s 重试会让 IP 永远等不到解封;任一请求成功即清零回到 60s 档
let coolStreak = 0;
function tripCooldown(res) {
  const ra = Number(res.headers.get('retry-after')) || 0;
  coolStreak++;
  const backoff = Math.min(60e3 * 2 ** Math.min(coolStreak - 1, 4), 600e3);
  const ms = Math.min(Math.max(ra * 1000, backoff), 600e3);
  coolUntil = Math.max(coolUntil, Date.now() + ms);
  sharedCool(coolUntil); // 冷却镜像进共享文件:另一实例(双开时)立即同步退避
  return `Liquipedia 限流(429),冷却 ${Math.round(ms / 1000)} 秒后自动恢复`;
}

/**
 * 抓取一个 wiki 页面的解析 HTML
 * @returns {notModified:true} | {html, etag}
 */
async function fetchWikiPage(page, etag) {
  await gap(30000); // Liquipedia 条款:action=parse 不得超过 1 请求/30s,违规是被 429 拉黑的主因
  const params = new URLSearchParams({
    action: 'parse', page, format: 'json', prop: 'text', disablelimitreport: '1',
  });
  const headers = { 'User-Agent': UA, 'Accept': 'application/json' };
  if (etag) headers['If-None-Match'] = etag;
  const res = await pf(`${API}?${params}`, { headers, signal: AbortSignal.timeout(30000) });
  if (res.status === 304) return { notModified: true };
  if (res.status === 429) throw new Error(tripCooldown(res));
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${page}`);
  coolStreak = 0; // 成功即复位退避档位,下次 429 从 60s 重新爬
  const j = await res.json();
  if (j.error) throw new Error(`API error for ${page}: ${j.error.code}`);
  const html = j?.parse?.text?.['*'];
  if (!html) throw new Error(`Empty parse result for ${page}`);
  return { html, etag: res.headers.get('etag') || '' };
}

async function apiQuery(query) { // 轻量 API 查询(前缀解析/搜索等):走同一条礼貌队列(2s 间隔)
  await gap(2000);
  const params = new URLSearchParams({ ...query, format: 'json' });
  const res = await pf(`${API}?${params}`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
  if (res.status === 429) throw new Error(tripCooldown(res));
  if (!res.ok) throw new Error(`HTTP ${res.status} for api query`);
  const j = await res.json();
  if (j.error) throw new Error(`API query error: ${j.error.code}`);
  return j;
}

module.exports = { fetchWikiPage, apiQuery, searchPlayers, searchPandaPlayers, lpCooldownUntil };
function lpCooldownUntil() { return coolUntil; } // 主进程用它判断"冷却期内直接走 Panda 兜底,不空等"

// PandaScore 选手搜索(免费 token):一次拿到名字+当前队伍,免去 liquipedia 搜索+选手页解析两步,
// 且完全绕开 Liquipedia 的 IP 限流池。返回 {title, slug, team, teamSlug} 列表
async function searchPandaPlayers(q, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const get = async (params) => {
    const res = await pf(`https://api.pandascore.co/csgo/players?${params}`, {
      headers, signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429) throw new Error('PandaScore 每小时配额(1000)用尽,下个整点恢复');
    if (!res.ok) throw new Error(`PandaScore HTTP ${res.status}`);
    return res.json();
  };
  const map = (arr) => (Array.isArray(arr) ? arr : []).filter(p => p && p.name).map(p => ({
    title: p.name,
    slug: p.slug || '',
    team: p.current_team ? (p.current_team.name || p.current_team.acronym || '') : '',
    teamSlug: p.current_team ? String(p.current_team.slug || '') : '',
  }));
  // search[name] 是模糊包含匹配,相关度排序会漏掉精确同名选手(实测搜 arT 返回的全是名字带
  // "art" 的杂号,没有 arT 本人):并查 filter[name] 精确命中(大小写不敏感)置顶
  const [exact, fuzzy] = await Promise.all([
    get(new URLSearchParams({ 'filter[name]': q, per_page: '2' })),
    get(new URLSearchParams({ 'search[name]': q, per_page: '6' })),
  ]);
  const hits = map(exact), rest = map(fuzzy);
  const seen = new Set(hits.map(h => h.slug));
  return hits.concat(rest.filter(r => !seen.has(r.slug)));
}

// 选手搜索联想(MediaWiki opensearch,过滤子页面)
async function searchPlayers(q) {
  await gap(2000); // opensearch 是轻量接口,按通用底线 2s 即可(仅作 PandaScore 不可用时的回退)
  const params = new URLSearchParams({ action: 'opensearch', format: 'json', limit: '6', search: q });
  const res = await pf(`${API}?${params}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (res.status === 429) throw new Error(tripCooldown(res));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  coolStreak = 0;
  const j = await res.json();
  const titles = j?.[1] || [], urls = j?.[3] || [];
  return titles.map((t, i) => ({ title: t, href: urls[i] || '' }))
    .filter(x => !x.title.includes('/') && x.href);
}
