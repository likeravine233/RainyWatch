// 队伍主色:队标像素聚类提取(有迹可循) + 策划色兜底(黑白灰 logo) + 确定性哈希兜底
// 暴露 window.TC = { colorFor(name, href), tint(hex, amt) }
window.TC = (() => {
  // 键为去空格大写的常用名/全名
  const MAP = {
    // —— 队标主色:2026-09-10 从 Liquipedia commons 队标 PNG 像素聚类提取
    //    (剔除透明/近黑/近白/低饱和像素,色相 10° 分桶按饱和度²加权取主桶;
    //     明度/饱和度收进深底 UI 可读区间 L 0.42~0.62、S 0.42~0.90)
    '3DMAX': '#c80e0e',
    '6666': '#cb0b0b',
    ALLIANCE: '#23b323',
    ASTRALIS: '#f20d0d',
    BB: '#f54747',
    BBL: '#cb6b0b',
    EYE: '#bd1919',
    FIREFLUX: '#0bcbcb',
    FLAMEH: '#cb6b0b',
    G2: '#FFFFFF', G2ESPORTS: '#FFFFFF', // 2026-09-14 人工校色:黑白标定白(原聚类红)
    IC: '#f53f3f',
    INFINITE: '#cd0b0b',
    LEGACY: '#ef7e0d',
    LG: '#236bb3',
    LIQUID: '#0b6bcb', TEAMLIQUID: '#0b6bcb',
    M80: '#d0d00b',
    MAGIC: '#6b2caa',
    MZP: '#986b3e',
    NAVIJR: '#cbcb0b', NAVIJUNIOR: '#cbcb0b', // NAVI 系青年队,沿用黄
    NIP: '#f2f20d', NINJASINPYJAMAS: '#f2f20d',
    NT: '#6b27b0',
    PV: '#0bcbcb', PARIVISION: '#0bcbcb',
    SAW: '#a26b34',
    TYLOO: '#ab2b2b',
    // —— 策划色:黑白/灰 logo 提取不出 chroma(9z/BIG/FURIA/MIBR/B8 等),或未在当前赛程的知名队
    NAVI: '#FFE11A', NATUSVINCERE: '#FFE11A',  // Natus Vincere 全名归一后是 NATUSVINCERE(多写一个 I 会整键脱靶走哈希紫)
    FAZE: '#E3352C', FAZECLAN: '#E3352C',
    VITALITY: '#F2C200', TEAMVITALITY: '#F2C200',
    MOUZ: '#E2001A', MOUZSPORTS: '#E2001A', MOUZNXT: '#8ED0F0',
    SPIRIT: '#F5B800', TEAMSPIRIT: '#F5B800',
    VIRTUSPRO: '#F26522', VP: '#F26522',
    HEROIC: '#F40000',
    COMPLEXITY: '#2A5CDB', COL: '#2A5CDB',
    FURIA: '#9AA0A6', FURIAESPORTS: '#9AA0A6',
    MIBR: '#00A868',
    CLOUD9: '#00B7EF', C9: '#00B7EF',
    BIG: '#E9B400', BIGCLAN: '#E9B400',
    ENCE: '#4FB3BF',
    MONGOLZ: '#D7263D', THEMONGOLZ: '#D7263D',
    RAREATOM: '#8F7BFF', RA: '#8F7BFF',
    LYNNVISION: '#35C56E', LV: '#35C56E',
    PAIN: '#B01E28', PAINGAMING: '#B01E28',
    '9Z': '#F0B400',
    FALCONS: '#0FA36B', TEAMFALCONS: '#0FA36B',
    AURORA: '#43C6BB', AURORAGAMING: '#43C6BB', // 2026-09-13 人工校色:队标主色为青绿
    ECO: '#3ECF8E', GAMERSCLUB: '#C22021',
    IMPERIAL: '#17B978', PAI: '#FF6B6B',
    WILDCARD: '#C43CB4', NRG: '#E5E5E5',
    FLYQUEST: '#5A2ED6', PASSIONUA: '#FFD54A',
    B8: '#B7B7E2', SANGAL: '#FF8A2A', SINNER: '#D93A1A', '9INE': '#7FE05F',
    BASEMENTBOYS: '#6E7B8B', DYNAMOECL: '#E4572E',
    // —— 2026-09-10 补采:lightmode 原图聚类仍无彩色像素的单色品牌,策划中性灰兜底(明度略作区分)
    '5STAR': '#E5E5E5', '5STARESPORTS': '#E5E5E5',
    OLDBOYS: '#DDE1E7',
    WOPA: '#D8DCE2', WOPAESPORT: '#D8DCE2',
    GL: '#C2C9D3', GAMERLEGION: '#C2C9D3',
    GP: '#EFA000',
    // —— 2026-09-13 人工校色:色板核对哈希兜底后收编入 MAP(8 项)
    SINNERS: '#A23232',
    NEMIGA: '#D60000',
    JUSTP: '#DBF0FE',
    IBERSOUL: '#CBC6B7',
    FLCFORCE: '#3CBE6B',
    EF: '#978B66',
    BW: '#EFE475',
    PHOENIX: '#FCFCFD',
    // —— 2026-09-14 人工校色:双源校对页导出回写(哈希兜底收编 18 项)
    '3DMAXACADEMY': '#D90400', AABACADEMY: '#94132A',
    ACEND: '#673BF0', BESTIA: '#FFFFFF', CYBERSHOKEESPORTS: '#FFFFFF',
    ECSTATIC: '#9F8B56', ESPORTACADEMYCOPENHAGEN: '#49C1B0', FARMVILLE: '#FFFFFF',
    FOURMAGIC: '#F9BF00', MASQ: '#8F9396', NEXUSGAMING: '#48BB9D',
    REDCANIDS: '#F30000', SHIMMER: '#B599D7', TEAMLEISURE: '#FCFCFC',
    THEGOLDENHORDE: '#FCE600', UNITYESPORTS: '#E5325C', UNREALNIGHTMARE: '#CC2931',
    WIMOK: '#FFFFFF',
  };

  function fnv(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function hsl2hex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const to = x => Math.round(255 * x).toString(16).padStart(2, '0');
    return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
  }
  const norm = (s) => String(s || '').toUpperCase().replace(/[\s._\-]/g, '');

  // 同队"缩写↔全称"双形态归一(键=norm 后):LP 赛程常显示缩写/短名(EF、BBL、Aurora),
  // 变阵与队页用全名(Eternal Fire、BBL Esports、Aurora Gaming)——norm 不相等,
  // 不归一的话同一支队会因显示名不同走两套颜色(全名形态脱靶进哈希)。
  // 键收敛方向:归一到 MAP 里已有色的常用名键;校色工具与本表同源同表。
  const ALIAS = {
    AURORAGAMING: 'AURORA', ETERNALFIRE: 'EF', BBLESPORTS: 'BBL',
  };

  function colorFor(name, href) {
    let key = ALIAS[norm(name)] || norm(name);
    if (MAP[key]) return MAP[key];
    if (href) { // 队页 slug 是更稳的身份信号(显示名千变,页名不轻易改):Aurora_Gaming→AURORAGAMING→AURORA
      const hk = ALIAS[norm(href)] || norm(href);
      if (MAP[hk]) return MAP[hk];
    }
    const h = fnv(key || href || 'x') % 360;
    return hsl2hex(h, 60, 58);
  }
  // 向白色混合:用于文字可读性
  function tint(hex, amt) {
    const m = hex.replace('#', '');
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    const mix = c => Math.round(c + (255 - c) * amt);
    return `#${[mix(r), mix(g), mix(b)].map(x => x.toString(16).padStart(2, '0')).join('')}`;
  }
  return { colorFor, tint };
})();
