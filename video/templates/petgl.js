/* video/templates/petgl.js —— 皮套的 WebGL 网格变形渲染器
 * ═══════════════════════════════════════════════════════════════
 * 为什么要有这个文件：
 *   原来皮套是「一张图 + CSS transform」，能做的只有平移/旋转/缩放，
 *   也就是整张图一起动。主人一眼看穿：「就是图片加上简单的呼吸，大小大小」。
 *   局部动作（头发飘、手动、只有上半身呼吸）必须让画面真的变形，
 *   CSS 做不到，只能上网格。
 *
 * 做法：把图铺成 72×72 的网格，顶点在着色器里按区域权重位移，
 *   纹理坐标保持**未变形**的原值 —— 这一步很关键，
 *   如果 uv 跟着顶点一起变，等于「图像重新映射到它自己」，画面上什么都看不出来。
 *
 * 分工（和 pet.js 里的 CSS 层配合）：
 *   CSS  层：整体平移(bob) / 随机微动作(micro) / 点头(react)  —— 仿射就够
 *   WebGL 层：呼吸(上半身) / 弯曲摇摆 / 头发飘 / 手动 / 右缘景深模糊 —— 需要局部形变
 *
 * 已知限制：
 *   · 眨眼做不了「几何变形」。把眼睛区域压扁只会变成「翻白眼」——
 *     闭眼需要「眼睛消失、只剩睫毛线」这种不同的像素内容。
 *     所以眨眼是**换一张闭眼纹理**（faces.blink），由 pet.js 按间隔触发。
 *   · 嘴型开合同理，只能做轻微伸缩，做不出真正的「说话」。
 */
