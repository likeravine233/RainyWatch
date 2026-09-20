// 赛事文本翻译层(纯函数,浏览器/单测共用):
// Liquipedia 的结构性英文串(Group B / Playoffs / Swiss Stage…)翻译为中文;
// 队伍名、赛事专名(FISSURE Playground、IEM…)不碰,原样保留。
// lang: 'zh' = 结构词翻译(默认);'en' = 原文。
(function (global) {
  // 整句/前缀正则(优先级高于子串替换)
  const RULES = [
    [/^Group\s+([A-Z0-9]+)\s*[:：]\s*(.+)$/i, '小组赛$1组 · $2'],
    [/^Group\s+([A-Z0-9]+)$/i, '小组赛$1组'],
    [/\bRound of (\d+)/i, '$1强赛'],
    [/\bRound (\d+)/i, '第$1轮'],
  ];
  // 子串替换词表(长词在前,避免 Final 吃掉 Grand Final)
  const WORDS = [
    ['Last Chance Qualifier', '最终资格赛'],
    ['Closed Qualifier', '封闭预选赛'],
    ['Open Qualifier', '公开预选赛'],
    ['Regional Finals', '区域决赛'],
    ['Group Stage', '小组赛'],
    ['Grand Final', '总决赛'],
    ['Lower Bracket', '败者组'],
    ['Upper Bracket', '胜者组'],
    ['Quarterfinals', '四分之一决赛'],
    ['Quarterfinal', '四分之一决赛'],
    ['Semifinals', '半决赛'],
    ['Semifinal', '半决赛'],
    ['Playoffs', '淘汰赛'],
    ['Regular Season', '常规赛'],
    ['Swiss Stage', '瑞士轮'],
    ['Swiss Round', '瑞士轮'],
    ['Play-In', '入围赛'],
    ['Show Match', '表演赛'],
    ['Showmatch', '表演赛'],
    ['Tiebreaker', '加赛'],
    ['3rd Place Match', '季军赛'],
    ['3rd Place', '季军赛'],
    ['Finals', '总决赛'],
    ['Final', '决赛'],
  ].map(([w, zh]) => [new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), zh]);

  function tr(text, lang) {
    const s = String(text ?? '');
    if (lang === 'en' || !s) return s;
    let out = s;
    for (const [re, rep] of RULES) out = out.replace(re, rep);
    for (const [re, zh] of WORDS) out = out.replace(re, zh);
    return out;
  }

  // 赛事日期段:"Aug 31 – Dec 12" → "8月31日 – 12月12日";"Sep 06 – 14" → "9月6日 – 14日"
  const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  function trDates(text, lang) {
    const s = String(text ?? '');
    if (lang === 'en' || !s) return s;
    const m = s.match(/^([A-Z][a-z]{2})[a-z]*\.?\s*(\d{1,2})(?:\s*[–-]\s*(?:([A-Z][a-z]{2})[a-z]*\.?\s*)?(\d{1,2}))?(\s*\??)$/);
    if (!m) return s;
    const mo1 = MON[m[1]];
    if (!mo1) return s;
    if (m[4]) {
      const mo2 = m[3] ? MON[m[3]] : mo1;
      if (!mo2) return s;
      return `${mo1}月${+m[2]}日 – ${mo2 === mo1 ? '' : mo2 + '月'}${+m[4]}日`;
    }
    return `${mo1}月${+m[2]}日`;
  }

  // 赛事评级:Liquipedia badge 的 S/A/B/C → "S级"/"S-Tier"
  function tierLabel(tier, lang) {
    const t = String(tier || '').trim();
    if (!t) return '';
    return lang === 'en' ? `${t}-Tier` : `${t}级`;
  }

  // 变阵角色/状态:Liquipedia 转会表斜体标注(Coach / benched / retired / Stand-in…)
  // 先整词精确匹配(长短语),未命中再做词级替换;未收录词保持原文
  const ROLE_FULL = {
    'assistant coach': '助理教练', 'head coach': '主教练', 'interim coach': '临时教练',
    'strategic coach': '战略教练', 'positional coach': '位置教练', 'general manager': '总经理',
    'team manager': '领队', 'stand-in': '临时替补', 'content creator': '内容创作者',
  };
  const ROLE_WORDS = [
    [/assistant/gi, '助理'], [/coach/gi, '教练'], [/general/gi, '总'],
    [/manager/gi, '经理'], [/analyst/gi, '分析师'], [/stand[\s-]?in/gi, '临时替补'],
    [/substitute/gi, '替补'], [/\bsub\b/gi, '替补'], [/back\s+from\s+bench/gi, '回归首发'],
    [/benched/gi, '替补席'],
    [/retired/gi, '退役'], [/inactive/gi, '非活跃'], [/loaned/gi, '租借'], [/loan/gi, '租借'],
    [/trialist/gi, '试训'], [/trial/gi, '试训'], [/owner/gi, '老板'], [/streamer/gi, '主播'], [/backup/gi, '候补'],
  ];
  // 国旗/地区名英→中(转会行选手名旁;界面英文或未收录时保持原文)。标注词以 Liquipedia flag 的 title 为准
  const COUNTRY_ZH = {
    denmark: '丹麦', russia: '俄罗斯', 'united states': '美国', usa: '美国', brazil: '巴西', china: '中国',
    ukraine: '乌克兰', sweden: '瑞典', poland: '波兰', australia: '澳大利亚', france: '法国', germany: '德国',
    turkey: '土耳其', lithuania: '立陶宛', portugal: '葡萄牙', romania: '罗马尼亚', finland: '芬兰',
    belarus: '白俄罗斯', belgium: '比利时', serbia: '塞尔维亚', kazakhstan: '哈萨克斯坦', latvia: '拉脱维亚',
    mongolia: '蒙古', bulgaria: '保加利亚', canada: '加拿大', estonia: '爱沙尼亚', 'united kingdom': '英国',
    uk: '英国', argentina: '阿根廷', czechia: '捷克', 'czech republic': '捷克', hungary: '匈牙利',
    netherlands: '荷兰', slovakia: '斯洛伐克', croatia: '克罗地亚', norway: '挪威', pakistan: '巴基斯坦',
    iceland: '冰岛', austria: '奥地利', macau: '中国澳门', 'bosnia and herzegovina': '波黑', 'hong kong': '中国香港',
    spain: '西班牙', italy: '意大利', greece: '希腊', switzerland: '瑞士', ireland: '爱尔兰', england: '英格兰',
    scotland: '苏格兰', wales: '威尔士', israel: '以色列', 'south korea': '韩国', korea: '韩国', japan: '日本',
    india: '印度', indonesia: '印度尼西亚', malaysia: '马来西亚', singapore: '新加坡', thailand: '泰国',
    vietnam: '越南', philippines: '菲律宾', 'new zealand': '新西兰', 'south africa': '南非', egypt: '埃及',
    tunisia: '突尼斯', algeria: '阿尔及利亚', morocco: '摩洛哥', 'saudi arabia': '沙特阿拉伯',
    'united arab emirates': '阿联酋', uae: '阿联酋', qatar: '卡塔尔', kuwait: '科威特', kosovo: '科索沃',
    albania: '阿尔巴尼亚', montenegro: '黑山', macedonia: '北马其顿', 'north macedonia': '北马其顿',
    moldova: '摩尔多瓦', slovenia: '斯洛文尼亚', georgia: '格鲁吉亚', armenia: '亚美尼亚', azerbaijan: '阿塞拜疆',
    mexico: '墨西哥', chile: '智利', uruguay: '乌拉圭', colombia: '哥伦比亚', paraguay: '巴拉圭', peru: '秘鲁',
    venezuela: '委内瑞拉', iran: '伊朗', iraq: '伊拉克', jordan: '约旦', lebanon: '黎巴嫩', uzbekistan: '乌兹别克斯坦',
    kyrgyzstan: '吉尔吉斯斯坦', taiwan: '中国台湾', 'chinese taipei': '中华台北',
  };
  function country(name, lang) {
    const s = String(name || '').trim();
    if (!s || lang === 'en') return s;
    return COUNTRY_ZH[s.toLowerCase()] || s;
  }
  function roleLabel(note, lang) {
    const s = String(note ?? '').trim();
    if (!s || lang === 'en') return s;
    const full = ROLE_FULL[s.toLowerCase().replace(/[\s_-]+/g, ' ')];
    if (full) return full;
    let out = s;
    for (const [re, zh] of ROLE_WORDS) out = out.replace(re, zh);
    return out;
  }
  // 变阵条目的备注小标签:与纯词翻译的 roleLabel 不同,这里带队伍上下文——
  // 同队挂编型 Inactive 是 LP"非活跃"的主体形态,按 CS 圈通用语义(bench)直标"下放";租借类直标"租借"
  function transferNote(t, lang) {
    const s = String(t.note ?? '').trim();
    if (!s) return '';
    if (lang !== 'en') {
      const low = s.toLowerCase();
      if (/loan/.test(low)) return '租借';
      if (/inactive/.test(low) && String(t.oldTeam || '') && t.oldTeam === t.newTeam) return '下放';
    }
    return roleLabel(s, lang);
  }

  // 队伍名缩写(迷你模式等窄条场景):Natus Vincere → NaVi / Team Vitality → Vitality
  // 规则:先去掉 Team/Clan/Esports/Gaming 等填充词;≤8 字符原样;多词取每词前两字母拼接,单词截 7 字符
  const FILLER = /\b(Team|Clan|Esports|E-sports|eSports|Gaming|Club|The)\b/gi;
  function abbr(name) {
    let s = String(name ?? '').trim();
    const stripped = s.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
    s = stripped || s;
    if (s.length <= 8) return s;
    const w = s.split(' ').filter(Boolean);
    if (w.length >= 2) return w.slice(0, 3).map(x => x.slice(0, 2)).join('');
    return s.slice(0, 7).replace(/\W+$/, '');
  }

  // 赛事名简称:去掉 "2024/2025" 年份、Stage 阶段、Location 城市等冗余后缀
  // 例:IEM Cologne 2024 → IEM Cologne;BLAST Premier Spring Finals 2025 → BLAST Spring Finals
  function abbrEvent(name) {
    let s = String(name ?? '').trim();
    if (!s) return s;
    // 末尾年份(2020~2030)去掉
    s = s.replace(/[\s·:–-]+(20[2-3][0-9])\s*$/g, '').trim();
    // 多地点后缀(Cologne / Shanghai 等重复赛事):保留主体
    // 通用做法:把 "Stage 1 / Group A / Qualifier / Closed Qualifier" 等子级去掉
    s = s.replace(/\s+(Stage|Group\s+[A-Z0-9]+|Play-?in|Swiss|Closed Qualifier|Open Qualifier|Regional Finals?)\s*$/i, '').trim();
    return s;
  }

  // 常见赛事的官方中文别名(中文圈惯称;非 Liquipedia 翻译——LP 无中文版)
  // 用于 lang='zh' 时把英文赛事名映射为中文惯称(在 settings 启用"赛事显示中文别名"时生效)
  // 赛事中文别名表 — 只收录能在国内主流平台(完美世界电竞/5E资讯/ITHome/PingWest/东球帝/知乎/Reddit 中文区)查到的官方或玩家圈惯用译名。
  // 玩家圈没有中文惯称的赛事(BetBoom Dacha、YaLLa Compass、ESL Challenger、DreamHack、ESEA)不在此列出 — 直接保留原名。
  const EVENT_ZH = {
    'IEM Katowice': 'IEM 卡托维兹',
    'IEM Cologne': 'IEM 科隆',
    'IEM Rio': 'IEM 里约',
    'IEM Melbourne': 'IEM 墨尔本',
    'IEM Chicago': 'IEM 芝加哥',
    'IEM Beijing': 'IEM 北京',
    'IEM Chengdu': 'IEM 成都',
    'IEM Kraków': 'IEM 克拉科夫',     // ESL 2026 新站,Katowice 2026 之后接力
    'ESL Pro League': 'ESL 职业联赛',  // 萌娘百科/知乎通用译名,简称 EPL
    'Perfect World Shanghai Major': '完美世界上海 Major', // 完美电竞官网:shmajor2024.pwesports.cn
    'CS Asia Championships': 'CS 亚洲邀请赛',  // 完美电竞官网:cac.pwesports.cn / "CAC" 是该赛事官方简称,保留
    'FISSURE Playground': '裂变天地', // 国内多家媒体(ITHome/PingWest/东球帝/5E)通用中文名
  };
  // 此外给几个缩写兜底,玩家圈不一定有官方译名但能看到通用写法
  const EVENT_ZH_ABBR = {
    'CAC': 'CS 亚洲邀请赛',             // CS Asia Championships 缩写
    'EPL': 'ESL 职业联赛',             // ESL Pro League 缩写
    'IEM': 'IEM',                       // IEM 本身玩家圈直接念英文,不加中文
    'EWC': '电竞世界杯',                // Esports World Cup — 电竞世界杯官网中文
  };
  // 给一英文赛事名取最长前缀匹配的中文名
  function zhEvent(name) {
    const s = String(name ?? '').trim();
    if (!s) return s;
    // 先查精确/包含匹配
    const keys = Object.keys(EVENT_ZH).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const i = s.toLowerCase().indexOf(k.toLowerCase());
      if (i === -1) continue;
      // 命中词之外的部分(赛季 #3、年份、站名等)必须保留:裂变天地第三季 → "裂变天地 #3",不能吞成只剩"裂变天地"
      const rest = (s.slice(0, i) + ' ' + s.slice(i + k.length)).replace(/\s+/g, ' ').trim();
      return rest ? EVENT_ZH[k] + ' ' + rest : EVENT_ZH[k];
    }
    // 再查缩写兜底:仅当整词匹配或带分隔符前缀时(如 "CAC 2026" 命中 CAC)
    for (const [k, v] of Object.entries(EVENT_ZH_ABBR)) {
      const re = new RegExp('(^|[\\s\\-_/])' + k + '($|[\\s\\-_/])', 'i');
      if (re.test(s)) return v;
    }
    return s;
  }

  // ---------- 界面语言翻译(UI)----------
  // 与上面的赛事文本翻译(tr)不同:这里翻译界面静态文案(设置面板/标题栏/托盘菜单/系统通知/右键菜单)。
  // lang='zh' 中文界面;lang='en' 英文界面(赛事数据词走 tr,lang=en 时保留原文)。
  // uit(key, lang):key 缺失回退中文,再回退 key 本身;{n} 类占位由调用方替换。
  const UI = {
    zh: {
      'brand.name': '小暴雨助手',
      'sync.dot': '同步正常 · 点击刷新(30 秒冷却,防限流)',
      'sync.refreshing': '正在手动刷新…', 'sync.cooldown': '刷新太频繁,{n} 秒后再试', 'sync.busy': '正在同步中,请稍候',
      'btn.mini': '切换迷你模式', 'btn.pin': '窗口置顶(快捷切换)', 'btn.settings': '设置',
      'tab.matches': '比赛', 'tab.events': '赛事', 'tab.transfers': '变阵',
      'set.title': '设置',
      'set.title.tip': '数据来源:Liquipedia 开放接口(与 HLTV 数据同源同步)· 点击比赛/赛事/变阵可跳转详情 · 点击主卡比分可复制',
      'set.lb.stars': '高光选手 / 关注队伍',
      'set.lb.stars.tip': '提示:比赛列表和变阵列表中,把鼠标放到名字上会显示 ★ 可直接关注',
      'star.search.ph': '搜索选手添加高光,如 ZywOo / s1mple',
      'set.lb.notify': '提醒',
      'tg.prematch': '开赛前提醒',
      'opt.pre.5': '提前 5 分钟', 'opt.pre.10': '提前 10 分钟', 'opt.pre.15': '提前 15 分钟', 'opt.pre.30': '提前 30 分钟',
      'tg.prematch.starred': '仅关注的比赛',
      'tg.results': '赛果速报(看过的直播比赛结束推送)',
      'set.lb.live2': '直播比分增强(可选)',
      'set.lb.live2.tip': '配置 token 后,直播中的比赛每 45 秒同步大比分与图数;回合级实时比分(12:9)需 PandaScore 付费档,免费档自动回退为大比分展示。获取方式:打开 pandascore.co 注册账号(有免费档),登录后在控制台生成 API Token,复制粘贴到这里;Token 仅保存在本机',
      'panda.token.ph': 'PandaScore Token — pandascore.co 免费申请', 'panda.token.tip': '获取方式：打开 pandascore.co 注册账号（有免费档），登录后在控制台生成 API Token，复制粘贴到这里；Token 仅保存在本机',
      'set.lb.twitch': 'Twitch 开播检测(英文解说)',
      'set.lb.twitch.tip': '英文主播(ESL/BLAST 等)的开播绿点走 Twitch 官方接口,需要你自己的免费凭证:打开 dev.twitch.tv/console(普通 Twitch 账号即可,需先完成邮箱验证并开启两步验证 2FA)→ Register Your Application(名字随意,类别选 Application,OAuth 回调地址填 http://localhost)→ 创建后复制 Client ID,再点 New Secret 生成密钥,分别粘贴到下面两栏。凭证仅保存在本机;未配置时不检测英文主播开播,也绝不访问 Twitch 页面',
      'twitch.id.ph': 'Twitch Client ID — dev.twitch.tv/console 免费 创建', 'twitch.secret.ph': 'Twitch Client Secret — 应用页 New Secret 生成',
      'panda.show': '显示', 'panda.hide': '隐藏', 'panda.foot.tip': 'Source: PandaScore — 可选比分数据来源',
      'set.lb.perf': '性能',
      'tg.lowpower': '性能优先(关氛围动效,失焦暂停动画,取景玻璃降至15fps)',
      'tg.lowpower.lite': '性能优先(关氛围动效,失焦暂停动画)',
      'tg.flex': '灵活模式(在窗口上时跑到上限,移开回落保底帧率)',
      'set.lb.vfps': '视觉帧率上限',
      'set.lb.vfps.tip': '整个窗口全部视觉动效的最高更新频率——包括 WebGL 波形、CSS 循环动画、hover 辉光与过渡;任何模式下都不会超过此值;「不限制」=按显示器刷新率跑。推荐搭配「灵活模式」:在窗口上时交互跑满上限,移开回落保底帧率省占用',
      'set.lb.idlefps': '保底帧率(灵活模式)',
      'set.lb.idlefps.tip': '灵活模式开启时,光标离开窗口后动效的播放帧率;不会高于「视觉帧率上限」,最低 15 FPS',
      'set.vfps.unlimited': '不限制',
      'set.lb.size': '尺寸预设',
      'set.lb.size.tip': '也可以直接拖拽窗口边缘自由调整大小,布局会随尺寸自动增减信息层级',
      'set.lb.window': '窗口行为',
      'size.mini': '迷你条', 'size.mini.tip': '一条比分胶囊:当前比分/下一场倒计时',
      'size.s': '小卡', 'size.s.tip': '小卡:主卡 + 接下来几场',
      'size.m': '标准', 'size.m.tip': '标准:完整页签',
      'size.l': '大窗', 'size.l.tip': '大窗:更多行、更大字号',
      'set.lb.evname': '赛事名显示',
      'set.lb.evname.tip': '赛事名显示：简称（默认）/ 全称（英文原名）/ 中文惯称（基于内置 IEM/BLAST/ESL 等别名表；Liquipedia 无官方中文，未收录的回退原文）',
      'opt.evname.abbr': '简称(IEM Cologne 2026 → IEM Cologne)',
      'opt.evname.full': '全称(原名)',
      'opt.evname.zh': '中文惯称(IEM Cologne → IEM 科隆)',
      'set.lb.date': '日期显示',
      'opt.date.smart': '智能(今天 / 明天 / 周六)',
      'opt.date.weekday': '周几优先(周六 14:00)',
      'opt.date.date': '具体日期(09-12 14:00)',
      'set.lb.uptime': '开赛时间显示',
      'set.lb.uptime.tip': '列表里即将开始场次的时间:A=只看开赛时刻;B=临近 1 小时内换成倒计时;A·B=临近时显示「倒计时 · 时刻」,两个都看得到',
      'opt.uptime.start': 'A · 只看时刻(今天 14:00)',
      'opt.uptime.cd': 'B · 临近换倒计时(00:34:14 后)',
      'opt.uptime.both': 'A·B · 临近时都显示(00:34:14 后 · 14:00)',
      'set.lb.uilang': '界面语言', 'set.lb.uilang.tip': '切换界面语言，同时带动赛事文本、地图名、选手角色等全部语言设置；切换后仍可在下方单独调整',
      'set.lb.fontsize': '字号', 'set.lb.fontsize.tip': '五档缩放全应用文字(主卡/列表/设置/页签/标题栏);迷你条窗口固定不缩放;默认档与原观感完全一致',
      'opt.fs.1': '特小', 'opt.fs.2': '偏小', 'opt.fs.3': '标准(默认)', 'opt.fs.4': '偏大', 'opt.fs.5': '特大',
      'set.lb.timezone': '比赛时间时区', 'set.lb.timezone.tip': '所有比赛时刻(开赛时间、日期)按所选时区显示;默认跟随本机时区,夏令时自动处理;想按赛事当地或其他时区对照时手动切换',
      'opt.tz.auto': '自动(本机时区)', 'opt.tz.utc': 'UTC', 'opt.tz.shanghai': '北京', 'opt.tz.tokyo': '东京', 'opt.tz.seoul': '首尔', 'opt.tz.singapore': '新加坡', 'opt.tz.sydney': '悉尼', 'opt.tz.moscow': '莫斯科', 'opt.tz.berlin': '柏林', 'opt.tz.london': '伦敦', 'opt.tz.newyork': '纽约', 'opt.tz.la': '洛杉矶',
      'set.lb.zhfont': '中文字体', 'set.lb.zhfont.tip': '只影响汉字;数字与英文仍用各主题的西文字体;切换即时生效并保存,对比后定稿一款即可',
      'opt.zh.misans': 'MiSans', 'opt.zh.noto': '思源黑体 Noto Sans SC(默认)', 'opt.zh.yahei': '微软雅黑(系统)',
      'set.tab.general': '通用', 'set.tab.display': '显示', 'set.tab.theme': '主题', 'set.tab.follow': '关注', 'set.tab.data': '数据', 'set.tab.about': '关于', 'about.tag': '小暴雨助手',
      'set.lb.lang': '赛事文本语言',
      'set.lb.lang.tip': '比赛相关文本的语言：状态词、阶段（第N图/加时/赛点）、赛事名结构词等；随界面语言联动，也可在此单独调整',
      'set.lb.maplang': '地图名显示',
      'set.lb.maplang.tip': '全称取完美世界国服官方译名,简称是玩家圈惯用叫法;图名随数据源下发后生效(当前免费档无图名,显示"第N图")',
      'opt.map.zh': '中文全称(荒漠迷城 / 炼狱小镇)',
      'opt.map.zhShort': '中文简称(米垃圾 / 小镇 / 沙二)',
      'opt.map.en': '英文原名(Mirage / Inferno)',
      'set.lb.mapstrip': '地图信息显示',
      'set.lb.mapstrip.tip': '主卡在打图的地图信息:图序带会同时展示前图/当前图/下张的 BP 顺序;只显示当前图则仅保留一行「第N图 · 图名」',
      'opt.strip.band': '图序带(前图 · 当前 · 下张)',
      'opt.strip.cur': '只显示当前图(第N图 · 图名)',
      'set.lb.bo1score': 'BO1 比分显示',
      'set.lb.bo1score.tip': 'LP 对 BO1 赛果印地图小分(7-13,更详细),PandaScore 补位行只有系列比分(1-0):小分优先=有小分就显示小分;统一大比分=BO1 全表按系列比分显示',
      'opt.bo1.raw': '小分优先(更详细;补位行回落大比分)',
      'opt.bo1.series': '统一大比分(全表一致)',
      'set.lb.mintier': '赛事级别过滤',
      'set.lb.mintier.tip': '只显示所选级别及以上的比赛,改动即时生效;无级别信息的赛事在非「所有赛事」档下隐藏。仅影响显示,不会清理任何数据;主卡置顶的比赛不受过滤影响',
      'opt.tier.all': '所有赛事',
      'opt.tier.c': 'C 级及以上',
      'opt.tier.b': 'B 级及以上',
      'opt.tier.a': 'A 级及以上',
      'opt.tier.s': '仅 S 级',
      'set.lb.rolelang': '选手角色显示',
      'set.lb.rolelang.tip': '变阵列表选手名旁的角色/状态标注(Coach、benched、Stand-in 等)来自 Liquipedia;常见词翻译,未收录的保持原文',
      'set.lb.storystyle': '变阵解说风格',
      'set.lb.storystyle.tip': '变阵条目悬停时浮现的一句话解说:专业=转会/替补席等标准措辞;诙谐=社区梗([一半生活电视]xx板凳xx、感谢服役)',
      'opt.story.pro': '专业(转会 / 替补席)',
      'opt.story.fun': '诙谐(板凳梗 / 感谢服役)',
      'opt.role.zh': '中文(教练 / 退役 / 替补)',
      'opt.role.en': '原文(Coach / Retired / Stand-in)',
      'set.lb.theme': '主题',
      'th.frost': '毛玻璃', 'th.liquid': '液态玻璃', 'th.tactical': '战术沙盘', 'th.perfect': '完美电竞',
      'th.clear': '透明', 'th.versus': '队色对撞', 'th.crt': '磷光终端', 'th.poster': '期刊海报',
      'th.printstream': '印花集', 'th.blue': '蓝色平台',
      'theme.more': '更多主题',
      'set.lb.opacity': '不透明度',
      'set.lb.interval': '刷新间隔(比赛)', 'set.lb.interval.tip': '比赛列表自动刷新的频率；越小越实时、越耗电，直播中会自动临时加快；一般保持默认即可',
      'set.lb.rowclick': '左键点击对阵', 'set.lb.rowclick.tip': '点击比赛列表里的对阵行时执行的默认操作:无操作=纯浏览、防误触;置顶到主卡=把该场钉上主卡,再点一次取消(赛果行不支持置顶);跳转对阵页=在浏览器打开对阵详情。点击行内的队名、直播间按钮不受此设置影响',
      'set.rowclick.none': '无操作', 'set.rowclick.pin': '置顶到主卡', 'set.rowclick.open': '跳转对阵页',
      'opt.interval.1': '1 分钟(直播中自动加快)', 'opt.interval.2': '2 分钟', 'opt.interval.3': '3 分钟',
      'opt.interval.5': '5 分钟', 'opt.interval.10': '10 分钟',
      'tg.ontop': '窗口置顶',
      'tg.hidebar': '不占任务栏图标(从托盘唤回)',
      'tg.glass': '取景玻璃(真实模糊下层画面)',
      'tg.glass.tip': '毛玻璃/液态玻璃主题下抓取窗口背后的桌面画面做真·高斯模糊与边缘折射。开启期间本窗口在截图/录屏/直播画面中不可见(Windows 防捕捉机制),直播推流时请关闭。',
      'set.lb.blur': '玻璃模糊度',
      'tg.notify': '变阵提醒(系统通知)',
      'tg.autostart': '开机自启',
      'btn.unlock': '解除穿透锁定',
      'btn.quit': '退出应用',
      'wj.title': '打开玩机器Machine 直播间(斗鱼 6657)', 'wj.live': ' · 当前开播',
      'hero.next': '下一场', 'hero.recent': '最近赛果',
      'hero.elapsed': '已进行', 'hero.series': '大比分',
      'hero.round': '第 {n} 回合', 'hero.map': '第{n}图', 'hero.map.mini': '图{n}', 'hero.mapfinal': '最终图', 'hero.inprogress': '进行中', 'hero.waiting': '等待对阵确定',
      'hero.soon': '即将开赛', 'hero.cd.suffix': '{t} 后', 'hero.starts': ' 开赛', 'match.forfeit': '弃赛',
      'hero.starts.orig': '原定 {t} 开赛',
      'shift.postpone': '推迟 {t}', 'shift.advance': '提前 {t}', 'shift.hours': ' 小时', 'shift.minutes': ' 分钟',
      'hero.empty': '暂无比赛数据,点击 ⟳ 刷新', 'hero.syncing': '正在同步比赛数据…',
      'mini.series': ' 大{a} - {b}',
      'chip.rs': ' · 回合比分 {rs} · 大比分 {ss}', 'chip.ss': ' · 大比分 {ss}',
      'chip.round.tip': '{map} · 回合比分 {rs} · 大比分 {ss}',
      'sec.live.others': '直播中 · 其他 {n} 场', 'sec.upcoming': '即将开始', 'sec.upcoming.star': ' · ★ 关注置顶',
      'sec.recent': '最近赛果', 'sec.ongoing': '进行中', 'sec.done': '最近完赛', 'ev.done.dates': '已完赛',
      'ev.done.range': '已完赛·', 'ev.done.ended': '结束于', 'ev.done.syncing': '评级回填中,近期完赛赛事会陆续出现…',
      'empty.upcoming': '暂无安排中的比赛', 'empty.events': '当前没有进行中的赛事', 'empty.transfers': '暂无变阵数据',
      'empty.events.syncing': '正在同步赛事…', 'empty.transfers.syncing': '正在同步变阵数据…',
      'endAgo.now': '刚刚', 'endAgo.min': '{n}分钟前', 'endAgo.hour': '{n}小时前',
      'endAgo.yday': '昨天', 'endAgo.day': '{n}天前',
      'ago.none': '正在同步…', 'ago.now': '刚刚同步', 'ago.min': '{n} 分钟前同步', 'ago.hour': '{n} 小时前同步',
      'sync.err': '同步出错:{e}', 'sync.stale': '数据可能过期(网络受限)', 'sync.ok': '同步正常',
      'fmt.min': '{n} 分钟', 'fmt.hour': '{h} 小时 {m} 分',
      'day.today': '今天', 'day.tomorrow': '明天', 'day.yday': '昨天',
      'star.follow': '关注该队伍', 'star.unfollow': '取消关注',
      'star.btn.add': '已关注队伍 {n}', 'star.btn.dup': '已在关注列表',
      'player.star.add': '已设为高光:{n}', 'player.star.dup': '已是高光选手',
      'player.resolving': '正在同步中…', 'player.err': '解析失败(将重试)', 'player.unk': '未解析到队伍',
      'star.team.tag': '关注队伍', 'player.star.btn': '设为高光选手', 'player.unstar.btn': '取消高光',
      'star.tip.player': '{n} 在阵', 'star.tip.team': '队伍 {n}',
      'star.tip.bench': '{n} 在替补席', 'star.tip.coach': '{n} 在教练席',
      'star.status.inactive': '不活跃', 'star.status.retired': '已退役',
      'title.stars': ' · 含关注:', 'del.tip': '移除', 'sug.none': '无结果', 'sug.searching': '搜索中',
      'sug.hint': '按回车搜索', 'sug.keep': '结果会保留,可稍后查看', 'sug.cache': '已缓存', 'star.search.go': '搜索(回车)',
      'pin.to': '置顶到主卡', 'pin.unpin': '已置顶到主卡,点击取消',
      'pin.title.on': '图钉:已钉在桌面(点击取消)', 'pin.title.off': '图钉:钉在桌面(其他窗口可覆盖,不受显示桌面影响)',
      'medal.champ': '赛事冠军', 'medal.bronze': '季军赛胜者',
      'vrs.rank': 'V社全球排名(VRS)第{n}名', 'vrs.none': '未进入 V社排名(VRS)',
      'tier.title': '赛事评级 {t}',
      'watch.btn': '观战',
      'copy.ok': '已复制:{t}',
      'copy.tip.score': '点击复制比分', 'copy.tip.pair': '点击复制对阵',
      'copy.series': '大比分 {a} - {b}', 'copy.round': '第{n}回合',
      'panda.on': '✓ 已启用:直播中比赛每 45s 同步比分与图数(回合比分需 PandaScore 付费档)',
      'toast.panda.on': '已启用直播比分增强', 'toast.panda.off': '已停用直播比分增强',
      'toast.panda.invalid': 'Token 无效,请检查后重试', 'toast.panda.err': '校验失败: {e}',
      'toast.twitch.saved': 'Twitch 凭证已保存,正在检测英文主播开播',
      'streamer.live': '直播中 · 点击进入直播间', 'streamer.off': '未开播 · 点击仍可进入',
      'ctx.copy.score': '复制比分', 'ctx.copy.pair': '复制对阵', 'ctx.matchpage': '打开对阵页', 'ctx.stream': '打开直播间',
      'ctx.star.follow': '关注 {n}', 'ctx.star.unfollow': '取消关注 {n}',
      'ctx.player.unstar': '取消高光 {n}',
      'ctx.unpin': '取消置顶',
      'ctx.fb': '数据不准?去 GitHub 反馈一下!',
      'set.feedback': '反馈与支持',
      'set.themefb': '这套主题显示有问题?报告它',
      'set.themefb.tip': '直达「界面/主题问题」表单:当前主题、窗口、字号等环境信息会自动附上;截图在提交后拖进正文即可',
      'vrs.foot.tip': 'VRS 排名更新日期 · 数据源 Liquipedia(仅展示;排名不准请在设置页反馈)', 'set.lb.vrs': 'VRS 排名更新', 'set.lb.vrs.tip': 'VRS 是 Valve 官方区域排名:官方约每月发布一期(临近 Major 预选会加密更新),发布时不包含进行中的比赛;Liquipedia 跟随官方同步,通常有数小时到一天延迟;本组件每 6 小时自动核对一次,这里显示的是页面标注的数据更新日期——刚结束的比赛对排名的影响,要等官方下一期发布才会体现。若该时间明显晚于官方最新发布,请点击「排名不准?反馈」',
      'set.vrs.fb': '排名不准?反馈',
      'fb.vrs.title': 'VRS 排名不准或过期',
      'fb.vrs.body': '问题:VRS 排名不准或过期\n本组件数据最后变动于:{d}\n\n请说明:哪支队伍、你看到的排名 vs 实际应为何(附官方来源链接更佳)\n\n——\n版本 v{v} · 主题 {th} · {time}',
      'fb.theme.title': '界面问题:{th} 主题显示异常',
      'set.lb.fx': '动效',
      'set.lb.fx.tip': '以悬停交互为主(悬停主卡/队名即可看到)+ 少量氛围动效,可逐个关闭;「性能优先」开启时全部停用,系统"减少动态效果"时也会自动停用',
      'fx.stripes': '氛围条纹',
      'fx.film': '底片动画',
      'fx.tacsweep': '战术扫光(悬停触发)',
      'fx.crt': '磷光辉光(悬停)',
      'fx.aura': '队色辉光(悬停)',
      'fx.wave': '对撞波 · 边缘照向中线(WebGL)',
      'fx.sheen': '流光跟随(悬停)',
      'fx.gloss': '玻璃高光(悬停)',
      'fx.ink': '油墨按压(悬停)',
      'fx.printink': '三色油墨(悬停)',
      'fx.tilt': '主卡 3D 倾斜(悬停跟随)',
      'fx.none': '这套主题暂无可调动效',
      'fb.title': '[数据反馈] {a} vs {b}',
      'fb.title.generic': '[数据反馈]',
      'fb.body': '请在下方补充说明(哪场比赛 / 哪项数据不准,正确值是什么):\n\n- 比赛:{a} vs {b}\n- 赛事:{e}\n\n\n---\n版本 v{v} · 主题 {th} · 语言 {lg} · {time}',
      'tray.toggle': '显示 / 隐藏', 'tray.mini': '迷你模式', 'tray.ontop': '窗口置顶',
      'tray.deskpin': '图钉(钉在桌面)', 'tray.hidebar': '不占任务栏图标', 'tray.lock': '锁定(鼠标穿透)', 'tray.unlock': '解锁鼠标穿透',
      'tray.refresh': '立即刷新', 'tray.wanjiqi': '玩机器直播间(斗鱼 6657)', 'tray.star': '★ 觉得好用?点个 Star 支持一下!',
      'upd.check': '检查更新', 'upd.checking': '检查中…', 'upd.latest': '已是最新版本', 'upd.avail': '发现新版本',
      'upd.fail': '检查失败,稍后再试', 'upd.unavailable': '暂无法检测(仓库未公开或未发布)', 'upd.github': 'GitHub 仓库', 'upd.badge.tip': '发现新版本,点击查看',
      'upd.dlg.title': '发现新版本', 'upd.dlg.msg': 'RainyWatch {v} 已发布,去 GitHub 看看更新内容?', 'upd.dlg.go': '前往 GitHub', 'upd.dlg.later': '暂不',
      'upd.dlg.install': '一键更新', 'upd.dlg.restart': '重启并安装', 'upd.dlg.dling': '下载中 {p}%', 'upd.dlg.verify': '校验完整性…', 'upd.dlg.ready': '校验通过,点击重启生效', 'upd.dlg.fail': '更新失败:{m}', 'upd.dlg.fail.hash': '校验不一致,安装已取消,可稍后重试', 'upd.dlg.fail.asset': '发行页缺少更新包',
      'upd.dlg.body': '新版本已发布,去 GitHub 看看更新内容?',
      'totop.tip': '回到顶部',
      'tray.autostart': '开机自启', 'tray.quit': '退出',
      'ntf.transfer': 'CS 阵容变动', 'ntf.in': '加入', 'ntf.out': '离开', 'ntf.adj': '调整',
      'ntf.free': '自由球员', 'ntf.prematch': '比赛即将开始', 'ntf.result': '比赛结束',
      'dbg.title': '参数注入', 'dbg.reset': '重置',
      'dbg.status.title': '模拟比赛状态(任意一场真实比赛会被搬进该分支渲染)',
      'dbg.score.title': '模拟大比分',
      'dbg.map.title': '模拟进行中的地图与回合(PandaScore 实时数据)',
      'dbg.mapname.ph': '图名=Nuke/Mirage…(模拟数据源图名)',
      'dbg.mapname.title': '模拟数据源下发的地图名,配合语言设置测试译名显示;留空=真实',
      'dbg.json.ph': '自由注入 JSON:{"score":[1,0],"__pool":{"games":[{"map":"Ancient"},{"map":"Mirage"}]}}',
      'dbg.json.title': '自由 JSON 注入:键直接覆盖比赛字段(score/status/format…);__pool=主卡图序带(games 为 BP 顺序);回车生效,非法 JSON 忽略',
      'dbg.format.title': '模拟 BO 赛制', 'dbg.stage.title': '模拟比赛阶段',
      'opt.dbg.status.0': '状态=真实', 'opt.dbg.status.live': 'live · 进行中', 'opt.dbg.status.upcoming': 'upcoming · 未开始', 'opt.dbg.status.finished': 'finished · 已结束',
      'opt.dbg.score.0': '比分=真实', 'opt.dbg.score.none': '(无比分)',
      'opt.dbg.map.0': '地图/回合=真实', 'opt.dbg.map.none': '(未接入回合数据)',
      'opt.dbg.format.0': '赛制=真实', 'opt.dbg.format.none': '(无赛制)',
      'opt.dbg.stage.0': '阶段=真实', 'opt.dbg.stage.none': '(无阶段)',
      'opt.dbg.stage.gp': '小组赛', 'opt.dbg.stage.po': '淘汰赛', 'opt.dbg.stage.qf': '四分之一决赛',
      'opt.dbg.stage.sf': '半决赛', 'opt.dbg.stage.gf': '总决赛', 'opt.dbg.stage.ubf': '胜者组决赛', 'opt.dbg.stage.lbf': '败者组决赛',
    },
    en: {
      'brand.name': 'RainyWatch',
      'sync.dot': 'Synced · click to refresh (30s cooldown)',
      'sync.refreshing': 'Refreshing…', 'sync.cooldown': 'Too soon — retry in {n}s', 'sync.busy': 'Sync in progress, please wait',
      'btn.mini': 'Toggle mini mode', 'btn.pin': 'Always on top (quick toggle)', 'btn.settings': 'Settings',
      'tab.matches': 'Matches', 'tab.events': 'Events', 'tab.transfers': 'Transfers',
      'set.title': 'Settings',
      'set.title.tip': 'Source: Liquipedia open API (same data as HLTV) · Click a match/event/transfer for details · Click hero score to copy',
      'set.lb.stars': 'Star players & followed teams',
      'set.lb.stars.tip': 'Tip: hover a name in the match or transfer lists and click ★ to follow',
      'star.search.ph': 'Search players to star, e.g. ZywOo / s1mple',
      'set.lb.notify': 'Notifications',
      'tg.prematch': 'Pre-match reminder',
      'opt.pre.5': '5 min before', 'opt.pre.10': '10 min before', 'opt.pre.15': '15 min before', 'opt.pre.30': '30 min before',
      'tg.prematch.starred': 'Only followed matches',
      'tg.results': 'Result alerts (when watched live matches end)',
      'set.lb.live2': 'Live score boost (optional)',
      'set.lb.live2.tip': 'With a token, live matches sync series score and map number every 45s; round-level score needs a paid PandaScore tier, free tier falls back to series score. How to get one: sign up at pandascore.co (free tier works), generate an API token in your dashboard, paste it here; the token is stored locally only',
      'panda.token.ph': 'PandaScore token — free at pandascore.co', 'panda.token.tip': 'How to get one: sign up at pandascore.co (free tier works), generate an API token in your dashboard, paste it here; the token is stored locally only',
      'set.lb.twitch': 'Twitch live check (EN streams)',
      'set.lb.twitch.tip': "The live dots of English streams (ESL, BLAST, etc.) use Twitch's official API and need your own free credentials: open dev.twitch.tv/console (a regular Twitch account works — verify your email and enable two-factor authentication 2FA first) → Register Your Application (any name, category Application, OAuth redirect http://localhost) → copy the Client ID, click New Secret and paste both below. Credentials are stored locally only; without them the app never checks EN streamers and never touches Twitch pages",
      'twitch.id.ph': 'Twitch Client ID — create free at dev.twitch.tv/console', 'twitch.secret.ph': 'Twitch Client Secret — generate via New Secret on the app page',
      'panda.show': 'Show', 'panda.hide': 'Hide', 'panda.foot.tip': 'Source: PandaScore — optional score data source',
      'set.lb.perf': 'Performance',
      'tg.lowpower': 'Prefer performance (no ambient effects, pause when unfocused, glass at 15fps)',
      'tg.lowpower.lite': 'Prefer performance (no ambient effects, pause when unfocused)',
      'tg.flex': 'Flexible mode (run at the cap while on the window, drop to the floor rate on leave)',
      'set.lb.vfps': 'Visual FPS cap',
      'set.lb.vfps.tip': 'The maximum update rate of EVERY visual effect in the window — WebGL wave, looping CSS animations, hover glows and transitions; never exceeded in any mode; Unlimited runs at the display refresh rate. Pairs with Flexible mode: interactions run at this cap, leaving the window drops to the floor rate',
      'set.lb.idlefps': 'Floor rate (Flexible mode)',
      'set.lb.idlefps.tip': 'With Flexible mode on, the rate effects play at while the cursor is outside the window; never above the Visual FPS cap, minimum 15 FPS',
      'set.vfps.unlimited': 'Unlimited',
      'set.lb.size': 'Size preset',
      'set.lb.size.tip': 'You can also drag the window edges to resize freely; the layout adapts',
      'set.lb.window': 'Window',
      'size.mini': 'Mini bar', 'size.mini.tip': 'A single score pill: live score or next-match countdown',
      'size.s': 'Small', 'size.s.tip': 'Small: hero card + a few upcoming matches',
      'size.m': 'Standard', 'size.m.tip': 'Standard: full tabs',
      'size.l': 'Large', 'size.l.tip': 'Large: more rows, larger text',
      'set.lb.evname': 'Event name display',
      'set.lb.evname.tip': 'Event name in lists/hero: abbreviation (default) / full name / Chinese alias (built-in table for IEM/BLAST/ESL etc.; Liquipedia has no official Chinese, unknown falls back to original)',
      'opt.evname.abbr': 'Short (IEM Cologne 2026 → IEM Cologne)',
      'opt.evname.full': 'Full (original name)',
      'opt.evname.zh': 'Chinese alias (IEM Cologne → IEM 科隆)',
      'set.lb.date': 'Date display',
      'opt.date.smart': 'Smart (Today / Tomorrow / Sat)',
      'opt.date.weekday': 'Weekday first (Sat 14:00)',
      'opt.date.date': 'Exact date (09-12 14:00)',
      'set.lb.uptime': 'Start-time display',
      'set.lb.uptime.tip': 'For upcoming matches in the list: A = time only; B = countdown within 1h; A·B = both when close',
      'opt.uptime.start': 'A · time only (Today 14:00)',
      'opt.uptime.cd': 'B · countdown when close (in 00:34:14)',
      'opt.uptime.both': 'A·B · both when close (in 00:34:14 · 14:00)',
      'set.lb.uilang': 'Interface language', 'set.lb.uilang.tip': 'Switches UI language and syncs all language settings (match text / map names / roles); each can still be adjusted separately below',
      'set.lb.fontsize': 'Font size', 'set.lb.fontsize.tip': 'Scales all text app-wide (hero/lists/settings/tabs/titlebar); the mini bar keeps its fixed window; the default step looks exactly as before',
      'opt.fs.1': 'XS', 'opt.fs.2': 'S', 'opt.fs.3': 'Standard (default)', 'opt.fs.4': 'L', 'opt.fs.5': 'XL',
      'set.lb.timezone': 'Match time zone', 'set.lb.timezone.tip': 'All match times (start times, dates) are shown in the selected zone; defaults to your system timezone with DST handled automatically; switch manually to follow the event location or compare zones',
      'opt.tz.auto': 'Auto (system)', 'opt.tz.utc': 'UTC', 'opt.tz.shanghai': 'Beijing', 'opt.tz.tokyo': 'Tokyo', 'opt.tz.seoul': 'Seoul', 'opt.tz.singapore': 'Singapore', 'opt.tz.sydney': 'Sydney', 'opt.tz.moscow': 'Moscow', 'opt.tz.berlin': 'Berlin', 'opt.tz.london': 'London', 'opt.tz.newyork': 'New York', 'opt.tz.la': 'Los Angeles',
      'set.lb.zhfont': 'Chinese font', 'set.lb.zhfont.tip': 'Affects Chinese characters only; digits and Latin text keep each theme\'s Western fonts; switches apply instantly and are saved so you can compare and settle on one',
      'opt.zh.misans': 'MiSans', 'opt.zh.noto': 'Noto Sans SC (default)', 'opt.zh.yahei': 'Microsoft YaHei (system)',
      'set.tab.general': 'General', 'set.tab.display': 'Display', 'set.tab.theme': 'Theme', 'set.tab.follow': 'Follow', 'set.tab.data': 'Data', 'set.tab.about': 'About', 'about.tag': 'CS2 match widget',
      'set.lb.lang': 'Match text language',
      'set.lb.lang.tip': 'Language of match-related text: status words, stage names (Map N/overtime/match point), event-name words etc.; follows the UI language, can still be set separately here',
      'set.lb.maplang': 'Map name display',
      'set.lb.maplang.tip': 'Full names use Perfect World CN translations; short names are community slang. Map names come from the data source (free tier shows "Map N")',
      'opt.map.zh': 'Chinese full (荒漠迷城 / 炼狱小镇)',
      'opt.map.zhShort': 'Chinese short (米垃圾 / 小镇 / 沙二)',
      'opt.map.en': 'Original English (Mirage / Inferno)',
      'set.lb.mapstrip': 'Map info display',
      'set.lb.mapstrip.tip': 'Map info on the hero card: the strip shows previous / current / next maps from the veto; "current only" keeps a single "Map N · name" line',
      'opt.strip.band': 'Map strip (prev · current · next)',
      'opt.strip.cur': 'Current map only (Map N · name)',
      'set.lb.bo1score': 'BO1 score display',
      'set.lb.bo1score.tip': 'Liquipedia prints round scores for BO1 results (7-13, more detail) while PandaScore supplement rows only have the series score (1-0): "round score first" shows the most detailed score available; "series everywhere" normalizes BO1 rows to the series score',
      'opt.bo1.raw': 'Round score first (detail; series as fallback)',
      'opt.bo1.series': 'Series score everywhere (uniform)',
      'set.lb.mintier': 'Event tier filter',
      'set.lb.mintier.tip': 'Show only matches at or above the chosen tier, applied instantly; events without tier info are hidden unless "All events" is picked. Display-only — no data is ever cleared. Pinned hero matches are exempt',
      'opt.tier.all': 'All events',
      'opt.tier.c': 'C and above',
      'opt.tier.b': 'B and above',
      'opt.tier.a': 'A and above',
      'opt.tier.s': 'S only',
      'set.lb.rolelang': 'Player role display',
      'set.lb.rolelang.tip': 'Role/status notes (Coach, benched, Stand-in…) come from Liquipedia; common words are translated, others stay original',
      'set.lb.storystyle': 'Transfer story style',
      'set.lb.storystyle.tip': 'One-line story shown when hovering a transfer: Pro = standard wording; Fun = community memes (bench, thank you for your service)',
      'opt.story.pro': 'Pro (transfers / bench)',
      'opt.story.fun': 'Fun (bench memes / salute)',
      'opt.role.zh': 'Chinese (教练 / 退役 / 替补)',
      'opt.role.en': 'Original (Coach / Retired / Stand-in)',
      'set.lb.theme': 'Theme',
      'th.frost': 'Frost', 'th.liquid': 'Liquid', 'th.tactical': 'Tactical', 'th.perfect': 'Perfect Blue',
      'th.clear': 'Clear', 'th.versus': 'Versus', 'th.crt': 'Phosphor CRT', 'th.poster': 'Poster',
      'th.printstream': 'Printstream', 'th.blue': 'Blue Platform',
      'theme.more': 'More themes',
      'set.lb.opacity': 'Opacity',
      'set.lb.interval': 'Refresh interval (matches)', 'set.lb.interval.tip': 'How often the match list auto-refreshes; lower is more real-time but uses more power; speeds up automatically during live matches; the default suits most cases',
      'set.lb.rowclick': 'Row left-click action', 'set.lb.rowclick.tip': "What a left-click on a match row does: none = browse only; pin to hero = pin that match to the main card, click again to unpin (results rows can't be pinned); open match page = open match details in the browser. Clicks on team names / stream buttons inside a row are not affected",
      'set.rowclick.none': 'Do nothing', 'set.rowclick.pin': 'Pin to hero card', 'set.rowclick.open': 'Open match page',
      'opt.interval.1': '1 min (auto faster when live)', 'opt.interval.2': '2 min', 'opt.interval.3': '3 min',
      'opt.interval.5': '5 min', 'opt.interval.10': '10 min',
      'tg.ontop': 'Always on top',
      'tg.hidebar': 'No taskbar icon (restore from tray)',
      'tg.glass': 'Capture glass (real blur behind window)',
      'tg.glass.tip': 'Under Frost/Liquid themes, captures the desktop behind the window for true gaussian blur and edge refraction. While on, this window is invisible to screenshots/screen share (Windows anti-capture) — turn off when streaming.',
      'set.lb.blur': 'Glass blur',
      'tg.notify': 'Roster alerts (system notifications)',
      'tg.autostart': 'Launch at startup',
      'btn.unlock': 'Unlock click-through',
      'btn.quit': 'Quit app',
      'wj.title': 'Open Wanjqi live room (Douyu 6657)', 'wj.live': ' · live now',
      'hero.next': 'Next up', 'hero.recent': 'Latest result',
      'hero.elapsed': 'Elapsed', 'hero.series': 'Series',
      'hero.round': 'Round {n}', 'hero.map': 'Map {n}', 'hero.map.mini': 'Map {n}', 'hero.mapfinal': 'Final map', 'hero.inprogress': 'In progress', 'hero.waiting': 'Awaiting opponent',
      'hero.soon': 'Starting soon', 'hero.cd.suffix': 'in {t}', 'hero.starts': ' starts', 'match.forfeit': 'Forfeit',
      'hero.starts.orig': 'originally {t}',
      'shift.postpone': 'postponed {t}', 'shift.advance': 'moved up {t}', 'shift.hours': 'h', 'shift.minutes': 'min',
      'hero.empty': 'No match data · click ⟳ to refresh', 'hero.syncing': 'Syncing match data…',
      'mini.series': ' S{a} - {b}',
      'chip.rs': ' · round score {rs} · series {ss}', 'chip.ss': ' · series {ss}',
      'chip.round.tip': '{map} · round score {rs} · series {ss}',
      'sec.live.others': 'Live · {n} more', 'sec.upcoming': 'Upcoming', 'sec.upcoming.star': ' · ★ starred first',
      'sec.recent': 'Results', 'sec.ongoing': 'Ongoing', 'sec.done': 'Recently ended', 'ev.done.dates': 'Ended',
      'ev.done.range': 'Ended · ', 'ev.done.ended': 'Ended at', 'ev.done.syncing': 'Backfilling ratings — recent events will appear here…',
      'empty.upcoming': 'No scheduled matches', 'empty.events': 'No ongoing events', 'empty.transfers': 'No roster changes yet',
      'empty.events.syncing': 'Syncing events…', 'empty.transfers.syncing': 'Syncing roster changes…',
      'endAgo.now': 'just now', 'endAgo.min': '{n}m ago', 'endAgo.hour': '{n}h ago',
      'endAgo.yday': 'yesterday', 'endAgo.day': '{n}d ago',
      'ago.none': 'Syncing…', 'ago.now': 'Synced just now', 'ago.min': 'Synced {n} min ago', 'ago.hour': 'Synced {n} h ago',
      'sync.err': 'Sync error: {e}', 'sync.stale': 'Data may be stale (network limited)', 'sync.ok': 'Sync OK',
      'fmt.min': '{n} min', 'fmt.hour': '{h} h {m} min',
      'day.today': 'Today', 'day.tomorrow': 'Tomorrow', 'day.yday': 'Yesterday',
      'star.follow': 'Follow team', 'star.unfollow': 'Unfollow',
      'star.btn.add': 'Following {n}', 'star.btn.dup': 'Already followed',
      'player.star.add': 'Starred: {n}', 'player.star.dup': 'Already starred',
      'player.resolving': 'Syncing…', 'player.err': 'Resolve failed (will retry)', 'player.unk': 'Team not resolved',
      'star.team.tag': 'Followed team', 'player.star.btn': 'Star player', 'player.unstar.btn': 'Unstar',
      'star.tip.player': '{n} playing', 'star.tip.team': 'Team {n}',
      'star.tip.bench': '{n} on the bench', 'star.tip.coach': '{n} as coach',
      'star.status.inactive': 'Inactive', 'star.status.retired': 'Retired',
      'title.stars': ' · starred: ', 'del.tip': 'Remove', 'sug.none': 'No results', 'sug.searching': 'Searching',
      'sug.hint': 'Press Enter to search', 'sug.keep': 'Results are kept — check back anytime', 'sug.cache': 'Cached', 'star.search.go': 'Search (Enter)',
      'pin.to': 'Pin to hero card', 'pin.unpin': 'Pinned to hero card — click to unpin',
      'pin.title.on': 'Pinned to desktop (click to unpin)', 'pin.title.off': 'Pin to desktop (other windows can cover it; survives Win+D)',
      'medal.champ': 'Event champion', 'medal.bronze': '3rd-place winner',
      'vrs.rank': 'Valve global rank (VRS) #{n}', 'vrs.none': 'Not in Valve global rank (VRS)',
      'tier.title': 'Event tier {t}',
      'watch.btn': 'Watch',
      'copy.ok': 'Copied: {t}',
      'copy.tip.score': 'Click to copy score', 'copy.tip.pair': 'Click to copy matchup',
      'copy.series': 'Series {a} - {b}', 'copy.round': 'Round {n}',
      'panda.on': '✓ Enabled: live matches sync score & map number every 45s (round-level score needs a paid PandaScore tier)',
      'toast.panda.on': 'Live score boost enabled', 'toast.panda.off': 'Live score boost disabled',
      'toast.panda.invalid': 'Invalid token — please check and retry', 'toast.panda.err': 'Validation failed: {e}',
      'toast.twitch.saved': 'Twitch credentials saved — checking EN streamers',
      'streamer.live': 'Live · click to open', 'streamer.off': 'Offline · click to open anyway',
      'ctx.copy.score': 'Copy score', 'ctx.copy.pair': 'Copy matchup', 'ctx.matchpage': 'Match page', 'ctx.stream': 'Live stream',
      'ctx.star.follow': 'Follow {n}', 'ctx.star.unfollow': 'Unfollow {n}',
      'ctx.player.unstar': 'Unstar {n}',
      'ctx.unpin': 'Unpin',
      'ctx.fb': 'Inaccurate data? Report it on GitHub!',
      'set.feedback': 'Feedback & Support',
      'set.themefb': 'Theme looks broken? Report it',
      'set.themefb.tip': 'Opens the UI/theme issue form with theme, window and font info auto-attached; drag screenshots into the body after submitting.',
      'vrs.foot.tip': 'VRS update date · source Liquipedia (display only; report stale ranks via settings)', 'set.lb.vrs': 'VRS ranking updated', 'set.lb.vrs.tip': 'VRS is Valve\'s official regional ranking: a new edition ships roughly every month (more often near Major qualifier windows) and never includes ongoing events; Liquipedia mirrors it with hours up to a day of delay; this widget re-checks every 6 hours — the date shown is when the data last changed, and the impact of a just-finished event only appears in the next official release. If it clearly lags the latest official release, use "Stale rank? Report" below',
      'set.vrs.fb': 'Stale rank? Report',
      'fb.vrs.title': 'VRS ranking stale or wrong',
      'fb.vrs.body': 'Issue: VRS ranking stale or wrong\nData last changed at: {d}\n\nPlease tell us: which team, the rank you see vs what it should be (an official source link helps)\n\n——\nVersion v{v} · Theme {th} · {time}',
      'fb.theme.title': 'UI issue: {th} theme rendering',
      'set.lb.fx': 'Motion',
      'set.lb.fx.tip': 'Hover interactions first (hover the hero card or a team name) plus a little ambient motion; toggle individually. "Performance mode" or the system reduce-motion setting disables all of them.',
      'fx.stripes': 'Ambient stripes',
      'fx.film': 'Film strip animation',
      'fx.tacsweep': 'Tactical sweep (on hover)',
      'fx.crt': 'Phosphor glow (hover)',
      'fx.aura': 'Team auras (hover)',
      'fx.wave': 'Clash wave (hero ambience, WebGL)',
      'fx.sheen': 'Cursor sheen (hover)',
      'fx.gloss': 'Glass highlight (hover)',
      'fx.ink': 'Ink press (hover)',
      'fx.printink': 'Tri-color ink (hover)',
      'fx.tilt': 'Card 3D tilt (hover follow)',
      'fx.none': 'No effects for this theme',
      'fb.title': '[Data feedback] {a} vs {b}',
      'fb.title.generic': '[Data feedback]',
      'fb.body': 'Please describe what is inaccurate (which match / which value, and the correct one):\n\n- Match: {a} vs {b}\n- Event: {e}\n\n\n---\nVersion v{v} · theme {th} · lang {lg} · {time}',
      'tray.toggle': 'Show / Hide', 'tray.mini': 'Mini mode', 'tray.ontop': 'Always on top',
      'tray.deskpin': 'Pin to desktop', 'tray.hidebar': 'Hide taskbar icon', 'tray.lock': 'Lock (click-through)', 'tray.unlock': 'Unlock click-through',
      'tray.refresh': 'Refresh now', 'tray.wanjiqi': 'Wanjiqi live (Douyu 6657)', 'tray.star': '★ Enjoy it? A Star helps!',
      'upd.check': 'Check for updates', 'upd.checking': 'Checking…', 'upd.latest': 'You are up to date', 'upd.avail': 'Update available',
      'upd.fail': 'Check failed, try again later', 'upd.unavailable': 'Unavailable (repo not public or no release)', 'upd.github': 'GitHub repo', 'upd.badge.tip': 'Update available — click to view',
      'upd.dlg.title': 'Update available', 'upd.dlg.msg': 'RainyWatch {v} is out. Open GitHub to see the changes?', 'upd.dlg.go': 'Open GitHub', 'upd.dlg.later': 'Not now',
      'upd.dlg.install': 'Update in app', 'upd.dlg.restart': 'Restart & install', 'upd.dlg.dling': 'Downloading {p}%', 'upd.dlg.verify': 'Verifying…', 'upd.dlg.ready': 'Verified — restart to apply', 'upd.dlg.fail': 'Update failed: {m}', 'upd.dlg.fail.hash': 'Checksum mismatch — cancelled, try again later', 'upd.dlg.fail.asset': 'Release assets missing',
      'upd.dlg.body': 'A new release is out. Open GitHub to see the changes?',
      'totop.tip': 'Back to top',
      'tray.autostart': 'Launch at startup', 'tray.quit': 'Quit',
      'ntf.transfer': 'CS roster change', 'ntf.in': 'joins', 'ntf.out': 'leaves', 'ntf.adj': 'moves within',
      'ntf.free': 'free agent', 'ntf.prematch': 'Match starting soon', 'ntf.result': 'Match finished',
      'dbg.title': 'Param injection', 'dbg.reset': 'Reset',
      'dbg.status.title': 'Simulate match status (a real match is moved into that branch)',
      'dbg.score.title': 'Simulate series score',
      'dbg.map.title': 'Simulate live map & round (PandaScore data)',
      'dbg.mapname.ph': 'Map name = Nuke/Mirage… (simulated)',
      'dbg.mapname.title': 'Simulate the map name from the data source to test translations; empty = real',
      'dbg.json.ph': 'Free JSON: {"score":[1,0],"__pool":{"games":[{"map":"Ancient"},{"map":"Mirage"}]}}',
      'dbg.json.title': 'Free JSON injection: keys override match fields (score/status/format…); __pool = hero map strip (games in pick order); Enter applies, invalid JSON ignored',
      'dbg.format.title': 'Simulate BO format', 'dbg.stage.title': 'Simulate match stage',
      'opt.dbg.status.0': 'Status = real', 'opt.dbg.status.live': 'live · in progress', 'opt.dbg.status.upcoming': 'upcoming · not started', 'opt.dbg.status.finished': 'finished · ended',
      'opt.dbg.score.0': 'Score = real', 'opt.dbg.score.none': '(no score)',
      'opt.dbg.map.0': 'Map/round = real', 'opt.dbg.map.none': '(no round data)',
      'opt.dbg.format.0': 'Format = real', 'opt.dbg.format.none': '(no format)',
      'opt.dbg.stage.0': 'Stage = real', 'opt.dbg.stage.none': '(no stage)',
      'opt.dbg.stage.gp': 'Group stage', 'opt.dbg.stage.po': 'Playoffs', 'opt.dbg.stage.qf': 'Quarterfinals',
      'opt.dbg.stage.sf': 'Semifinals', 'opt.dbg.stage.gf': 'Grand Final', 'opt.dbg.stage.ubf': 'Upper bracket final', 'opt.dbg.stage.lbf': 'Lower bracket final',
    },
  };
  function uit(key, lang) {
    const l = lang === 'en' ? 'en' : 'zh';
    return (UI[l] && UI[l][key]) ?? UI.zh[key] ?? key;
  }
  // 变阵解说:方向+备注 → 一句话注释(条目悬停浮现;模板预写、占位替换,双语)
  // 分支覆盖:Liquipedia 备注(retired/benched/stand-in/loan/trial/inactive/coach 系)与
  // 三种方向(in 转会/加盟、out 离开、其余=队内调整),未知组合落兜底句
  // 变阵解说:方向+备注 → 一句话注释(条目内悬停展开;模板预写、占位替换,双语)。
  // style: 'pro'=标准措辞;'fun'=社区梗([一半生活电视]xx板凳xx、感谢服役)。两套共用分支树,顺序敏感:
  //   复出(unretire/复出回归,须先于 retire 与 inactive) → 退役转型(retire+coach 系)
  //   → 回归首发(back from bench,须先于 bench 判,否则方向反转) → 擢升/下放(同组织青训⇄一线队,名称匹配)
  //   → 替补席(bench;LP 的 Inactive 主体形态=同队挂编,按 CS 圈语义归"转入替补席") → 非活跃(排除 loan/同队挂编)
  //   → 队内转型(中性方向+coach 系) → stand-in/替补 → loan → trial → 退役(retire)
  //   → in(自由人/转会/教练履新) → out(离开) → 兜底
  // 同组织青训/二队识别:子队名含青训标记词,去掉标记后与母队队名同源(paiN Gaming Academy ⇄ paiN Gaming)。
  // 匹配刻意保守:标记词与名称同源两个条件缺一不可,防"Hunters Rising"这类名字自带标记词的独立队被误判
  const ACAD_MARK = /academy|\bnxt\b|rising\b|prodigy\b|\bnext\b|junior|youth|young|fever|evolve|二队|青训/i;
  const normTeam = (s) => String(s || '').toLowerCase().replace(/\b(team|esports|gaming|club)\b/g, '').replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  function academyOf(sub, main) {
    if (!sub || !main || !ACAD_MARK.test(sub)) return false;
    const s = normTeam(sub), m = normTeam(main);
    if (!s || !m || s === m) return false;
    const root = s.replace(/academy|nxt|rising|prodigy|next|junior|youth|young|fever|evolve/g, '');
    return !!root && (root.startsWith(m) || m.startsWith(root) || root.includes(m) || m.includes(root));
  }
  function transferDir(t) { // 展示方向:青训队→母队按"擢升/加入"呈现;LP 标成 neutral 的普通转会(来去两队都有且不同)按"加入"呈现
    if (academyOf(t.oldTeam, t.newTeam)) return 'in';
    const d = t.direction;
    if (d !== 'in' && d !== 'out' && t.oldTeam && t.newTeam && t.oldTeam !== t.newTeam) return 'in';
    return d;
  }
  function transferStory(t, lang, style) {
    const en = lang === 'en';
    const fun = style === 'fun';
    const note = String(t.note || '').toLowerCase();
    const p = String(t.player || '');
    const from = String(t.oldTeam || '');
    const to = String(t.newTeam || '');
    const team = to || from;
    const sameTeam = from && from === to; // 原队挂编:LP 的 Inactive 主体形态,按 CS 圈语义即"转入替补席"
    let dir = t.direction;
    // LP 方向标注粗糙:不少普通转会(如 0G→NiP)也被标成 neutral。来去两队都有且非同队,按转会解读
    if (dir !== 'in' && dir !== 'out' && from && to && !sameTeam) dir = 'in';
    const isCoach = /coach|manager|analyst|director/i.test(note);
    const role = isCoach ? (en ? 'Coach ' : '教练') : (en ? 'Player ' : '选手');
    const roleNoun = /head[\s-]*coach/i.test(note) ? (en ? 'head coach' : '主教练')
      : /assistant[\s-]*coach/i.test(note) ? (en ? 'assistant coach' : '助理教练')
      : /analyst/i.test(note) ? (en ? 'analyst' : '分析师')
      : /manager/i.test(note) ? (en ? 'manager' : '经理')
      : isCoach ? (en ? 'coach' : '教练') : (en ? 'player' : '选手');
    if (/unretire|out[\s-]*of[\s-]*retirement|comeback|return(s|ing)?[\s-]*from[\s-]*inactiv/i.test(note)) {
      if (fun) return en ? `${p} is back! ${to ? 'Now wearing ' + to + "'s jersey" : 'Back on the server'}` : `${p}复出!${to ? '这回披上' + to + '的战袍' : '重返赛场'}`;
      return en ? `${role}${p} comes out of retirement${to ? ' and joins ' + to : ''}` : `${role}${p}复出${to ? ',加盟' + to : ''}`;
    }
    if (/retire/.test(note) && isCoach && dir !== 'out') {
      if (fun) return en ? `${p} retires — but not from the scene: now the ${roleNoun} of ${team}` : `${p}退役不退场,转身当上了${team}的${roleNoun}`;
      return en ? `${p} retires and takes over as the ${roleNoun} of ${team}` : `${p}退役,转型担任${team}的${roleNoun}`;
    }
    if (/back[\s-]*from[\s-]*bench|return(s|ing)?[\s-]*(to[\s-]*)?(the[\s-]*)?(active|start)/i.test(note)) {
      if (fun) return en ? `${p} climbs back off the bench at ${team}` : `${p}从板凳上站起来了,重回${team}首发`;
      return en ? `${role}${p} returns to the active roster at ${team}` : `${role}${p}在${team}回归首发阵容`;
    }
    // 同组织青训⇄一线队:擢升/下放(LP 把这类行常标成 neutral"调整",须先于 bench/inactive 与普通转会分支)
    if (academyOf(from, to)) {
      if (fun) return en ? `${p} gets the call-up: from ${from} to ${to}'s main roster` : `${p}被提拔了:从${from}升入${to}一线队`;
      return en ? `${role}${p} is promoted from ${from} to ${to}'s main roster` : `${role}${p}从${from}擢升至${to}一线队`;
    }
    if (academyOf(to, from)) {
      if (fun) return en ? `${p} heads down to ${to} to grind in the academy squad` : `${p}被下放到${to}练级`;
      return en ? `${role}${p} is demoted to the academy squad ${to}` : `${role}${p}被下放至${to}(二队/青训)`;
    }
    if (/bench/.test(note) || (sameTeam && /inactiv/.test(note))) {
      if (fun) return team ? (en ? `HLTV.news: ${team} bench ${p}` : `[一半生活电视] ${team}板凳了${p}`) : (en ? `HLTV.news: ${p} has been benched` : `[一半生活电视] ${p}被板凳了`);
      return en ? `${role}${p} is benched at ${team || 'the roster'}` : `${role}${p}在${team || '队内'}转入替补席`;
    }
    if (/inactiv/.test(note) && !/loan/.test(note)) { // 带 loan 的复合备注(Loan/Inactive)让给下面的租借分支
      if (!to) { // 挂编后离队(去向为空):人已不在阵中,"还挂名单"的说法不成立
        if (fun) return en ? `${p} and ${from || 'the team'} have parted ways — now idle in offline mode` : `${p}与${from || '原队伍'}分道扬镳,进入离线挂机状态`;
        return en ? `${role}${p} has left ${from || 'the roster'} — currently inactive` : `${role}${p}已离开${from || '原队伍'},目前处于非活跃状态`;
      }
      if (fun) return en ? `${p} is still on ${team || "the roster"}'s books, just not playing` : `${p}还挂在${team || '队内'}名单上,只是暂不上场`;
      return en ? `${role}${p} is inactive at ${team || 'the roster'}` : `${role}${p}在${team || '队内'}处于非活跃状态`;
    }
    if (isCoach && dir !== 'in' && dir !== 'out') {
      if (fun) return en ? `${p} swaps the rifle for the ${roleNoun} seat at ${team || 'the team'}` : `${p}放下枪,在${team || '队内'}改坐了${roleNoun}席`;
      return en ? `${p} transitions to ${roleNoun} at ${team || 'the team'}` : `${p}在${team || '队内'}转型担任${roleNoun}`;
    }
    if (/stand[\s-]*in|substitut/i.test(note)) { // stand-in 与 substitute 同归"替补"分支
      if (fun) return en ? `${team || 'The team'} pulls in ${p} as an emergency stand-in` : `${team || '新东家'}拉来${p}临时救火(替补登场)`;
      return en ? `${p} joins ${team || 'the team'} as a stand-in` : `${p}以临时替补身份加入${team || '新东家'}`;
    }
    if (/loan/.test(note)) {
      if (fun) return en ? `${p} heads to ${team || 'another team'} on loan` : `${p}被暂时外借到${team || '别处'}打比赛`;
      return en ? `${role}${p} is loaned to ${team || 'another team'}` : `${role}${p}租借至${team || '其他队伍'}`;
    }
    if (/trial/.test(note)) {
      if (fun) return en ? `${p} is trialing with ${team || 'a new team'} — no contract yet` : `${p}正在${team || '新东家'}试用,还没正式签约`;
      return en ? `${p} trials with ${team || 'a new team'}` : `${p}在${team || '新东家'}试训`;
    }
    if (/retire/.test(note)) {
      if (fun) return from
        ? (en ? `Thank you for your service! ${p} retires as a member of ${from}.` : `感谢服役!${p}已于${from}退役。`)
        : (en ? `Thank you for your service! ${p} retires as a free agent.` : `感谢服役!${p}已以自由人身份退役。`);
      return en ? `${role}${p} retires — the career ends at ${from || 'the pro scene'}` : `${role}${p}在${from || '职业赛场'}结束职业生涯,正式退役`;
    }
    if (dir === 'in') {
      if (!from) return en ? `${role}${p} joins ${to || 'the roster'} as a free agent` : `${role}${p}以自由人身份加盟${to || '新东家'}`;
      if (isCoach) {
        if (fun) return en ? `${p} takes over the coaching seat at ${to}, leaving ${from}` : `${p}换了执教席位:离开${from},去${to}执教`;
        return en ? `${role}${p} leaves ${from} to coach ${to}` : `${role}${p}离开${from},转任${to}教练`;
      }
      if (fun) return en ? `${p} switches teams: from ${from} to ${to}` : `${p}换队了:从${from}去了${to}`;
      return en ? `${role}${p} transfers from ${from} to ${to || 'TBD'}` : `${role}${p}从${from}转会至${to || '待定'}`;
    }
    if (dir === 'out') {
      if (fun) return en ? `${p} is out of ${from || 'the team'} — no next stop yet` : `${p}离开了${from || '原东家'},还没定去哪`;
      return en ? `${p} leaves ${from || 'the team'} — next stop TBD` : `${p}离开${from || '原东家'},下家待定`;
    }
    if (fun) return en ? `${p} stays at ${team || 'the team'}, just in a new role` : `${p}还在${team || '队内'},只是换了个角色`;
    return en ? `${p} takes on a new role at ${team || 'the team'}` : `${p}在${team || '队内'}进行队内角色调整`;
  }
  const api = { tr, trDates, tierLabel, roleLabel, transferNote, country, abbr, abbrEvent, zhEvent, transferStory, transferDir, uit, UI };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.I18N = api;
})(typeof window !== 'undefined' ? window : globalThis);
