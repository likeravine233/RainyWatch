// 占位场(TBD)判定的确定性单元测试:不需要网络,直接喂合成 LP 卡片给 parseMatches
const { parseMatches } = require('../lib/parser');

const now = Date.now();
const card = (aName, bName, tsOffsetMin) => `
<div class="match-info">
  <div class="match-info-header">
    <div class="match-info-header-opponent"><span class="name"><a href="/counterstrike/paiN">${aName}</a></span></div>
    <div class="match-info-header-scoreholder"><span class="score">0</span><span class="score">0</span></div>
    <div class="match-info-header-opponent"><span class="name"><a href="">${bName}</a></span></div>
  </div>
  <div class="match-info-tournament"><a href="/counterstrike/Circuit_X_Curitiba/3">Circuit X Curitiba #3</a></div>
  <span class="timer-object" data-timestamp="${Math.floor((now + tsOffsetMin * 60e3) / 1000)}"></span>
</div>`;

const html =
  card('paiN', '', -60) +      // 空对手名,开赛 1h 前 → live + pending,且永不转赛果
  card('paiN', 'TBD', -120) +  // 字面 TBD,开赛 2h 前 → live + pending
  card('paiN', 'MIBR', -7 * 60) + // 双方实名,开赛 7h 前,无 winner → 6h 兜底转 finished
  card('paiN', 'FURIA', 30);   // 双方实名,30 分钟后开赛 → upcoming

const { live, upcoming, recent } = parseMatches(html);
const all = [...live, ...upcoming, ...recent];
const find = (bName) => all.find((m) => m.teamB.name === bName && m.teamA.name === 'paiN');
const a = find(''), b = find('TBD'), c = find('MIBR');
const d = upcoming[upcoming.length - 1];
const ok = (cond, label) => { console.log(cond ? 'PASS' : 'FAIL', label); if (!cond) process.exitCode = 1; };
ok(a && a.status === 'live' && a.pending === true, 'empty-opponent: live + pending');
ok(b && b.status === 'live' && b.pending === true, 'TBD-opponent: live + pending');
ok(c && c.status === 'finished' && c.pending === undefined, 'real-teams 7h: finished (6h guard intact)');
ok(d && d.status === 'upcoming' && d.pending === undefined, 'real-teams future: upcoming, no pending key');
console.log('pending key absent on normal matches:', JSON.stringify(d.pending), JSON.stringify(c.pending));
