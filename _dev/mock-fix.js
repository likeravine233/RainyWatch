// mock 补全:变阵新推断动作演示(队→队转会/租借/擢升/下放二队/替补加入)+ VRS 页面日期
// 用法:node mock-fix.js(在 _dev 内);可重复运行——先删同名新增 id 再插入,幂等
const fs = require('fs');
const p = __dirname + '/mock-data.json';
const m = JSON.parse(fs.readFileSync(p, 'utf8'));

const LOGO = {
  falcons: 'https://liquipedia.net/commons/images/thumb/8/83/Team_Falcons_2022_allmode.png/50px-Team_Falcons_2022_allmode.png',
  navi: 'https://liquipedia.net/commons/images/thumb/3/3f/Natus_Vincere_2021_lightmode.png/57px-Natus_Vincere_2021_lightmode.png',
  metiz: 'https://liquipedia.net/commons/images/thumb/d/d9/Metizport_2025_allmode.png/50px-Metizport_2025_allmode.png',
  pain: 'https://liquipedia.net/commons/images/thumb/d/d3/PaiN_Gaming_2023_darkmode.png/75px-PaiN_Gaming_2023_darkmode.png',
  m80: 'https://liquipedia.net/commons/images/thumb/5/55/M80_2023_allmode.png/50px-M80_2023_allmode.png',
};
const HREF = { falcons: 'https://liquipedia.net/counterstrike/Team_Falcons', navi: 'https://liquipedia.net/counterstrike/Natus_Vincere', metiz: 'https://liquipedia.net/counterstrike/Metizport', pain: 'https://liquipedia.net/counterstrike/PaiN_Gaming', m80: 'https://liquipedia.net/counterstrike/M80' };

const ADD = [
  { // 租借:9z → Team Falcons,Loan 备注 → 「租借」标签
    id: '2026-09-09|dav1g|in|Team Falcons', date: '2026-09-09', player: 'dav1g', playerHref: '',
    flag: 'Argentina', direction: 'in', oldTeam: '9z', newTeam: 'Team Falcons',
    oldTeamHref: '', newTeamHref: HREF.falcons, oldLogo: '', newLogo: LOGO.falcons,
    note: 'Loan', ref: '',
  },
  { // 擢升:paiN Gaming Academy → paiN Gaming 一线队
    id: '2026-09-08|n1ssim|in|paiN Gaming', date: '2026-09-08', player: 'n1ssim', playerHref: '',
    flag: 'Brazil', direction: 'in', oldTeam: 'paiN Gaming Academy', newTeam: 'paiN Gaming',
    oldTeamHref: '', newTeamHref: HREF.pain, oldLogo: '', newLogo: LOGO.pain,
    note: '', ref: '',
  },
  { // 队→队普通转会:Metizport → NAVI
    id: '2026-09-07|sjuush|in|NAVI', date: '2026-09-07', player: 'sjuush', playerHref: '',
    flag: 'Denmark', direction: 'in', oldTeam: 'Metizport', newTeam: 'NAVI',
    oldTeamHref: HREF.metiz, newTeamHref: HREF.navi, oldLogo: LOGO.metiz, newLogo: LOGO.navi,
    note: '', ref: '',
  },
  { // 下放二队:Team Falcons → Team Falcons Academy
    id: '2026-09-05|tofoo|~|Team Falcons Academy', date: '2026-09-05', player: 'tofoo', playerHref: '',
    flag: 'Denmark', direction: '~', oldTeam: 'Team Falcons', newTeam: 'Team Falcons Academy',
    oldTeamHref: HREF.falcons, newTeamHref: '', oldLogo: LOGO.falcons, newLogo: '',
    note: '', ref: '',
  },
  { // 替补加入:Stand-in 备注
    id: '2026-09-04|Pala|in|M80', date: '2026-09-04', player: 'Pala', playerHref: '',
    flag: 'United States', direction: 'in', oldTeam: '', newTeam: 'M80',
    oldTeamHref: '', newTeamHref: HREF.m80, oldLogo: '', newLogo: LOGO.m80,
    note: 'Stand-in', ref: '',
  },
];

const before = m.transfers.length;
m.transfers = m.transfers.filter((t) => !ADD.some((a) => a.id === t.id));
for (const a of ADD) {
  const i = m.transfers.findIndex((t) => t.date < a.date || (t.date === a.date));
  m.transfers.splice(i === -1 ? m.transfers.length : i, 0, a); // 插到第一条日期 ≤ 自身的位置,维持降序
}
// VRS 页脚日期:补 stampSrc/changedAt,否则页脚会显示「—」
m.rankings = m.rankings || {};
if (!m.rankings.stampSrc) { m.rankings.stampSrc = 'page'; m.rankings.changedAt = Date.UTC(2026, 8, 14); }

fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
console.log('transfers:', before, '->', m.transfers.length, '| rankings stamp:', new Date(m.rankings.changedAt).toISOString().slice(0, 10));
