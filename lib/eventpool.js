// 赛事池:同一赛事在不同供数方叫法不同(Panda "StarLadder StarSeries" ↔ LP "SL StarSeries Fall 2026"),
// Panda 补位/兜底行因此丢 LP 赛事名,评级徽章也断(评级走 tierOf(eventHref),没有 LP 页链就查不到级别)。
// 学习式别名:Panda 行与 LP 行判为同场(lib/live.isSameMatch)时,记「Panda 赛事名 → LP 赛事名/页链/图标」;
// Panda 系行出场前反查池子换上 LP 规范身份。池子由 main.js 持久化(store('eventPool')),
// 本模块只做纯计算(传入传出 pool 对象),便于沙盘测试
const { isSameMatch } = require('./live');

// 赛事名归一:小写去符号。与队名归一(norm)分开——赛事名里的 StarLadder/SL 等词不做语义剥除
const evKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// 一次学习:遍历 Panda 三区行,与 LP 现表同场配对;配对成功且 LP 行带赛事页链的记入 pool。
// LP 行信息永远更规范:名字带赛季、href 挂评级链、icon 是 LP 图标。返回池子是否变化(供写盘闸门)
function learnEvents(pandaList, lpMatches, pool) {
  let changed = false;
  const lpRows = [...(lpMatches?.live || []), ...(lpMatches?.upcoming || []), ...(lpMatches?.recent || [])]
    .filter((m) => m.eventHref);
  const pandaRows = [...(pandaList?.live || []), ...(pandaList?.upcoming || []), ...(pandaList?.recent || [])];
  for (const p of pandaRows) {
    if (!p.event) continue;
    const lp = lpRows.find((m) => isSameMatch(m, p));
    if (!lp) continue;
    const key = evKey(p.event);
    if (!key || pool[key]) continue; // 一键一映射,首配为准:同一 Panda 名若反复配到不同 LP 赛事,保持首条稳定,不做来回覆盖(否则写盘闸门永闭不上)
    pool[key] = { name: lp.event || p.event, href: lp.eventHref, icon: lp.eventIcon || '', at: Date.now() };
    changed = true;
  }
  return changed;
}

// 反查:Panda 赛事名的规范 LP 身份;无记录返回 null(行保持原样,不丢 Panda 侧信息)
function lookupEvent(name, pool) {
  return (pool && pool[evKey(name)]) || null;
}

module.exports = { evKey, learnEvents, lookupEvent };
