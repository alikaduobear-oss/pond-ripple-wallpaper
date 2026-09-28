/**
 * 内置壁纸：WebGL 清澈水面涟漪（只保留鼠标交互）
 *
 * 算法参考 Evan Wallace — WebGL Water：
 *   · 高度场水波模拟（2D 波动方程，GPU ping-pong）
 *   · 焦散（caustic）/ 天空反射 / 波峰高光
 *   · 透明窗口：premultipliedAlpha + blendFunc(ONE, ONE_MINUS_SRC_ALPHA)
 *
 * 平静时水面 alpha = 0（完全透明，桌面原样可见），只有涟漪经过的地方才画出来。
 *
 * 暴露 window.initWater(canvas) → { setPointer, clickAt, pause, resume, stop }
 */
window.initWater = function (canvas) {
  if (!canvas) return null;
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
  if (!gl) { console.error('[Water] WebGL2 不可用'); return null; }
  if (!gl.getExtension('EXT_color_buffer_float')) { console.error('[Water] 需要 EXT_color_buffer_float'); return null; }

  // ========== 可调参数（想改手感就改这里） ==========
  const HEIGHT_SIZE = 256;             // 高度场分辨率（越大越细腻、越吃性能）
  const WAVE_HEIGHT = 0.014;           // 波高缩放（调小 → 波动更柔和）
  const CAUSTIC_STRENGTH = 0.5;        // 焦散强度（调小 → 不闪眼）
  const WATER_TINT = [0.25, 0.72, 0.69];
  const DAMPING = 0.975;               // 阻尼（越小衰减越快 → 涟漪只停留在鼠标附近）
  const TRAIL_STEP = 4;                // 光标移动超过该像素距离才落一滴（尾迹密度）
  const TRAIL_STRENGTH = 0.45;         // 尾迹强度（调小 → 划过的痕迹更淡）
  const RIPPLE = {
    waves: 3,                          // 每次点击向外扩散的圈数
    waveGap: 0.42,                     // 相邻两圈的时间间隔（秒）
    life: 1.5,                         // 单圈扩散持续时间（秒）
    speed: 0.22,                       // 扩散速度（UV / 秒）
    thick: 0.016,                      // 环的宽度
    amp: 4.0,                          // 强度系数（每帧注入，会乘以帧间隔）
    maxR: 8,                           // 同时存在的最大涟漪数，防止连点堆积
  };

  // ========== Shader 编译 ==========
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.error(gl.getProgramInfoLog(p)); return null; }
    return p;
  }

  const VS_FULLSCREEN = `#version 300 es
    out vec2 v_uv;
    void main() {
      vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      v_uv = p;
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;

  // 波动方程：h = (左右上下四邻之和) * 0.5 - 上一帧
  const FS_SIMULATE = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_texel;
    uniform float u_damping;
    void main() {
      float l = texture(u_tex, v_uv - vec2(u_texel.x, 0.0)).r;
      float r = texture(u_tex, v_uv + vec2(u_texel.x, 0.0)).r;
      float u = texture(u_tex, v_uv - vec2(0.0, u_texel.y)).r;
      float d = texture(u_tex, v_uv + vec2(0.0, u_texel.y)).r;
      vec4 c = texture(u_tex, v_uv);
      float h = (l + r + u + d) * 0.5 - c.g;
      h *= u_damping;
      fragColor = vec4(h, c.r, 0.0, 1.0);
    }`;

  // 注水：以 u_center 为圆心、u_ring 为半径画一圈（u_ring=0 即为一个点状水珠）
  const FS_DROP = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_tex;
    uniform vec2 u_center;
    uniform float u_radius;
    uniform float u_ring;
    uniform float u_strength;
    void main() {
      vec4 c = texture(u_tex, v_uv);
      float dist = distance(v_uv, u_center);
      float d = dist - u_ring;
      float drop = exp(-d * d / (u_radius * u_radius)) * u_strength;
      fragColor = vec4(c.r + drop, c.g, 0.0, 1.0);
    }`;

  // 渲染：法线 → 折射 / 反射 / 焦散 / 高光；alpha 由「波形剧烈程度」决定 → 平静处完全透明
  const FS_RENDER = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_height;
    uniform vec2 u_heightTexel;
    uniform float u_waveHeight;
    uniform float u_caustic;
    uniform vec3 u_waterTint;
    uniform vec3 u_lightDir;
    uniform vec2 u_resolution;
    uniform float u_time;
    void main() {
      vec2 uv = v_uv;
      float h  = texture(u_height, uv).r;
      float hL = texture(u_height, uv - vec2(u_heightTexel.x, 0.0)).r;
      float hR = texture(u_height, uv + vec2(u_heightTexel.x, 0.0)).r;
      float hU = texture(u_height, uv - vec2(0.0, u_heightTexel.y)).r;
      float hD = texture(u_height, uv + vec2(0.0, u_heightTexel.y)).r;
      float s = u_waveHeight;
      vec3 normal = normalize(vec3((hL - hR) * s, 1.0, (hU - hD) * s));
      vec3 surfPos = vec3(uv.x - 0.5, 0.0, uv.y - 0.5);
      vec3 camPos = vec3(0.0, 2.2, 0.7);
      vec3 viewDir = normalize(camPos - surfPos);
      vec3 floorColor = u_waterTint * 0.55;
      vec3 reflectDir = reflect(-viewDir, normal);
      float skyT = clamp(reflectDir.y * 0.5 + 0.5, 0.0, 1.0);
      vec3 skyTop = vec3(0.6, 0.78, 0.92);
      vec3 skyBottom = vec3(0.95, 0.98, 1.0);
      float cloud = sin(reflectDir.x * 8.0 + u_time * 0.1) * 0.03 + sin(reflectDir.z * 12.0) * 0.02;
      vec3 skyColor = mix(skyTop, skyBottom, skyT) + cloud;
      float cosTheta = max(dot(viewDir, normal), 0.0);
      float fresnel = pow(1.0 - cosTheta, 5.0);
      fresnel = mix(0.15, 1.0, fresnel);
      vec3 color = mix(floorColor, skyColor, fresnel);
      // 焦散只取正的拉普拉斯值 → 只提亮不压暗（压暗会在波谷出现灰色块）
      float lap = (hL + hR + hU + hD - 4.0 * h);
      float caustic = 1.0 + max(lap, 0.0) * u_caustic * 28.0;
      caustic = clamp(caustic, 1.0, 1.6);
      color *= caustic;
      color = mix(color, color * u_waterTint * 1.15, 0.05);
      vec3 halfDir = normalize(u_lightDir + viewDir);
      float spec = pow(max(dot(normal, halfDir), 0.0), 80.0);
      color += spec * vec3(1.0, 0.98, 0.9) * 0.9;
      // 关键：alpha 只由波形剧烈程度决定（原本的 fresnel 参与 alpha 会让屏幕边缘灰蒙蒙）
      float waveAmt = abs(h) * 50.0 + abs(hL - hR) * 25.0 + abs(hU - hD) * 25.0;
      float alpha = smoothstep(0.04, 0.2, waveAmt) * 0.5;
      alpha = min(0.55, alpha + spec * 0.35);
      fragColor = vec4(color * alpha, alpha);   // 预乘 alpha
    }`;

  const progSim = program(VS_FULLSCREEN, FS_SIMULATE);
  const progDrop = program(VS_FULLSCREEN, FS_DROP);
  const progRender = program(VS_FULLSCREEN, FS_RENDER);
  // 任一着色器编译/链接失败 → 直接停下（否则只会静默画不出东西）
  if (!progSim || !progDrop || !progRender) { console.error('[Water] 着色器初始化失败'); return null; }

  // ========== 高度场 ping-pong ==========
  function makeFloatTex(size) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  let heightA = makeFloatTex(HEIGHT_SIZE);
  let heightB = makeFloatTex(HEIGHT_SIZE);
  const fb = gl.createFramebuffer();
  const heightTexel = [1.0 / HEIGHT_SIZE, 1.0 / HEIGHT_SIZE];

  function drawTri() { gl.drawArrays(gl.TRIANGLES, 0, 3); }

  // ========== 鼠标交互 ==========
  const drops = [];                     // 待注入的高度场扰动（点状水珠 / 扩散环）
  let lastMX = -1, lastMY = -1;
  let time = 0;

  function uvOf(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { u: (clientX - rect.left) / rect.width, v: 1.0 - (clientY - rect.top) / rect.height };
  }
  function addDrop(clientX, clientY, strength) {
    const p = uvOf(clientX, clientY);
    if (!p) return;
    drops.push({ u: p.u, v: p.v, radius: 0.035, strength: strength, ring: 0.0 });
  }

  const clickRipples = [];              // 点击产生的「一圈一圈向外扩散」
  function addRipple(clientX, clientY, strength) {
    const p = uvOf(clientX, clientY);
    if (!p) return;
    clickRipples.push({ u: p.u, v: p.v, strength: strength || 1.0, start: time });
    if (clickRipples.length > RIPPLE.maxR) clickRipples.shift();
  }

  // 光标位置 → 尾迹（页面自己的 mousemove；壁纸窗口下由 setPointer 走同一套逻辑）
  function pointerMove(clientX, clientY) {
    if (lastMX !== -1) {
      const dx = clientX - lastMX, dy = clientY - lastMY;
      if (dx * dx + dy * dy > TRAIL_STEP * TRAIL_STEP) addDrop(clientX, clientY, TRAIL_STRENGTH);
    }
    lastMX = clientX; lastMY = clientY;
  }
  function onMouseMove(e) { pointerMove(e.clientX, e.clientY); }
  function onMouseDown(e) { addRipple(e.clientX, e.clientY, 1.0); }
  function onMouseLeave() { lastMX = -1; lastMY = -1; }
  function onTouchStart(e) { const t = e.touches[0]; addRipple(t.clientX, t.clientY, 1.0); }
  function onTouchMove(e) { const t = e.touches[0]; pointerMove(t.clientX, t.clientY); }

  // 在浏览器里直接打开 wallpaper.html 也能玩（壁纸窗口下这些事件收不到，由 IPC 代替）
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: true });

  // ========== Resize ==========
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener('resize', resize);

  // ========== 渲染通道 ==========
  function passSimulate() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, heightB, 0);
    gl.viewport(0, 0, HEIGHT_SIZE, HEIGHT_SIZE);
    gl.useProgram(progSim);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightA);
    gl.uniform1i(gl.getUniformLocation(progSim, 'u_tex'), 0);
    gl.uniform2fv(gl.getUniformLocation(progSim, 'u_texel'), heightTexel);
    gl.uniform1f(gl.getUniformLocation(progSim, 'u_damping'), DAMPING);
    drawTri();
    const tmp = heightA; heightA = heightB; heightB = tmp;
  }
  function passDrop(drop) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, heightB, 0);
    gl.viewport(0, 0, HEIGHT_SIZE, HEIGHT_SIZE);
    gl.useProgram(progDrop);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightA);
    gl.uniform1i(gl.getUniformLocation(progDrop, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(progDrop, 'u_center'), drop.u, drop.v);
    gl.uniform1f(gl.getUniformLocation(progDrop, 'u_radius'), drop.radius);
    gl.uniform1f(gl.getUniformLocation(progDrop, 'u_ring'), drop.ring || 0.0);
    gl.uniform1f(gl.getUniformLocation(progDrop, 'u_strength'), drop.strength);
    drawTri();
    const tmp = heightA; heightA = heightB; heightB = tmp;
  }
  function passRender() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    // 每帧先清成完全透明 → 平静的水面什么都不画，桌面原样透出来
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(progRender);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, heightA);
    gl.uniform1i(gl.getUniformLocation(progRender, 'u_height'), 0);
    gl.uniform2fv(gl.getUniformLocation(progRender, 'u_heightTexel'), heightTexel);
    gl.uniform1f(gl.getUniformLocation(progRender, 'u_waveHeight'), WAVE_HEIGHT);
    gl.uniform1f(gl.getUniformLocation(progRender, 'u_caustic'), CAUSTIC_STRENGTH);
    gl.uniform3fv(gl.getUniformLocation(progRender, 'u_waterTint'), WATER_TINT);
    gl.uniform3f(gl.getUniformLocation(progRender, 'u_lightDir'), 0.4, 0.8, 0.45);
    gl.uniform2f(gl.getUniformLocation(progRender, 'u_resolution'), canvas.width, canvas.height);
    gl.uniform1f(gl.getUniformLocation(progRender, 'u_time'), time);
    drawTri();
    gl.disable(gl.BLEND);
  }

  // ========== 渲染循环 ==========
  let rafId = null;
  function frame() {
    time += 0.016;
    // 点击涟漪：每帧在「正在扩散的环半径处」注入一圈波
    for (let i = clickRipples.length - 1; i >= 0; i--) {
      const r = clickRipples[i];
      let finished = true;
      for (let w = 0; w < RIPPLE.waves; w++) {
        const elapsed = time - (r.start + w * RIPPLE.waveGap);
        if (elapsed < 0) { finished = false; continue; }   // 后续圈还没开始
        if (elapsed > RIPPLE.life) continue;               // 该圈已扩散完
        finished = false;
        const fade = 1.0 - elapsed / RIPPLE.life;          // 尾段淡出
        drops.push({
          u: r.u, v: r.v,
          radius: RIPPLE.thick,
          ring: 0.01 + elapsed * RIPPLE.speed,
          strength: RIPPLE.amp * 0.016 * fade * r.strength,
        });
      }
      if (finished) clickRipples.splice(i, 1);
    }
    while (drops.length) passDrop(drops.shift());
    passSimulate();
    passRender();
    rafId = requestAnimationFrame(frame);
  }
  function start() { if (rafId) return; rafId = requestAnimationFrame(frame); }
  function pause() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  resize();
  start();                      // 起步时水面完全平静（没有任何环境涟漪）

  // ========== 对外控制句柄 ==========
  return {
    // 主进程轮询到的真实光标位置 → 尾迹涟漪
    setPointer(clientX, clientY) { pointerMove(clientX, clientY); },
    // 主进程下发的全局左键点击 → 扩散涟漪
    clickAt(clientX, clientY) { addRipple(clientX, clientY, 1.0); },
    pause,
    resume() { lastMX = -1; lastMY = -1; start(); },
    stop() {
      pause();
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('resize', resize);
      try {
        gl.deleteTexture(heightA); gl.deleteTexture(heightB);
        gl.deleteFramebuffer(fb);
        gl.deleteProgram(progSim); gl.deleteProgram(progDrop); gl.deleteProgram(progRender);
      } catch (e) {}
    },
  };
};