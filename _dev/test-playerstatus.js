// 选手页 Status 行解析 + 队伍页 roster 分区(下放判据)测试:node _dev/test-playerstatus.js(仿 test-supplement 先例,零网络,合成 HTML)
const { parsePlayerTeam, parseTeamRoster } = require('../lib/parser');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) pass++; else { fail++; console.error('  ✗', name); } };

// LP 选手页 infobox 行结构:label 单元(infobox-description)紧跟值单元(同一父容器内相邻兄弟)
const box = (rows) => `<html><body><div class="fo-nttax-infobox-wrapper"><div class="fo-nttax-infobox">${rows}</div></div></body></html>`;
const teamRow = (team, href) => `<div class="infobox-cell-2 infobox-description">Team:</div><div class="infobox-cell-2">${href ? `<a href="${href}">${team}</a>` : ''}</div>`;
const statusRow = (s) => `<div class="infobox-cell-2 infobox-description">Status:</div><div class="infobox-cell-2">${s}</div>`;

// 1) 核心:下放不离队——Team 仍写 NRG,Status 已是 Inactive
{
  const r = parsePlayerTeam(box(teamRow('NRG', '/counterstrike/NRG') + statusRow('Inactive')));
  ok(r && r.name === 'NRG' && r.href === 'https://liquipedia.net/counterstrike/NRG', 'Team 行解析不变(名/链接)');
  ok(r && r.status === 'inactive', 'Status: Inactive → inactive(被下放不离队的可见信号)');
}
// 2) 常规活跃
{
  const r = parsePlayerTeam(box(teamRow('Natus Vincere', '/counterstrike/Natus_Vincere') + statusRow('Active')));
  ok(r && r.status === 'active', 'Status: Active → active');
}
// 3) 退役(含 Semi-Retired 变体)
{
  ok(parsePlayerTeam(box(teamRow('', '') + statusRow('Retired'))).status === 'retired', 'Status: Retired → retired');
  ok(parsePlayerTeam(box(teamRow('', '') + statusRow('Semi-Retired'))).status === 'retired', 'Status: Semi-Retired → retired');
}
// 4) 无 Status 行:status 返回 ''(未知,按活跃对待,行为与旧版一致)
{
  const r = parsePlayerTeam(box(teamRow('FaZe Clan', '/counterstrike/FaZe_Clan')));
  ok(r && r.status === '' && r.name === 'FaZe Clan', '无 Status 行 → status 空串,Team 照常');
}
// 5) 队伍行缺席但 Status 在(自由球员/退役无队):不再因无队返回 null,状态照出
{
  const r = parsePlayerTeam(box(statusRow('Retired')));
  ok(r && r.name === '' && r.status === 'retired', '无 Team 行有 Status → 名空但状态可解析');
}
// 6) Team/Status 都没认出来(结构对不上)→ null,维持旧约定
{
  ok(parsePlayerTeam(box('<div class="infobox-cell-2 infobox-description">Born:</div><div class="infobox-cell-2">1999</div>')) === null, '两行皆缺 → null');
  ok(parsePlayerTeam('<html><body>没有 infobox</body></html>') === null, '无 infobox → null');
}
// 7) 归一顺序陷阱:值文本含 "active" 子串的不活跃写法不得误判为活跃
{
  ok(parsePlayerTeam(box(statusRow('<span class="ico">Inactivate</span>'))).status === 'inactive', 'Inactive 词内含 active 子串不误判');
}