(function () {
  const VS = `
precision highp float;
attribute vec2 aPos;
uniform float uT;        // 秒
uniform float uMouth;    // 0..1 嘴部开合
uniform float uBend;     // 身体弯曲量，由 JS 传（已经算好相位）
varying vec2 vUV;

float rectMask(vec2 uv, vec2 c, vec2 r){
  vec2 d = abs(uv - c) / r;
  return 1.0 - smoothstep(0.55, 1.0, max(d.x, d.y));
}

void main(){
  vec2 uv = aPos;
  float t = uT;
  vec2 p = uv;

  /* ① 呼吸：上半身纵向起伏，脚底权重为 0。
     CSS 版是整图 scaleY、原点在脚底，观感是「从脚往上长高」；
     这里把权重压在上半身，肚子以下几乎不动。 */
  float wB = smoothstep(0.98, 0.30, uv.y);
  p.y -= wB * 0.010 * sin(t * 1.9);

  /* ② 摇摆：从下往上渐进的横向偏移 = 身体在弯，不是整块在转 */
  float wS = pow(max(0.0, 1.0 - uv.y), 1.8);
  p.x += wS * 0.016 * uBend;

  /* ③ 头发飘：两侧发区做行波，发根几乎不动、发梢幅度最大 */
  float hairTop = smoothstep(0.10, 0.26, uv.y);
  float hairBot = 1.0 - smoothstep(0.78, 0.92, uv.y);
  float hairL = (1.0 - smoothstep(0.18, 0.30, uv.x)) * hairTop * hairBot;
  float hairR = smoothstep(0.60, 0.74, uv.x) * hairTop * hairBot;
  float hair = hairL + hairR;
  float hw = hair * smoothstep(0.25, 0.88, uv.y);
  p.x += hw * 0.019 * sin(t * 1.55 + uv.y * 9.0);
  p.y += hw * 0.006 * cos(t * 1.25 + uv.x * 7.0);

  /* ④ 嘴：轻微开合（做不出真说话，只是让嘴别完全静止） */
  float mouthM = rectMask(uv, vec2(0.432, 0.522), vec2(0.105, 0.058));
  float mo = mix(0.72, 1.22, uMouth);
  p.y = mix(p.y, 0.522 + (p.y - 0.522) * mo, mouthM);

  /* ⑤ 手：捧牌的两只手轻微起伏 */
  float handM = rectMask(uv, vec2(0.315, 0.705), vec2(0.062, 0.055))
              + rectMask(uv, vec2(0.565, 0.705), vec2(0.062, 0.055));
  p.y += clamp(handM, 0.0, 1.0) * 0.012 * sin(t * 2.3);

  /* 🔴 vUV 用未变形的 uv —— 见文件头说明。
     这一行如果写成 vUV = p，几何和纹理一起动，等于把图重新映射到自己身上，
     画面纹丝不动（实测逐像素差 mean=0.00）。 */
  vUV = uv;
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`

  /* 右缘景深：原来靠一层 CSS blur(11px) 的副本盖住贴边的尾巴。
     WebGL 里没有 filter，改成对右边缘做多次采样平均 —— 等效于模糊。
     🔴 采样必须先预乘 alpha 再平均。
     PNG 的透明像素 RGB 常常是黑的/脏的，直接平均颜色会把它们混进来，
     边缘外圈就出现一圈灰黑色的脏影（实测尾巴右边有一条灰雾）。
     预乘之后透明像素贡献为 0，平均才是对的。 */
  const FS = `
precision mediump float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform float uBlurStart;

vec4 tap(vec2 uv){
  vec4 c = texture2D(uTex, uv);
  return vec4(c.rgb * c.a, c.a);
}

void main(){
  vec4 c = tap(vUV);
  /* 右边 12% 开始渐入模糊，越靠边糊得越狠 */
  float w = smoothstep(uBlurStart, 1.0, vUV.x);
  if (w > 0.01) {
    float r = 0.012 * w;
    vec4 sum = c;
    sum += tap(vUV + vec2( r, 0.0));
    sum += tap(vUV + vec2(-r, 0.0));
    sum += tap(vUV + vec2(0.0,  r));
    sum += tap(vUV + vec2(0.0, -r));
    sum += tap(vUV + vec2( r * .7,  r * .7));
    sum += tap(vUV + vec2(-r * .7, -r * .7));
    sum += tap(vUV + vec2( r * .7, -r * .7));
    sum += tap(vUV + vec2(-r * .7,  r * .7));
    c = mix(c, sum / 9.0, w);
  }
  /* 上面全是预乘值，直接输出，配合 ONE / ONE_MINUS_SRC_ALPHA 即可 */
  gl_FragColor = c;
}`

  const N = 72   // 网格密度：72×72 个格子，局部形变够平滑，性能绰绰有余

  function compile(gl, type, src) {
    const s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error('shader: ' + gl.getShaderInfoLog(s))
    }
    return s
  }

  function loadImg(url) {
    return new Promise((res, rej) => {
      const im = new Image()
      im.onload = () => res(im)
      im.onerror = () => rej(new Error('图加载失败: ' + url))
      im.src = url
    })
  }

  /**
   * @param {HTMLElement} host 容器（宽度由 CSS 决定）
   * @param {object} cfg { faces:{name:url}, blurStart:0..1 }
   * @returns {Promise<object>} 渲染器句柄
   */
  async function mount(host, cfg) {
    const faces = cfg.faces || {}
    const names = Object.keys(faces).filter(k => faces[k])
    if (!names.length) throw new Error('petgl: 没有表情图')

    /* 🔴 先加载图、再定画布尺寸。
     * 画布高度必须来自图片自身的宽高比 —— 写死 693/676 的话，
     * 哪天换素材就会拉伸，而拉伸是在着色器里发生的，肉眼只能看到"人变胖了"，
     * 排查起来毫无线索。 */
    const imgs = {}
    await Promise.all(names.map(n => loadImg(faces[n]).then(im => { imgs[n] = im })))
    const ref = imgs[names[0]]
    const ratio = ref.naturalHeight / ref.naturalWidth

    const cv = document.createElement('canvas')
    const w = host.clientWidth || host.getBoundingClientRect().width || 760
    cv.width = Math.max(2, Math.round(w))
    cv.height = Math.max(2, Math.round(w * ratio))
    cv.className = 'petGL'
    host.appendChild(cv)

    /* preserveDrawingBuffer：录制/截图时才能稳定拿到当前帧。
     * 不加的话合成完缓冲就被清掉，截出来是全透明。 */
    const gl = cv.getContext('webgl', {
      premultipliedAlpha: true, alpha: true, antialias: true,
      preserveDrawingBuffer: true,
    })
    if (!gl) { cv.remove(); throw new Error('petgl: WebGL 不可用') }

    const prog = gl.createProgram()
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS))
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('petgl link: ' + gl.getProgramInfoLog(prog))
    }
    gl.useProgram(prog)

    const verts = []
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const x0 = x / N, x1 = (x + 1) / N, y0 = y / N, y1 = (y + 1) / N
        verts.push(x0, y0, x1, y0, x0, y1, x1, y0, x1, y1, x0, y1)
      }
    }
    const vb = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vb)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW)
    const loc = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)

    /* 每个表情一张纹理，切换只换绑定，不重传 */
    const texs = {}
    for (const n of names) {
      const t = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, imgs[n])
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      texs[n] = t
    }

    gl.viewport(0, 0, cv.width, cv.height)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)
    /* 模糊起点：尾巴尖在素材里贴着右边缘（bbox right = W-1），不糊就是一刀切。
     * 但起点不能太靠左 —— 0.80 起糊会把尾巴尖整段化开，只留一团灰雾；
     * 0.88 刚好只吃掉最右边那一点点，尾巴形状还认得出来。 */
    gl.uniform1f(gl.getUniformLocation(prog, 'uBlurStart'),
      typeof cfg.blurStart === 'number' ? cfg.blurStart : 0.88)

    const U = {
      t: gl.getUniformLocation(prog, 'uT'),
      mouth: gl.getUniformLocation(prog, 'uMouth'),
      bend: gl.getUniformLocation(prog, 'uBend'),
    }

    /* 主表情：有 happy 就用 happy，否则第一张。
     * blink 是眨眼专用纹理，不参与表情轮换。 */
    const MAIN = names.filter(n => n !== 'blink')
    let curFace = MAIN.includes('happy') ? 'happy' : MAIN[0]
    let t0 = performance.now()
    let raf = 0
    let running = false
    const mouthPhase = Math.random() * 10
    let blinkUntil = 0
    let blinkBack = ''

    function paint(t, face) {
      /* 弯曲：0.95 rad/s 的正弦，幅度 ±1 */
      const bend = Math.sin(t * 0.95)
      /* 嘴：两段不同频率叠加，避免像节拍器 */
      const mouth = 0.5 + 0.5 * Math.sin(t * 5.1 + mouthPhase) *
        (0.55 + 0.45 * Math.sin(t * 2.3))
      gl.uniform1f(U.t, t)
      gl.uniform1f(U.mouth, mouth)
      gl.uniform1f(U.bend, bend)
      gl.bindTexture(gl.TEXTURE_2D, texs[face] || texs[curFace])
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2)
    }

    function draw() {
      const now = performance.now()
      /* 眨眼：时间到就切回原表情。
       * 用时间戳而不是 setTimeout —— 录制时主线程可能被截图/编码阻塞，
       * 定时器排队会让「闭眼」多停几百毫秒，看起来像在打瞌睡。 */
      if (blinkBack && now >= blinkUntil) {
        curFace = blinkBack
        blinkBack = ''
      }
      paint((now - t0) / 1000, blinkBack ? 'blink' : curFace)
    }

    function loop() {
      if (!running) return
      draw()
      raf = requestAnimationFrame(loop)
    }

    const api = {
      canvas: cv,
      names,
      get face() { return curFace },
      /** 切表情（blink 除外，它只由 blink() 触发） */
      setFace(n) {
        if (texs[n] && n !== 'blink') { curFace = n; draw() }
      },
      /**
       * 眨眼：换成闭眼纹理闪一下再换回来。
       * 🔴 不要用 smug 顶替 —— smug 是半睁眼撇嘴，嘴型也变了，
       * 闪一帧读起来是「抽搐」，不是眨眼。必须有真正的闭眼图。
       * @returns {boolean} 没有闭眼纹理时返回 false，调用方据此不做无谓等待
       */
      blink(ms) {
        if (!texs.blink) return false
        if (blinkBack) { blinkUntil = performance.now() + (ms || 110); return true }
        blinkBack = curFace
        blinkUntil = performance.now() + (ms || 110)
        draw()
        return true
      },
      start() {
        if (running) return
        running = true
        t0 = performance.now()
        loop()
      },
      stop() {
        running = false
        if (raf) cancelAnimationFrame(raf)
        raf = 0
      },
      /** 录制/调试用：把时间推到确定的一点再画一帧 */
      drawAt(t, opts) {
        const o = opts || {}
        if (o.face && texs[o.face]) curFace = o.face
        blinkBack = o.blink && texs.blink ? 'blink' : ''
        paint(t, blinkBack || curFace)
      },
      destroy() {
        api.stop()
        cv.remove()
      },
    }
    return api
  }

  window.PETGL = { mount }
})()
