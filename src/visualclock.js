// 全局视觉时钟(visualFps 的执行者,作用域=整窗所有 Web 动效)。
// 原理(360Hz 实测):页面里的一切 Animation 对象——无限循环 CSS 动画、一次性动画、
// hover/交互产生的 CSS transition——全部 pause() 接管:compositor 没有 active 动画可逐
// vsync tick,合成帧率才真正随上限下降;时钟按目标帧率用真实 dt 推进 currentTime,
// 动画速度不变、视觉更新率=时钟频率,动画/过渡定义零重写。有限动效推进到终点即钳停
// 保持(paused-at-end):视觉终态与原生一致,但不放行走完——实测被接管过的有限动画
// 走完后 Chromium 会移除它,而 CSS animation-name 仍匹配会立刻重建,形成重启永循环
// (persist() 也挡不住);应用层无 animationend/transitionend 依赖,无副作用。
// 代执行原则(关键实测结论):CSS 动画一旦被脚本 pause()/play() 过,引擎就不再跟随
// 之后 CSS animation-play-state 的翻转(实测:计算样式已 paused、对象照跑)——所以
// 「交还给 CSS」不可行,时钟必须永久代为执行 CSS 的意愿:计算样式要定格(cssPaused)
// 的就地 API 暂停、不推进;要动的恢复原生或收编推进。开关翻转因此在一个节拍内生效。
// cssPaused 判定读目标元素的计算样式 animation-play-state(强制样式重算,永远新鲜),
// 不能读 Animation.playState——dataset 刚翻转后的同一任务里它是旧值。CSS transition 不受
// animation-play-state 管辖,恒可接管(详见 cssPaused 处注释)。
// 帧率模型:visualFps=硬上限,任何状态下都不会超过;灵活模式(flexMode)只改「光标离开
// 窗口时跑多少」——在窗口上跑上限(visualFps=0 即原生满帧),离开回落保底帧率(idleFps,
// 最低 15,实际不高于上限);关闭灵活模式则恒为上限。上限是「最多」,保底是「至少」,
// 二者不冲突。
// 光标判定读根元素的 :hover(documentElement,引擎在指针事件与 DOM 变更后都会重算,覆盖
// 界面任意位置);不用事件跟踪——固定光标下的周期性重绘会派发零散 mouseout(null)/补发
// mousemove,事件法会误判出入。出窗缓释:收回过渡多半正是被「光标离开→:hover 链清除」
// 触发的,若照常收编,playState 变 paused 后 draining() 立即失明(它只认 running),任何
// 「先收编、再把时钟速率抬高一点」的方案都只活一个节拍,收回动画会 100% 以保底帧率播完
// (v2.6 实测)。正确语义:出窗瞬间把已收编且在飞的过渡归还原生,缓释期内(跑完前,上限
// 1200ms 兜底)收编循环跳过过渡——它们按原生速率走完自然退役;常驻循环动画则立即降到保底
// 帧率。只赦免过渡不赦免一次性动画:后者被脚本碰过后原生走完会触发移除+重建永循环(见上),
// 且没有「出窗触发」的真实场景。visualFps=0+灵活模式下「在窗口上」是唯一的熄灭态(原生
// 满帧),由轻量 interval 探测出窗拉回保底帧率。失焦冻结(lowPower+失焦,与 style.css 同
// 门槛)时停推进即冻结,恢复由 renderer 的 onFocus 拉起。WebGL 波形不归本时钟,走 fx.js 帧闸。
(() => {
  let raf = 0, lastAdv = 0, poll = 0, outSince = 0, outAt = 0; // poll=熄灭态出窗探测;outSince/outAt=缓释计时
  // 光标是否在窗口内:引擎计算的根元素 hover(界面任意位置都算,含面板/空隙)。
  const cursorIn = () => { const h = document.documentElement; return !!(h && h.matches(':hover')); };
  const flexOn = () => typeof SETTINGS !== 'undefined' && !!SETTINGS.flexMode;
  const settings = () => (typeof SETTINGS !== 'undefined' && SETTINGS) ? SETTINGS : null;
  const capFps = () => { // 硬上限;0=不限制
    const s = settings();
    if (!s) return 0;
    const vf = Number(s.visualFps);
    return Number.isFinite(vf) && vf > 0 ? vf : 0;
  };
  const idleFps = () => Math.max(15, Number(settings() && settings().idleFps) || 15); // 保底,最低 15
  const targetFps = () => {
    const cap = capFps();
    if (!flexOn()) return cap;              // 灵活关:恒为上限(0=原生)
    if (cursorIn()) return cap;             // 光标在窗口上:上限(0=原生满帧)
    const idle = idleFps();                 // 光标离开:保底
    return cap > 0 ? Math.min(cap, idle) : idle;
  };
  // 冻结门槛与 fx.js 同款:性能优先+失焦时整体停推进(已接管的保持接管,不归还)
  const frozen = () => document.body.dataset.lowpower === '1' && document.body.dataset.unfocused === '1';

  // CSS 侧定格判定(权威且即时):同名对位读计算样式的 animation-play-state。
  // 无 animationName 的对象(CSS transition)不受 animation-play-state 规则管辖,CSS 从不
  // 定格它们——必须恒返回 false:不能拿 playState 兜底,收编本身就是 pause(),那会让推进
  // 循环在下一节拍把所有过渡误判成「CSS 要定格」就地冻结(hover 弹出/tooltip/toggle 全卡死)。
  const cssPaused = (a) => {
    try {
      if (!a.animationName) return false;
      const el = a.effect && a.effect.target;
      if (!el) return false;
      const cs = getComputedStyle(el);
      if (!cs.animationPlayState.includes('paused')) return false;
      const states = cs.animationPlayState.split(',').map((s) => s.trim());
      const i = cs.animationName.split(',').map((s) => s.trim()).indexOf(a.animationName);
      if (i < 0) return false;
      return (states[i] || states[0]) === 'paused';
    } catch { return false; }
  };

  // 有限动画的终点;null=无限/无终点,undefined=对象已失效不可操作
  const endTimeOf = (a) => {
    try {
      if (a.effect.getTiming().iterations === Infinity) return null;
      const et = a.effect.getComputedTiming().endTime;
      return et === Infinity ? null : et;
    } catch { return undefined; }
  };
  // 是否有在飞的有限动效(收尾过渡等)——降频/回落前的缓释判据
  const draining = () => document.getAnimations().some((a) => a.playState === 'running' && endTimeOf(a) != null);

  // 出窗探测(仅熄灭态:灵活+不限制+在窗口上):等收尾动效跑完再拉回保底帧率
  const pollTick = () => {
    if (cursorIn()) { outSince = 0; return; }
    const now = performance.now();
    if (!outSince) { outSince = now; return; }
    if (!draining() || now - outSince > 1200) { clearInterval(poll); poll = 0; outSince = 0; sync(false); }
  };

  function releaseAll() { // 归还:逐个按 CSS 当前意愿代执行——要定格的就地 API 暂停,要动的 play 归还原生
    for (const a of document.getAnimations()) {
      a.__vc = false;
      if (a.playState === 'idle' || a.playState === 'finished') continue; // 原生已走完/已取消:不碰
      try {
        if (cssPaused(a)) { if (a.playState !== 'paused') a.pause(); continue; }
        const et = endTimeOf(a);
        if (et != null && a.currentTime != null && a.currentTime >= et) continue; // 钳停在终点的不复活(复活=重建永循环)
        a.play();
      } catch { /* 动画对象已随 DOM 重建失效 */ }
    }
  }

  function resync() { // 归还再重收编(同一任务内,无渲染帧插入):设置/CSS 状态翻转即时生效
    releaseAll();
    for (const a of document.getAnimations()) {
      if (a.__vc || a.playState === 'idle' || a.playState === 'finished') continue;
      try {
        if (cssPaused(a)) { if (a.playState !== 'paused') a.pause(); continue; } // CSS 定格:代执行,不收编
        a.pause(); a.__vc = true;
      } catch { /* 系统级不可接管对象 */ }
    }
  }

  function frame(now) {
    raf = 0;
    const fps = targetFps();
    if (!fps || frozen()) { if (!fps) releaseAll(); return; } // 熄灭态:归还并自熄;失焦冻结:保持接管直接停,恢复时 sync 拉起
    // 出窗缓释(语义见文件头):出窗沿归还在飞过渡,缓释期内收编循环跳过过渡;循环动画立即按保底帧率推进
    let grace = false;
    if (flexOn() && !cursorIn()) {
      if (!outAt) {
        outAt = now;
        for (const a of document.getAnimations()) { // 已收编的在飞过渡归还原生——注意判据不是
          if (!a.__vc || a.animationName) continue; // playState==='running'(收编即 pause,在飞的也是 paused),而是「未到终点」
          const et = endTimeOf(a);
          try { if (et != null && a.currentTime != null && a.currentTime < et) { a.play(); a.__vc = false; } } catch { /* 已随 DOM 失效 */ }
        }
      }
      grace = draining() && now - outAt <= 1200;
    } else outAt = 0;
    if (now - lastAdv >= 1000 / fps - 0.4) { // 与 fx.js 同款容差:高刷屏下任何档位实际推进率不超上限
      const dt = lastAdv ? Math.min(250, now - lastAdv) : 0; // ms(currentTime 是毫秒轴);挂起恢复不做大步长跳变
      lastAdv = now;
      const list = document.getAnimations();
      for (const a of list) { // 收编(CSS 侧定格的代执行暂停、不收编;idle=已取消;finished=原生已走完)
        if (a.__vc || a.playState === 'idle' || a.playState === 'finished') continue;
        if (grace && !a.animationName) continue; // 缓释期:在飞过渡保持原生跑完,不收编
        try {
          if (cssPaused(a)) { if (a.playState !== 'paused') a.pause(); continue; }
          a.pause(); a.__vc = true;
        } catch { /* 同上 */ }
      }
      for (const a of list) {
        if (!a.__vc) continue;
        if (cssPaused(a)) { a.__vc = false; try { if (a.playState !== 'paused') a.pause(); } catch { /* 已失效 */ } continue; } // CSS 刚改为定格:就地停,交还 CSS 意愿
        const et = endTimeOf(a);
        if (et === undefined) { a.__vc = false; continue; }
        if (et != null && a.currentTime + dt >= et) {
          try { a.currentTime = et; } catch { a.__vc = false; } // 走到头即钳停保持(理由见文件头)
          continue;
        }
        try { a.currentTime += dt; } catch { a.__vc = false; }
      }
    }
    raf = requestAnimationFrame(frame);
  }

  function sync(force) { // force=设置/CSS 状态可能翻转(renderer 的设置链/焦点链);否则只做启停
    if (targetFps() > 0 && !frozen()) {
      const was = !!raf;
      if (!raf) { lastAdv = 0; raf = requestAnimationFrame(frame); }
      if (force || !was) resync();
      if (poll) { clearInterval(poll); poll = 0; } // 时钟在跑:出入窗由 frame 逐帧查 cursorIn 处理
    } else {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (flexOn() && capFps() === 0) { // 唯一熄灭态:灵活+不限制+在窗口上(原生满帧交互)
        if (!poll) { poll = setInterval(pollTick, 120); outSince = 0; }
      } else if (poll) { clearInterval(poll); poll = 0; }
      if (targetFps() === 0) releaseAll(); // 0 档也要代执行 CSS 意愿:vf=0 下切换动效开关仍需即时定格/恢复
    }
  }

  window.VC = { sync: () => sync(true) };
  sync(true); // 首次加载:设置未到时按 0 处理(不接管);首个设置推送经 renderer 的 VC.sync 拉起
  addEventListener('DOMContentLoaded', () => sync(true));
  addEventListener('load', () => sync(true));
})();
