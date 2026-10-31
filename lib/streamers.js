// 主播直播间开播检测:斗鱼/虎牙房间页内嵌状态 + Twitch 官方 Helix 批量接口
// 从 main.js 拆出:对外行为不变,主进程依赖(store/win/pushData/isShot)经 createStreamers 注入
const { netFetch } = require('./fetcher');

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

function parseStreamerLive(platform, html) {
  if (platform === 'douyu') {
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

async function fetchStreamerLive(entry) {
  const url = entry.platform === 'douyu' ? `https://www.douyu.com/${entry.room}`
    : `https://www.huya.com/${entry.room}`; // Twitch 不在此列:走 Helix 批量接口,不做页面抓取
  const res = await netFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Referer': `https://www.${entry.platform}.com/`,
    },
  });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; } // 错误页不解析,保住上次状态
  const html = await res.text();
  return parseStreamerLive(entry.platform, html);
}

function createStreamers({ getStore, getWin, pushData, isShot }) {
  const streamerStatus = { updatedAt: 0, twitchOn: isShot, list: STREAMERS.map((s) => ({ ...s, live: false, err: '' })) }; // twitchOn=截图模式默认真,保住 en 演示的开播绿点;正常运行由凭证决定
  let streamerPolling = false;
  let lastWjLive = null; // 上一轮玩机器开播结论(null=未知):翻转时立即 pushData,主卡按钮不等下一轮比赛同步

  // ---------- Twitch 官方 Helix 开播检测(英文主播) ----------
  // 每用户在 dev.twitch.tv 自建应用拿 Client ID/Secret(免费,client_credentials 无需回调);
  // app token 约 60 天有效,401 自愈重取。Helix 限速=每 client ID 800 点/分,streams 端点 1 点/次
  // 且一次可批量 ≤100 个 user_login——全部英文频道一轮一个请求,远低于配额。
  // 未配置凭证时完全不发起任何 Twitch 请求
  let twitchTok = null; // { token, exp }
  function twitchCreds() {
    const store = getStore();
    const id = String(store.get('twitchClientId') || '').trim();
    const secret = String(store.get('twitchSecret') || '').trim();
    return { id, secret, ok: !!(id && secret) };
  }
  async function twitchAppToken(id, secret) {
    if (twitchTok && twitchTok.exp > Date.now() + 60e3) return twitchTok.token;
    const res = await netFetch('https://id.twitch.tv/oauth2/token', {
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
    const res = await netFetch('https://api.twitch.tv/helix/streams?' + entries.map((s) => 'user_login=' + encodeURIComponent(s.room)).join('&'), {
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
      const store = getStore();
      const uiLang = (store && store.get('uiLang')) || 'zh'; // 只轮询当前界面语言的解说:渲染层本来就按语言过滤展示,另一语言的白采即纯浪费(en 界面不抓斗鱼/虎牙,zh 界面不打 Twitch);切换语言后下一轮(≤2min)自动跟上
      const twitchOn = twitchCreds().ok;
      streamerStatus.twitchOn = twitchOn;
      if (twitchOn) {
        try {
          await refreshTwitchBatch(list.filter((s) => s.platform === 'twitch' && s.lang === uiLang && Date.now() >= (s.coolUntil || 0)));
          for (const s of list) if (s.platform === 'twitch') s.err = '';
        } catch (e) {
          const errText = String(e.message || e);
          const cool = e.status === 403 || e.status === 429 || e.status === 401;
          for (const s of list) if (s.platform === 'twitch') { s.err = errText; if (cool) s.coolUntil = Date.now() + 15 * 60e3; }
        }
      } else {
        for (const s of list) if (s.platform === 'twitch') { s.live = false; s.err = ''; } // 未配置:恒不在线,渲染层同步隐藏
      }
      for (const entry of list.filter((s) => s.platform !== 'twitch' && s.lang === uiLang)) {
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
      const wj = wanjiqiState(); // 开播翻转(含未知→已知)立即推数据:主卡按钮即时跟上,旧 pollWanjiqi 的即时推送语义保留在此
      const wjLive = wj ? wj.live : null;
      if (wjLive !== lastWjLive) { lastWjLive = wjLive; pushData(); }
      const win = getWin();
      if (win && !win.isDestroyed()) win.webContents.send('push:streamers', streamerStatus);
    } finally {
      streamerPolling = false;
    }
  }

  // 玩机器开播状态三态派生:null=未知(首轮未完成/探测失败从未确认开播)→渲染层按钮保留;{live} 才是确定结论
  function wanjiqiState() {
    const e = streamerStatus.list.find((s) => s.key === 'wanjiqi');
    if (!e || !streamerStatus.updatedAt) return null;
    if (e.err && !e.live) return null; // 探测失败保留按钮,免得误隐(与旧 pollWanjiqi 失败语义一致)
    return { live: !!e.live };
  }

  return {
    streamerStatus, refreshStreamers, wanjiqiState,
    isPolling: () => streamerPolling,
    resetTwitchToken: () => { twitchTok = null; },
  };
}

module.exports = { createStreamers, parseStreamerLive, STREAMERS };
