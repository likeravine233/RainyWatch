// ============ 主题动效注册表(插件式) ============
// 每个动效 = 一条注册项 + 一段 data-fx~="id" 门控的 CSS;全部只用 transform/opacity(合成器通道),
// 失焦暂停(data-unfocused *)、低功耗(data-lowpower=1)与 prefers-reduced-motion 三层兜底停用。
// 注册新动效:这里加一条 { id, themes, label },再在 style.css 的 fx 区块写对应 data-fx~="id" 的规则即可。
window.FX_REGISTRY = [
  { id: 'stripes', themes: ['crt', 'tactical'], label: 'fx.stripes' },            // 全局斜向条纹动效(缓慢斜向平移)
  { id: 'film', themes: ['versus'], label: 'fx.film' },                           // 底片动画:versus 主题的胶片带×刻字带动态背景
  { id: 'tac-sweep', themes: ['tactical'], label: 'fx.tacsweep' },                // 战术扫光(原 tac-sweep 纳入注册表)
  { id: 'crt-phosphor', themes: ['crt'], label: 'fx.crt' },                       // 磷光扫描线爬行
  { id: 'versus-aura', themes: ['versus'], label: 'fx.aura' },                    // 队色呼吸(悬停增强,交互)
  { id: 'versus-wave', themes: ['versus'], label: 'fx.wave' },                    // 对撞波:两颗 Siri 波从边缘照向中线(WebGL)
  { id: 'blue-sheen', themes: ['blue'], label: 'fx.sheen' },                      // 平台流光
  { id: 'clear-gloss', themes: ['clear'], label: 'fx.gloss' },                    // 玻璃高光(悬停)
  { id: 'poster-ink', themes: ['poster'], label: 'fx.ink' },                      // 油墨按压(纯交互,无循环)
  { id: 'print-ink', themes: ['printstream'], label: 'fx.printink' },             // 三色油墨(悬停,原滚边配色)
  { id: 'tilt', themes: ['crt', 'tactical', 'versus', 'blue', 'clear', 'poster', 'printstream'], label: 'fx.tilt' }, // 主卡 3D 倾斜(悬停跟随,全主题)
];
window.fxEnabledIds = () => {
  if (typeof SETTINGS !== 'undefined' && SETTINGS.lowPower) return []; // 性能模式:动效全退(悬停辉光这类注册项也在内)
  const off = (typeof SETTINGS !== 'undefined' && SETTINGS.fxOff) || [];
  const th = (typeof SETTINGS !== 'undefined' && SETTINGS.theme) || '';
  return window.FX_REGISTRY.filter((f) => f.themes.includes(th) && !off.includes(f.id)).map((f) => f.id);
};
window.fxApply = () => { document.body.dataset.fx = window.fxEnabledIds().join(' '); };

/* 主卡交互层:悬停时写入 --mx/--my(光标归一化位置,供流光跟随/浮团引流消费),
   tilt 开关开着则整卡带透视朝光标微倾(光标处下压)。
   只写 transform 与自定义属性(合成器通道),rAF 合帧,事件委托到 document(主卡会被周期性重绘);
   低功耗 / 系统减少动态 时不生效。 */
(() => {
  const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0, on = false, px = 0, py = 0;
  const paint = () => {
    raf = 0;
    const hero = document.getElementById('hero');
    if (!hero) return;
    if (!on) { hero.style.transform = ''; return; } // --mx/--my 冻结在离开前的值:蓝色流光原位淡出,不再瞬移回卡片中间
    const r = hero.getBoundingClientRect();
    const nx = Math.max(-1, Math.min(1, ((px - r.left) / Math.max(1, r.width)) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, ((py - r.top) / Math.max(1, r.height)) * 2 - 1));
    hero.style.setProperty('--mx', nx.toFixed(3));
    hero.style.setProperty('--my', ny.toFixed(3));
    hero.style.transform = (/\btilt\b/.test(document.body.dataset.fx || ''))
      ? `perspective(900px) rotateX(${(-ny * 4).toFixed(2)}deg) rotateY(${(nx * 5).toFixed(2)}deg)` : '';
  };
  const queued = () => { if (!raf) raf = requestAnimationFrame(paint); };
  const active = () => document.body.dataset.lowpower !== '1' && !rmq.matches;
  document.addEventListener('mousemove', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('#hero') : null;
    const want = !!(el && active());
    if (want) { px = e.clientX; py = e.clientY; }
    if (want !== on || on) queued();
    on = want;
  }, { passive: true });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget && on) { on = false; queued(); } });
})();