// ---------- 8) 队伍页 roster 分区 + 角色(下放判据 / Coach / Sub) ----------
const rosterPage = (body) => `<html><body><div class="mw-parser-output">${body}</div></body></html>`;
const sec = (title, rows) => `<h3><span class="mw-headline" id="${title}">${title}</span></h3><table class="roster-table"><tr><th colspan="3">ID</th></tr>${rows}</table>`;
const prow = (slug, extra = '') => `<tr><td><a href="/counterstrike/${slug}" title="${slug}">${slug}</a></td><td>Real Name</td>${extra}<td>2026-01-01</td></tr>`;
{
  const page = rosterPage(sec('Active', prow('nitr0') + prow('daps', '<td>Coach</td>') + prow('OSee')) + sec('Inactive', prow('br0')) + sec('Former', prow('HexT')));
  const p1 = parseTeamRoster(page, 'OSee');
  ok(p1 && p1.zone === 'active' && p1.role === '', 'roster: Active 分区 → active/无角色');
  const p2 = parseTeamRoster(page, 'daps');
  ok(p2 && p2.zone === 'active' && p2.role === 'coach', 'roster: 角色列 Coach → active/coach');
  const p3 = parseTeamRoster(page, 'br0');
  ok(p3 && p3.zone === 'inactive' && p3.role === '', 'roster: Inactive 分区 → inactive(下放)');
  const p4 = parseTeamRoster(page, 'HexT');
  ok(p4 && p4.zone === 'former', 'roster: Former 分区 → former(离队)');
  ok(parseTeamRoster(page, 'EliGE') === null, 'roster: 不在任何名单 → null');
}
// 9) 教练单列一表(分区标题 Coach/Staff)
{
  const page = rosterPage(sec('Active', prow('nitr0')) + sec('Coaching Staff', prow('Allu', '<td>Head Coach</td>')));
  const c = parseTeamRoster(page, 'Allu');
  ok(c && c.zone === 'coach' && c.role === 'coach', 'roster: 教练分区标题 → coach/coach');
}
// 10) Substitute 角色列
{
  const page = rosterPage(sec('Active', prow('Sub6', '<td>Substitute</td>')));
  ok(parseTeamRoster(page, 'Sub6').role === 'sub', 'roster: Substitute 角色列 → sub');
}
// 11) 表格被页签/容器 div 包裹:逐级向上仍能找到分区标题
{
  const page = rosterPage('<h3><span class="mw-headline">Active</span></h3><div class="fo-tab"><div class="tab-inner"><table class="roster-table"><tr><th>ID</th></tr>' + prow('OSee') + '</table></div></div>');
  ok(parseTeamRoster(page, 'OSee')?.zone === 'active', 'roster: 容器包裹下向上找标题');
}
// 12) 无分区标题:退表头行文字
{
  const page = rosterPage('<table class="roster-table"><tr><th colspan="4">Inactive Players</th></tr>' + prow('OSee') + '</table>');
  ok(parseTeamRoster(page, 'OSee')?.zone === 'inactive', 'roster: 无标题退表头行(Inactive Players)');
}
// 13) 新版 MediaWiki 标题包裹(div.mw-heading > h3)
{
  const page = rosterPage('<div class="mw-heading mw-heading3"><h3 id="Inactive">Inactive</h3></div><table class="roster-table">' + prow('OSee') + '</table>');
  ok(parseTeamRoster(page, 'OSee')?.zone === 'inactive', 'roster: div.mw-heading 包裹的标题可识别');
}
// 14) 无 roster-table class:第二通道扫全部表格(信息框排除)
{
  const page = rosterPage('<div class="fo-nttax-infobox"><table><tr><td><a href="/counterstrike/OSee">OSee</a></td></tr></table></div>'
    + '<div class="mw-heading mw-heading3"><h3>Active</h3></div><table>' + prow('OSee') + '</table>');
  ok(parseTeamRoster(page, 'OSee')?.zone === 'active', 'roster: 无 class 表格可扫,信息框被排除');
}
// 15) 选手页履历兜底(Team 行缺失,allu 教练场景):未闭合区间 = 现队;全闭区间不误认旧队
{
  const hist = (range, team, s) => `<div class="infobox-cell-2">${range}<a href="/counterstrike/${s}">${team}</a></div>`;
  const r1 = parsePlayerTeam(box(statusRow('Active') + hist('2018-02-07 — 2018-03-12', 'OpTic Gaming', 'OpTic_Gaming') + hist('2026-06 — Present', 'ENCE', 'ENCE')));
  ok(r1 && r1.name === 'ENCE' && r1.href.endsWith('/counterstrike/ENCE') && r1.status === 'active', '无 Team 行:履历未闭合区间兜底取现队');
  const r2 = parsePlayerTeam(box(statusRow('Active') + hist('2018-02-07 — 2018-03-12', 'OpTic Gaming', 'OpTic_Gaming') + hist('2021-05-12 — 2022-08-03', 'ENCE', 'ENCE')));
  ok(r2 && r2.name === '', '履历全闭区间 → 不误认旧队为现队');
}
// 16) 多分区命中取 DOM 序第一个(CS2 默认页签在前)、Reserve 语义、空页安全
{
  ok(parseTeamRoster(rosterPage(sec('Active', prow('OSee')) + sec('Former', prow('OSee'))), 'OSee').zone === 'active', 'roster: 多分区命中取 DOM 序第一个');
  ok(parseTeamRoster(rosterPage(sec('Reserve', prow('OSee'))), 'OSee').zone === 'inactive', 'roster: Reserve 分区 → inactive');
  ok(parseTeamRoster('', 'OSee') === null && parseTeamRoster('<table class="roster-table"></table>', 'OSee') === null, 'roster: 空页/无命中名单表 → null');
}
// 17) 履历独立成第二个 infobox 模块(allu 页结构):兜底扫描跨模块生效
{
  const two = `<html><body>
    <div class="fo-nttax-infobox-wrapper"><div class="fo-nttax-infobox"><div class="infobox-cell-2 infobox-description">Status:</div><div class="infobox-cell-2">Active</div></div></div>
    <div class="fo-nttax-infobox-wrapper"><div class="fo-nttax-infobox">
      <div class="infobox-cell-2">2018-02-07 — 2018-03-12<a href="/counterstrike/OpTic_Gaming">OpTic Gaming</a></div>
      <div class="infobox-cell-2">2026-06 — Present<a href="/counterstrike/ENCE">ENCE</a></div>
    </div></div></body></html>`;
  const r = parsePlayerTeam(two);
  ok(r && r.name === 'ENCE' && r.status === 'active', '履历在第二个 infobox 模块:兜底跨模块生效');
}

console.log(`player-status: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
