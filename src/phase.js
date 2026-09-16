// 比赛阶段/标签推导(纯函数,浏览器与 node 单测共用)
// 信息范围:仅由 format(BO3/BO5)、series score、live2(当前图回合比分)可推导的内容,
// 不臆造无法得知的信息(如实时 CT/T 阵营归属)
(function (global) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s._\-']/g, '');

  /**
   * 系列赛信息
   * @returns {{n:number, need:number, a:number, b:number, decider:boolean, sp:boolean}}
   *  n: BOn(未知为 0);need: 夺冠所需图数;decider: 本图为决胜图;sp: 存在系列赛点
   */
  function seriesInfo(format, score) {
    const m = /bo\s*(\d)/i.exec(String(format || ''));
    const n = m ? +m[1] : 0;
    const need = n ? Math.ceil(n / 2) : 0;
    const a = Number(score && score[0]) || 0;
    const b = Number(score && score[1]) || 0;
    // BO1/BO2 上"决胜图/赛点"是废话,只对 BO3+ 生效
    const usable = n >= 3;
    const decider = usable && a === need - 1 && b === need - 1;
    const sp = usable && !decider && Math.max(a, b) === need - 1;
    return { n, need, a, b, decider, sp };
  }

  /** 半场归属:MR12 规则,12 回合为一半场;双方均 ≥12 即加时 */
  function halfLabel(ra, rb, lang) {
    const en = lang === 'en';
    if ((Number(ra) || 0) >= 12 && (Number(rb) || 0) >= 12) return en ? 'OT' : '加时';
    const R = (Number(ra) || 0) + (Number(rb) || 0) + 1;
    return R <= 12 ? (en ? '1st half' : '上半场') : (en ? '2nd half' : '下半场');
  }

  // 图点:再赢 1 回合就拿下当前图。CS2 MR12 两段规则:
  //   常规时先到 13 即胜 → x===12 且领先就是图点(12:12 平分不构成,只会进入加时);
  //   加时赢 2 领先即胜 → 加时里任何 1 回合领先都是图点(13:12 / 14:13 / 27:26 …)。
  // 两段统一为:x≥12 且 x>y(平分被 x>y 天然排除;按 MR12,不适用旧 MR15 赛制)
  function isMapPoint(x, y) {
    x = Number(x) || 0; y = Number(y) || 0;
    return x >= 12 && x > y;
  }

  // 决赛语境:Grand Final / 总决赛 / 决赛(半决赛不算)。命中时赛点/决胜图升级为冠军点
  const FINAL_RE = /grand\s*final|(?<!半)决[赛标]|总决[赛标]/i;
  function isFinalText(...parts) {
    return FINAL_RE.test(parts.filter(Boolean).join(' '));
  }

  /**
   * 阶段标签(按优先级,最多 3 个)
   * 系列赛点胶囊一枚:冠军点(决赛语境)> 决胜图 > 赛点,与图点同时发生以「·」并入同一枚
   * @returns {Array<[string, 'hot'|'warm']>}
   */
  function phaseTags(format, score, live2, isFinal, lang) {
    const en = lang === 'en';
    const L = { champ: en ? 'Championship point' : '冠军点', decider: en ? 'Decider' : '决胜图',
      sp: en ? 'Series point' : '赛点', mp: en ? 'Map point' : '图点', combo: en ? ' · map pt' : ' · 图点',
      ot: en ? `OT · period ` : '加时 第', otSec: en ? '' : '节',
      pistol: en ? 'Pistol round' : '手枪局', halfSoon: en ? 'Last round of half' : '即将中场' };
    const out = [];
    const si = seriesInfo(format, score);
    const point = isFinal && (si.decider || si.sp) ? L.champ : si.decider ? L.decider : si.sp ? L.sp : '';
    let mp = false;
    if (live2 && Number.isFinite(live2.ra) && Number.isFinite(live2.rb)) { // 回合分过期(ra/rb=null)时跳过图点判定,只留赛点/冠军点
      const ra = Number(live2.ra) || 0, rb = Number(live2.rb) || 0;
      mp = isMapPoint(ra, rb) || isMapPoint(rb, ra);
    }
    if (point && mp) out.push([point + L.combo, 'hot']);
    else if (point) out.push([point, 'hot']);
    else if (mp) out.push([L.mp, 'hot']);
    if (live2 && Number.isFinite(live2.ra) && Number.isFinite(live2.rb)) { // 同上:回合分缺失不派生加时/手枪局/中场标签
      const ra = Number(live2.ra) || 0, rb = Number(live2.rb) || 0;
      const R = ra + rb + 1;
      if (ra >= 12 && rb >= 12) {
        // 加时 MR3:每节 3 回合,节末换边;25 回合起为加时
        const sec = Math.floor((R - 25) / 6) + 1;
        out.push([en ? `${L.ot}${sec}` : `${L.ot}${sec}${L.otSec}`, 'hot']);
        if ((R - 25) % 3 === 0) out.push([L.pistol, 'warm']);
      } else {
        if (R === 1) out.push([L.pistol, 'warm']);
        if (R === 12) out.push([L.halfSoon, 'warm']); // MR12 上半场最后一回合
      }
    }
    return out.slice(0, 3);
  }

  // 季军赛豁免:锦标赛级决赛语境(PandaScore tournament 名)会同时罩住同阶段的季军赛,显式排除
  const THIRD_RE = /3rd[\s-]*place|third[\s-]*place|季军|铜牌/i;
  function isThirdPlace(stage) { return THIRD_RE.test(String(stage || '')); }
  const api = { seriesInfo, phaseTags, halfLabel, norm, isMapPoint, isFinalText, isThirdPlace };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PHASE = api;
})(typeof window !== 'undefined' ? window : globalThis);