/* ============ 对撞波:versus 主题主卡氛围层(WebGL) ============
   两颗 Siri 波各自锚在卡片左右边缘、朝中线行进,包络在光带末端精确收零(中线留空给比分)。
   颜色取渲染器写入的 --tc-a/--tc-b;双侧时间轴按对阵名哈希错开(0~10s),避免过度对称。
   参数为 2026-09-13 调校器导出:reach .97 / band 1.0 / amp .59 / freq 1.2 / spd .2 / aber .41 / bright .8。
   画布 0.5 倍分辨率,亮度作预乘 alpha 合成(色相不随底色漂移);渲染器每次重绘主卡后调 FXW.sync()。 */
(() => {
  const VERTEX = 'attribute vec2 aPos; void main(){ gl_Position=vec4(aPos,0.0,1.0); }';
  const FRAG = `precision highp float;
uniform vec2 iResolution;
uniform float uTimeA; uniform float uTimeB;   // 各侧累积时间(hover 时该侧流速提升)
uniform float uGainA; uniform float uGainB;   // 各侧亮度增益(hover 平滑过渡)
uniform vec3 uColA; uniform vec3 uColB;
const float PI = 3.14159265359;
const float WAVE_SCALE = 0.6;
const float BAND_FILL = 30000.0, BAND_THICK = 0.08, SOFTNESS = 2.5;
const float LOW_AMP = 6.0, LOW_INT = 1.5, MID_ABER = 0.8, MID_ABAMP = 0.05, MID_SOFT = 0.4;
const float HIGH_ABER = 0.5, HIGH_ABAMP = 0.06;
const float REACH = 0.97, BAND_H = 1.0, BAND_Y = 0.0, AMP = 0.59, FREQ = 1.2, SPD = 0.2, ABER = 0.41, BRIGHT = 0.8;
const float SCORE_RX = 1.1, SCORE_RY = 0.42, SCORE_DIM = 0.8; // 大比分静区:数字附近波光平滑让位(半宽/半高/压暗量)

vec3 tint4(vec3 base, int s){ return base * (1.0 + 0.38*float(s)); }

vec3 waveHalf(vec2 p, float side, vec3 base, float aspect, float ts, float gain){
    float low  = clamp(0.45 + 0.45*sin(ts*0.8)*sin(ts*0.37+1.0), 0.0, 1.0);
    float mid  = clamp(0.40 + 0.40*sin(ts*1.7+2.0)*sin(ts*0.53), 0.0, 1.0);
    float high = clamp(0.30 + 0.30*sin(ts*2.9+4.0)*sin(ts*0.71+2.0), 0.0, 1.0);
    float drift = mod(ts * 2.4 * SPD * side, 20.0*PI); // 对最终相位取模:回绕恰为 10 个完整正弦周期,无缝循环(先乘后取模不会跳变)
    float xN = p.x * WAVE_SCALE / aspect * side;                // 方向化:本侧为正(0=中线,1=本侧外缘),对侧恒负
    float xE = max(xN, 0.0);                                    // 波只存在于本方半场:阵营单色,不再两侧叠色
    float tE = clamp((xE - (1.0 - REACH)) / REACH, 0.0, 1.0);   // 光带只占外缘 REACH 段
    float env = sin(PI*0.5*tE); env *= env;
    float A1 = AMP + 0.01*low*LOW_AMP;
    float A2 = A1 + mid*MID_ABAMP + high*HIGH_ABAMP;
    float AB = (2.6*ABER + mid*MID_ABER + high*HIGH_ABER);
    float th = 0.03;
    float inten = 0.01*(2.0 + low*LOW_INT) * BRIGHT * gain; // hover 侧亮度增益
    float soft = 0.01*max(0.0, SOFTNESS + mid*MID_SOFT);
    float yMain = A1*env*sin(p.x*FREQ + drift);
    float bandAmt = 1e-4*BAND_FILL*inten;
    vec3 num = vec3(0.0); float ksum = 0.0;
    for(int s=0; s<4; s++){
        float k = 1.0 + 0.38*float(s);   // 队色亮度阶梯
        float ab = mix(-AB, AB, float(s)/3.0);
        float yL = A2*env*sin(p.x*FREQ + drift + ab);
        float d = abs(p.y - yL);
        float line = inten/(sqrt(d*d+soft*soft)+th);
        float lo = min(yMain, yL), hi = max(yMain, yL);
        float dBand = max(0.0, max(p.y-hi, lo-p.y));
        num += base * k * (line + bandAmt/(dBand+BAND_THICK));
        ksum += k;
    }
    vec3 col = num / ksum; // 彩色发射:按系数和归一(按通道各自除会把队色除成纯白)
    float dM = abs(p.y - yMain);
    col += base * 0.5*inten/(sqrt(dM*dM+soft*soft)+th);
    col *= env;
    return pow(max(col, vec3(0.0)), vec3(1.5));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
    vec2 R = iResolution.xy;
    float aspect = R.x/R.y;
    vec2 p = (fragCoord+0.5)*2.0/R - 1.0;
    p.x *= aspect;
    float yScreen = p.y;
    p.y -= BAND_Y; // 波整体平移到点缀位(大比分下方):平移不衰减亮度,窄掩膜会把波拦腰砍暗
    p /= max(WAVE_SCALE, 0.1);
    vec3 col = waveHalf(p, -1.0, uColA, aspect, uTimeA, uGainA) + waveHalf(p, 1.0, uColB, aspect, uTimeB, uGainB);
    col *= exp(-pow((yScreen - BAND_Y)/BAND_H, 2.0)); // 宽高斯只软化上下边缘,不承担定位
    vec2 dS = vec2(p.x / SCORE_RX, yScreen / SCORE_RY);
    col *= 1.0 - SCORE_DIM * exp(-dot(dS, dS)); // 比分静区:层级在数字之下,这里让光晕主动让位保证可读
    col = clamp(col, 0.0, 1.0);
    float a = max(col.r, max(col.g, col.b));
    fragColor = vec4(col, a); // 预乘 alpha:色相严格等于队色。screen 加法混色会把橙叠成黄(底色自带队色渐变)
}
void main(){ mainImage(gl_FragColor, gl_FragCoord.xy); }`;

  const rmq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let canvas = null, gl = null, U = null, raf = 0, desync = 0, lastDesync = NaN, colA = [1, 1, 1], colB = [1, 1, 1];
  let tA = 0, tB = 0, lastNow = 0, gainA = 1, gainB = 1, tgtA = 1, tgtB = 1, heroRef = null; // 双侧时间轴与 hover 增益
  let waveFps = 30, lastDraw = 0; // wave 自身设计帧率(内部可调:FXW.setWaveFps;跳帧只省绘制,时间轴照常平滑)
  // 全局视觉帧率上限(设置 visualFps):0=不限制(动效按各自设计帧率跑);>0=所有动效的公共上限。
  // 与 wave 设计帧率取小——上限语义只降不升。每帧动态读 SETTINGS,设置改档即生效,无同步代码;
  // SETTINGS 由 renderer.js 维护(fx.js 先加载,读时判空)。与 lowPower 独立:lowPower=整体停用,visualFps=限制仍在跑的。
  const effFps = () => {
    const vf = typeof SETTINGS !== 'undefined' && SETTINGS ? Number(SETTINGS.visualFps) : 0;
    return Number.isFinite(vf) && vf > 0 ? Math.min(waveFps, vf) : waveFps;
  };
  // 失焦判定单一事实源 = body[data-unfocused](renderer 维护、与 CSS 失焦暂停同源):
  // 主窗 backgroundThrottling:false 使 document.hidden 恒 false,Chromium 内建节流失效,
  // 焦点信息只能走 push:focus 信号。frame 每帧自检该数据源(失焦即刻自停),恢复由 renderer
  // 的 onFocus 回调调 syncLoop() 拉起——fx 自身不维护焦点副本,无初始竞态。
  // 失焦停帧属于低功耗档行为(与 style.css 失焦暂停规则同门槛):特效全开档失焦不削减动效。
  const unfocusedNow = () => document.body.dataset.lowpower === '1' && document.body.dataset.unfocused === '1';

  // hover 侧向增益:鼠标靠近哪半边,那侧波微增亮+加速(离开平滑回落)
  const onMove = (e) => {
    if (!heroRef) return;
    const r = heroRef.getBoundingClientRect();
    const x = r.width ? (e.clientX - r.left) / r.width : 0.5; // 0=左缘 1=右缘
    tgtA = 1 + 0.35 * Math.max(0, 0.5 - x) * 2;
    tgtB = 1 + 0.35 * Math.max(0, x - 0.5) * 2;
  };
  const onLeave = () => { tgtA = 1; tgtB = 1; };
  const unbindHero = () => {
    if (!heroRef) return;
    heroRef.removeEventListener('mousemove', onMove);
    heroRef.removeEventListener('mouseleave', onLeave);
    heroRef = null; tgtA = 1; tgtB = 1;
  };

  const hex2rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '').trim()); return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255) : null; }; // 捕获组不含 #:下标从 0 起(错一位会把橙切成黄)
  const fnv = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const enabled = () => /\bversus-wave\b/.test(document.body.dataset.fx || '') && document.body.dataset.lowpower !== '1' && !rmq.matches;

  function boot() {
    canvas = document.createElement('canvas');
    canvas.className = 'wave-fx';
    gl = canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'high-performance' }); // 明确要硬 GPU:混显机器请求独显上下文,氛围光效不落省电核显
    if (!gl) { canvas = null; return; }
    try { const di = gl.getExtension('WEBGL_debug_renderer_info'); console.info('[fx] WebGL 渲染器:', di ? gl.getParameter(di.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)); } catch { /* 诊断用 */ } // 出现 SwiftShader/llvmpipe 字样 = 在走 CPU 软渲染
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    U = {};
    for (const n of ['iResolution', 'uTimeA', 'uTimeB', 'uGainA', 'uGainB', 'uColA', 'uColB']) U[n] = gl.getUniformLocation(program, n);
  }

  function frame(now) {
    raf = 0;
    if (!canvas || !canvas.parentNode || document.hidden || unfocusedNow() || !enabled()) return; // 停帧(失焦/隐藏/关效同路);渲染器或 onFocus 下次 sync 拉起
    const minDelta = 1000 / Math.max(1, effFps()); // 帧率上限:未到间隔不画也不推进时间轴,只续排单链(60fps 调度、effFps 绘制)
    if (now - lastDraw < minDelta - 0.4) { raf = requestAnimationFrame(frame); return; } // 0.4ms 容差:吸收刷新率与目标的整除抖动,同时保证高刷屏(360Hz)下任何档位实际绘制率不超上限
    lastDraw = now;
    const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016; // 挂起后恢复不做大步长跳变
    lastNow = now;
    gainA += (tgtA - gainA) * Math.min(1, dt * 7); gainB += (tgtB - gainB) * Math.min(1, dt * 7); // hover 增益平滑过渡
    tA += dt * (1 + 0.7 * (gainA - 1)); tB += dt * (1 + 0.7 * (gainB - 1)); // hover 侧流速也随之提升
    const w = Math.max(2, Math.round(canvas.clientWidth * 0.5)), h = Math.max(2, Math.round(canvas.clientHeight * 0.5));
    if (w !== canvas.width || h !== canvas.height) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
    gl.uniform2f(U.iResolution, w, h);
    gl.uniform1f(U.uTimeA, tA); gl.uniform1f(U.uTimeB, tB);
    gl.uniform1f(U.uGainA, gainA); gl.uniform1f(U.uGainB, gainB);
    gl.uniform3f(U.uColA, colA[0], colA[1], colA[2]);
    gl.uniform3f(U.uColB, colB[0], colB[1], colB[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  }

  // RAF 调度唯一入口:should 判定与 raf handle 一起做状态机,幂等——focus/blur 任意次切换、
  // sync 任意次重入,都只可能维持 0 或 1 条调度链,不会叠加
  function syncLoop() {
    const should = !!(canvas && canvas.parentNode && !document.hidden && !unfocusedNow() && enabled());
    if (should && !raf) raf = requestAnimationFrame(frame);
    else if (!should && raf) { cancelAnimationFrame(raf); raf = 0; } // 显式摘除挂起的帧,不留半条链
  }

  // 渲染器每次重绘主卡后调用:按当前 fx 开关/主题挂载或摘除,顺带刷新队色与错相种子
  function sync() {
    const hero = document.getElementById('hero');
    const live = hero && hero.querySelector('.team-a-block') && enabled();
    if (!live) {
      if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      unbindHero();
      return;
    }
    colA = hex2rgb(hero.style.getPropertyValue('--tc-a')) || colA;
    colB = hex2rgb(hero.style.getPropertyValue('--tc-b')) || colB;
    const na = hero.querySelector('.team-a-block .tname-txt'), nb = hero.querySelector('.team-b-block .tname-txt');
    desync = (fnv(((na && na.textContent) || '') + '|' + ((nb && nb.textContent) || '')) % 97) / 9.7; // 0~10s 时间轴错开
    if (desync !== lastDesync) { tA = 0; tB = desync; lastDesync = desync; } // 换对阵:重置双侧时间轴(右波带错相起点)
    if (!canvas) boot();
    if (!canvas) return;
    if (canvas.parentNode !== hero) hero.appendChild(canvas);
    if (heroRef !== hero) { // hover 监听随挂载绑到当前 hero 上
      unbindHero();
      heroRef = hero;
      hero.addEventListener('mousemove', onMove);
      hero.addEventListener('mouseleave', onLeave);
    }
    syncLoop();
  }
  window.FXW = {
    sync,
    syncLoop,
    setWaveFps: (v) => { const n = Math.round(Number(v)); if (n >= 1 && n <= 240) waveFps = n; }, // 运行时可调,frame 下一绘制帧即生效
    getWaveFps: () => effFps(), // 生效帧率(设计帧率与全局上限取小)
  };
})();
