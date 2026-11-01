/* video/templates/pet.js —— 皮套动效播放器（模板共用）
 * ═══════════════════════════════════════════════════════════════
 * 素材来自 assets/pet2/（红发女仆 4 组表情，各 124 帧 24fps），
 * 由 tools/pet-anim.mjs 预先编成带 alpha 的循环 webm（pingpong 已烘进去）。
 *
 * 为什么是 <video> 而不是逐帧换 <img>：
 *   · 内存：124 帧 × 713×714×4B ≈ 254MB/组，四组能把标签页压垮；
 *     video 解码是常数内存。
 *   · 切换：换 src 要重新解码，切表情会卡一下；video 只改 opacity。
 *   · 同步：视频自带时钟，不受主线程掉帧影响。
 *
 * 三件套叠在一起才有"活人感"：
 *   1. 表情（真帧）—— 按段落情绪切 idle/happy/sad/thinking
 *   2. 反应（已移除）—— 曾经让整只鱼 scale(1.05) 弹一下，太像 bug
 *   3. 运镜（push）—— 整片缓慢推近 6%，静态画面也不死
 *
 * 用法：
 *   await PET.mount(document.getElementById('pet'), {anim, clips, still, dur})
 *   PET.set('happy')        // 切表情
 *   PET.react()             // 空实现（接口保留）
 *   PET.mood(seg, i, n)     // 段落 → 表情（含启发式兜底）
 */
(function () {
  const ORDER = ['idle', 'happy', 'sad', 'thinking']
  let host = null
  let stage = null
  let stillEl = null
  let nodEl = null
  let microEl = null
  let microTimer = null
  const vids = {}
  let cur = ''
  let ready = false
  let neutral = 0   // 连续中性段落计数，用来打破一长串 idle

  /* ── 表情图（2026-10-31 新增）──
   * 原来的静图只有一张「闭眼笑」，四组序列帧也是同一张闭眼笑 ——
   * 主人说"眼睛都不睁，呆呆的"。现在换成 4 张 AI 生成的表情图：
   *   happy    睁眼笑（默认）
   *   surprise 睁大眼惊讶
   *   smug     半睁眼撇嘴（吐槽/翻车/疑问用）
   *   blink    闭眼（只当眨眼用，不参与表情轮换）
   * 四张图是用同一张参考图、同一套 prompt 生成的，抠图后按高度对齐到
   * 676×693，叠加测试无重影 —— 所以切换时身体不会跳。 */
  const faces = {}
  let curFace = ''
  let blinkTimer = null

  /* ── WebGL 网格渲染器（2026-10-31）──
   * 有 ≥2 张主表情图且浏览器支持 WebGL 时走这条路：
   * 局部形变（头发飘 / 手动 / 上半身呼吸 / 身体弯曲 / 右缘景深）交给着色器，
   * CSS 只留整体平移(bob)、随机微动作(micro)、点头(react) 这三层仿射动作。
   * 拿不到 WebGL 就退回原来的「多图叠 opacity」路径，功能不减，只是没有形变。 */
  let gl = null

  /* 🔴 happy 这组素材顶部是被画框切掉的，不是图层遮挡：
   * 它是「跳起来欢呼」，角色在 768×768 的源画布里往上冲，头顶越过画框上沿，
   * 那几行像素在生成时就没有了。实测每帧第 0 行有 25~89 像素宽的不透明色块
   * —— 就是一条横贯头发的硬直线（idle/sad/thinking 只有 0~3 像素，是呆毛尖）。
   * 容器没有 overflow:hidden，放大也不裁切，所以改 CSS 没用；
   * 缺的像素缩放/位移也补不回来（往下挪只是把那条线挪到更低处）。
   * 重新生成 happy（留够头顶余量）之后，把这里改成 true 就恢复。 */
  const HAPPY_OK = false

  const CSS = `
#pet{transform-origin:bottom center;transition:transform .26s cubic-bezier(.2,.9,.3,1)}
#pet .petStage{position:relative;width:100%;transform-origin:bottom center;
  -webkit-mask-image:linear-gradient(to right,#000 0,#000 90%,rgba(0,0,0,0) 100%);
  mask-image:linear-gradient(to right,#000 0,#000 90%,rgba(0,0,0,0) 100%)}
#pet.on .petStage{animation:petPush var(--petdur,90s) linear both}
@keyframes petPush{from{transform:scale(1)}to{transform:scale(1.06)}}

/* ── code 模式：静图 + CSS 动作，全部由浏览器现算，零素材零成本 ──
 * 静态图要"活"，靠两件事：
 *   A. 几层**不同周期**的连续动作叠着，让人找不到循环点
 *      bob    3.9s  整只上下浮 7px
 *      sway   6.4s  左右偏 ±1.5°
 *      breath 3.4s  纵向 2.8%
 *   B. 每隔 5~10 秒来一个**离散小动作**（歪头/耸肩/前倾），
 *      由 Web Animations 随机播放 —— 这是打破"钟摆感"的关键，
 *      连续正弦运动看久了像节拍器，人不会那样动。
 * 周期取 3.9 / 6.4 / 3.4 这种互不成倍数的值。 */
.petNod{transform-origin:bottom center}
.petMicro{transform-origin:bottom center}
.petBob{transform-origin:bottom center;animation:petBob 3.9s ease-in-out infinite}
@keyframes petBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
.petSway{transform-origin:bottom center;animation:petSway 6.4s ease-in-out infinite}
@keyframes petSway{0%,100%{transform:rotate(-1.5deg)}50%{transform:rotate(1.5deg)}}
.petBreath{position:relative;transform-origin:bottom center;
  animation:petBreath 3.4s ease-in-out infinite}
@keyframes petBreath{0%,100%{transform:scale(1,1)}50%{transform:scale(1.01,1.028)}}
/* WebGL 接管后这两个动画必须停 —— 着色器已经在做「上半身呼吸 + 身体弯曲」，
 * CSS 再叠一层整图 scaleY/rotate，观感就是「整块在转的同时局部在弯」，
 * 两个相位打架，看起来像信号不良。 */
.petSway.off,.petBreath.off{animation:none}
.petImg{width:100%;display:block}
/* WebGL 画布：和 .petImg 一样铺满容器。
 * 尺寸由 petgl.js 按图片宽高比算，这里只管显示宽度。
 * 景深模糊在着色器里做，所以这个路径**不挂** .petBlur 那一层。 */
.petGL{width:100%;display:block}
/* ── 表情层：多张同尺寸图叠着切 opacity ──
 * 第一张 .base 用 position:relative 撑开容器高度，其余全部绝对定位重叠。
 * 切换只花 .12s —— 太慢会看到两张脸混在一起（半透明叠脸很脏），
 * 太快又像硬切；.12s 刚好是「表情一变」而不是「渐变」。 */
.petFaces{position:relative;width:100%}
.petFace{position:absolute;left:0;top:0;width:100%;display:block;
  opacity:0;transition:opacity .12s ease-out}
.petFace.base{position:relative}
/* 眨眼层要快：90ms 的开合，慢一点就成了"眯眼" */
.petFace.blink{transition:opacity .05s linear}
/* 尾巴尖在素材里本来就贴着右边（静图包围盒 right=675=W-1），放大后就是一刀切。
 * 盖一层虚化副本：右缘从清晰过渡到失焦，读起来是景深收边，而不是"卡掉了"。
 * 2026-10-31：新表情图的尾巴比原图粗，82% 起糊不够，硬边还是露 —— 提到 74%，
 * 同时把 .petStage 的 mask 从 94% 提前到 90%，两层一起把边缘吃掉。 */
.petBlur{position:absolute;left:0;top:0;width:100%;display:block;
  filter:blur(11px);opacity:.95;
  -webkit-mask-image:linear-gradient(to right,transparent 74%,#000 100%);
  mask-image:linear-gradient(to right,transparent 74%,#000 100%)}

/* ── frames 模式：AI 序列帧 ──
 * 🔴 这里的选择器必须只打 video 和 .petFallback ——
 * 以前是「#pet .petStage img」，会把 code 模式的 .petImg/.petBlur 一起设成
 * opacity:0（id 选择器优先级高），角色整个消失。 */
#pet .petStage video{position:absolute;left:0;top:0;width:100%;height:auto;
  display:block;opacity:0;transition:opacity .18s linear}
#pet .petStage video.on{opacity:1}
#pet .petStage video:first-of-type{position:relative}
#pet .petStage .petFallback{width:100%;display:block;opacity:0;transition:opacity .18s linear}
#pet .petStage .petFallback.on{opacity:1}
`

  function injectCss() {
    if (document.getElementById('petCss')) return
    const s = document.createElement('style')
    s.id = 'petCss'
    s.textContent = CSS
    document.head.appendChild(s)
  }

  /** 等一帧能画出来；超时/报错就当这条不可用，绝不卡住整片录制 */
  function waitReady(v, ms) {
    if (v.readyState >= 2) return Promise.resolve(true)
    return new Promise(res => {
      let done = false
      const fin = ok => { if (done) return; done = true; clearTimeout(t); off(); res(ok) }
      const t = setTimeout(() => fin(false), ms || 10000)
      const onOk = () => fin(true)
      const onBad = () => fin(false)
      function off() {
        v.removeEventListener('canplay', onOk)
        v.removeEventListener('error', onBad)
      }
      v.addEventListener('canplay', onOk)
      v.addEventListener('error', onBad)
    })
  }

  /**
   * code 模式：静图 + CSS 动作，表情靠多张图切 opacity / WebGL 形变。
   *
   * 两条路径，能力不同但接口一致：
   *   A. WebGL（主路径）—— 有 ≥2 张主表情图且 window.PETGL 存在
   *      CSS  层：nod(点头) / micro(随机微动作) / bob(整体上下浮)
   *      GL   层：呼吸(只上半身) / 弯曲摇摆 / 头发飘 / 手动 / 右缘景深
   *      → 局部形变是真的在变形，不是整张图缩放
   *   B. 多图叠 opacity（兜底）—— 拿不到 WebGL 时
   *      CSS  层：nod / micro / bob / sway / breath + 多张 img 切 opacity
   *      → 只有仿射动作，没有局部形变
   *   单张图（cfg.faces 不足两张）也走 B，但只挂一张图。
   */
  async function mountCode(stage, cfg) {
    const nod = document.createElement('div')
    nod.className = 'petNod'
    const micro = document.createElement('div')
    micro.className = 'petMicro'
    const bob = document.createElement('div')
    bob.className = 'petBob'
    const sway = document.createElement('div')
    sway.className = 'petSway'
    const breath = document.createElement('div')
    breath.className = 'petBreath'

    const faceKeys = cfg.faces ? Object.keys(cfg.faces).filter(k => cfg.faces[k]) : []
    /* blink 是眨眼专用层，不算「主表情」—— 只有它一张时不算多表情 */
    const mainKeys = faceKeys.filter(k => k !== 'blink')
    const multi = mainKeys.length > 1

    /* ── 先把兜底图层搭好、挂进 DOM，再去试着上 WebGL ──
     * 顺序很重要，两个原因：
     *   1. 尺寸：petgl 要读容器的 clientWidth 来定画布大小，
     *      元素没进 DOM 时 clientWidth 是 0，只能瞎猜一个默认值；
     *   2. 兜底：着色器编译失败 / WebGL 被禁用时，图已经在了，
     *      直接留着用就行，不会出现「动效挂了连皮套都没了」。
     * 几张小图的解码开销可以忽略，而它换来的是绝对不会开天窗。 */
    let wrap = null
    let blurEl = null
    if (multi) {
      wrap = document.createElement('div')
      wrap.className = 'petFaces'
      /* 顺序有讲究：blink（闭眼）必须最后加 —— 绝对定位的后来者盖在上面，
       * 眨眼层得压在所有表情之上才盖得住。 */
      const order = mainKeys.concat(faceKeys.includes('blink') ? ['blink'] : [])
      order.forEach((k, i) => {
        const im = document.createElement('img')
        im.className = 'petFace' + (i === 0 ? ' base' : '') + (k === 'blink' ? ' blink' : '')
        im.dataset.k = k
        im.alt = ''
        im.src = cfg.faces[k]
        wrap.appendChild(im)
        faces[k] = im
      })
      breath.appendChild(wrap)
      curFace = order[0]
      faces[curFace].style.opacity = '1'
    } else {
      const img = document.createElement('img')
      img.className = 'petImg'
      img.alt = ''
      img.src = cfg.still || (mainKeys[0] && cfg.faces[mainKeys[0]]) || ''
      breath.appendChild(img)
    }

    /* 景深虚化副本：右缘收边用。多表情时跟着主表情走，
     * 不然模糊层是 A 表情、上层是 B 表情，边缘会透出另一张脸的轮廓。 */
    blurEl = document.createElement('img')
    blurEl.className = 'petBlur'
    blurEl.alt = ''
    blurEl.src = (multi && cfg.faces[mainKeys[0]]) || cfg.still || ''
    breath.appendChild(blurEl)

    sway.appendChild(breath)
    bob.appendChild(sway)
    micro.appendChild(bob)
    nod.appendChild(micro)
    stage.appendChild(nod)
    nodEl = nod
    microEl = micro
    cur = 'idle'

    /* ── 试着换成 WebGL 网格变形 ──
     * 成功后：删掉叠图（脸交给纹理）、删掉虚化副本（着色器自己糊），
     * 并关掉 sway/breath 两个 CSS 动画 —— 它们在着色器里做得更好，
     * 两层叠着会变成「整块转 + 局部弯」的鬼影。 */
    if (multi && window.PETGL) {
      try {
        gl = await window.PETGL.mount(breath, {
          faces: cfg.faces,
          blurStart: Number(cfg.blurStart) || 0.88,
        })
        if (wrap) { wrap.remove(); for (const k in faces) delete faces[k] }
        if (blurEl) { blurEl.remove(); blurEl = null }
        sway.classList.add('off')
        breath.classList.add('off')
        curFace = gl.face
        gl.start()
      } catch (e) {
        /* 着色器编译失败 / WebGL 被禁用 / 纹理加载失败 —— 图还在，照常用 */
        console.warn('petgl 挂载失败，退回多图叠层：' + (e && e.message))
        gl = null
      }
    }

    if (multi) startBlink()
    startMicro()

    if (gl) {
      ready = true
      return { ok: true, mode: 'gl', clips: [] }
    }

    return new Promise(res => {
      const done = () => { ready = true; res({ ok: true, mode: 'code', clips: [] }) }
      /* 多表情时等「所有脸都解码完」再开表 —— 少等一张，第一个气泡就会
       * 切到还没加载好的表情上，那一瞬间是空白的 */
      const list = multi ? faceKeys.map(k => faces[k]) : [breath.querySelector('.petImg')]
      let left = list.filter(Boolean).length
      if (!left) return done()
      const one = () => { if (--left <= 0) done() }
      list.filter(Boolean).forEach(im => {
        if (im.complete && im.naturalWidth) return one()
        im.addEventListener('load', one, { once: true })
        im.addEventListener('error', one, { once: true })
      })
      setTimeout(done, 8000)
    })
  }

  /** 切表情。blink 是眨眼专用层，不参与切换。 */
  function setFace(k) {
    if (!k || k === 'blink' || k === curFace) return
    if (gl) { gl.setFace(k); curFace = gl.face; return }
    if (!faces[k]) return
    curFace = k
    for (const key in faces) {
      if (key === 'blink') continue
      faces[key].style.opacity = key === k ? '1' : '0'
    }
  }

  /** 眨眼：闭眼纹理闪一下（110ms）。
   * 🔴 不能用「把眼睛区域压扁」—— 几何变形变不出「闭眼」，
   * 压扁只会露出眼白，看起来像翻白眼。
   * 🔴 也不能拿 smug 顶替 —— 它是半睁眼撇嘴，嘴型也变了，
   * 闪一帧读起来是抽搐。所以必须有一张真正的闭眼图（faces.blink）。
   * 🔴 只在 happy 上眨：那张闭眼图是从 happy 生成/对齐的，嘴是张开的笑。
   * surprise 是圆嘴、smug 是撇嘴，闪过去嘴型会跳 —— 110ms 也看得出来。
   * 宁可这些表情不眨眼，也不要闪一下换张脸。
   * 间隔 2.6~5.6 秒带随机：固定节奏会像节拍器。 */
  function startBlink() {
    if (blinkTimer) return
    if (!gl && !faces.blink) return
    const loop = () => {
      blinkTimer = setTimeout(() => {
        const now = gl ? gl.face : curFace
        if (now === 'happy') {
          if (gl) gl.blink(110)
          else {
            faces.blink.style.opacity = '1'
            setTimeout(() => { faces.blink.style.opacity = '0' }, 110)
          }
        }
        loop()
      }, 2600 + Math.random() * 3000)
    }
    loop()
  }

  /* 离散小动作：歪头 / 耸肩 / 前倾 / 侧倾回正。
   * 为什么需要：bob+sway+breath 都是正弦，叠再多也只是"节拍器换拍子"，
   * 看久了还是机械。真人待机是"长时间不动 + 偶尔动一下"，
   * 所以这里用随机间隔（5.2~10.4 秒）插一记短动作，节奏才不像机器。 */
  const MICRO = [
    { d: 1000, e: 'ease-in-out', t: [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(2.4deg)', offset: 0.42 },
      { transform: 'rotate(0deg)' } ] },
    { d: 560, e: 'ease-out', t: [
      { transform: 'scaleY(1)' },
      { transform: 'scaleY(.984)', offset: 0.45 },
      { transform: 'scaleY(1)' } ] },
    { d: 780, e: 'ease-in-out', t: [
      { transform: 'translateY(0)' },
      { transform: 'translateY(-5px)', offset: 0.5 },
      { transform: 'translateY(0)' } ] },
    { d: 1250, e: 'ease-in-out', t: [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(-1.8deg)', offset: 0.3 },
      { transform: 'rotate(.6deg)', offset: 0.68 },
      { transform: 'rotate(0deg)' } ] },
  ]
  function startMicro() {
    if (!microEl || microTimer) return
    let last = -1
    const loop = () => {
      microTimer = setTimeout(() => {
        /* 不连着出同一招 —— 连两次歪头会被看成"抽搐" */
        let k = Math.floor(Math.random() * MICRO.length)
        if (k === last) k = (k + 1) % MICRO.length
        last = k
        const m = MICRO[k]
        try { microEl.animate(m.t, { duration: m.d, easing: m.e }) } catch (e) { /* 不支持就算了 */ }
        loop()
      }, 5200 + Math.random() * 5200)
    }
    loop()
  }

  /** 某个表情是否可用 —— WebGL 路径看 gl.names，叠图路径看 faces */
  function hasFace(k) {
    if (!k) return false
    return gl ? gl.names.indexOf(k) >= 0 : !!faces[k]
  }

  window.PET = {
    /**
     * @param hostEl  #pet 容器
     * @param cfg     {anim:'file:///…/anim', clips:['idle',…], still:'file:///…png', dur:秒}
     * @returns       Promise，等首帧可播后 resolve
     */
    async mount(hostEl, cfg) {
      injectCss()
      host = hostEl
      stage = document.createElement('div')
      stage.className = 'petStage'
      stage.style.setProperty('--petdur', (Number(cfg.dur) || 90) + 's')
      host.appendChild(stage)

      const clips = (cfg.clips && cfg.clips.length ? cfg.clips : ORDER)
        .filter(c => ORDER.includes(c))
      const anim = String(cfg.anim || '').replace(/\/+$/, '')

      /* code 模式：不加载序列帧，静图 + CSS/GL 动作。
       * 边缘绝对干净（静图本身是锐的）、零解码开销、零生成成本。
       * 判定放宽到「有静图 或 有表情图」—— 只配了 petFaces 没配 petImage
       * 也应该走这条路，否则会掉到 frames 分支去等一堆不存在的 webm。 */
      const hasFaces = !!(cfg.faces && Object.keys(cfg.faces).length)
      if ((cfg.mode === 'code' || !anim) && (cfg.still || hasFaces)) return mountCode(stage, cfg)

      /* 静图兜底：先挂上，视频能播了再压在它上面 */
      if (cfg.still) {
        stillEl = document.createElement('img')
        stillEl.src = cfg.still
        stillEl.alt = ''
        stillEl.classList.add('petFallback', 'on')
        stage.appendChild(stillEl)
      }

      const jobs = clips.map(c => {
        const v = document.createElement('video')
        v.src = `${anim}/${c}.webm`
        v.muted = true
        v.loop = true
        v.playsInline = true
        v.preload = 'auto'
        v.setAttribute('muted', '')
        v.dataset.clip = c
        stage.appendChild(v)
        vids[c] = v
        return waitReady(v).then(ok => (ok ? c : null))
      })

      const loaded = (await Promise.all(jobs)).filter(Boolean)
      if (!loaded.length) return { ok: false, clips: [] }   // 全挂了就只用静图

      /* 默认 idle；没有 idle 就用第一个能播的 */
      cur = ''
      this.set(loaded.includes('idle') ? 'idle' : loaded[0], { instant: true })
      ready = true
      return { ok: true, clips: loaded }
    },

    set(clip, opts) {
      if (!host || !clip) return
      /* 表情模式：clip 是表情名（happy/surprise/smug），走 face 那条路。
       * WebGL 路径下表情名存在 gl.names 里，不在 faces 对象里 —— 两处都要认。 */
      const known = gl ? gl.names : Object.keys(faces)
      if (known.indexOf(clip) >= 0) return setFace(clip)
      const next = vids[clip]
      if (!next) return
      if (clip === cur) return
      const prev = vids[cur]
      cur = clip

      /* 从 0 开始播：各段动作是独立循环，接着上一段的相位反而会切在半截动作上 */
      try { next.currentTime = 0 } catch (e) { /* 还没 seekable 就算了 */ }
      next.classList.add('on')
      const p = next.play()
      if (p && p.catch) p.catch(() => {})
      if (stillEl) stillEl.classList.remove('on')

      if (prev) {
        prev.classList.remove('on')
        setTimeout(() => { try { prev.pause() } catch (e) {} }, 200)
      }
      if (opts && opts.instant) { /* 首帧不要过渡，直接亮 */ }
    },

    /**
     * 新气泡弹出时的「反应」。
     * 🔴 以前这里是整只鱼 scale(1.05) 弹一下 —— 5% 在 760px 宽上是 38px，
     * 每说一句话整条鱼就胀一圈，非常像 bug。
     * 现在改成「点一下头」：先往前下压 6px、反向偏 1.4°，再回弹一点点，
     * 460ms。旋转 + 位移都不改变体积，不会再有"变大"的观感。
     * frames 模式不做，真帧动画本身已经在动。
     */
    react() {
      if (!nodEl) return
      nodEl.animate([
        { transform: 'rotate(0deg) translateY(0)' },
        { transform: 'rotate(-1.4deg) translateY(6px)', offset: 0.34 },
        { transform: 'rotate(.5deg) translateY(-2px)', offset: 0.72 },
        { transform: 'rotate(0deg) translateY(0)' },
      ], { duration: 460, easing: 'ease-out' })
    },

    /**
     * 段落 → 表情。
     * 🔴 之前这里"宁可保守，多回 idle"，结果一条 60 秒的片子中段连续 8 段
     * 都是 idle —— idle/happy/sad 三组都是闭眼笑，肉眼根本分不出来，
     * 观众看到的就是"不动"。现在改成：负面→sad，疑问/因果→thinking，
     * 感叹→happy，剩下中性段落每三段插一段 thinking，让眼睛有开合。
     */
    mood(seg, i, n) {
      if (!ready) return 'idle'
      const explicit = seg && seg.mood
      const t = String((seg && seg.text) || '')

      /* ── 多表情模式（有 happy 就优先走这条）──
       * happy 睁眼笑 / surprise 睁大眼惊讶 / smug 半睁眼撇嘴。
       * 判定顺序：负面→smug，疑问因果→smug，感叹强调→surprise，其余 happy。
       * 中性段全给 happy，靠眨眼和动作层提供"活气"——
       * 陈述句上硬插惊讶脸反而假。 */
      if (hasFace('happy')) {
        const ok = k => hasFace(k)
        if (explicit && ok(explicit)) return explicit
        if (seg && seg.card) return 'happy'
        if (i === 0 || i === n - 1) return 'happy'
        if (/翻车|失败|报错|不行|炸了|崩|挂|全没了|白干|难|累|穷|哭|装死|断电|堵|忘|丢/.test(t)) return 'smug'
        if (/[？?]|为什么|是不是|琢磨|想不通|估计|也许|怎么办|因为|所以|于是|本来|其实|有人问/.test(t)) return 'smug'
        if (/[！!]|终于|居然|竟然|第一次|字面意思|才敢|全是我自己|最长|最堵|最繁华|全是/.test(t)) return 'surprise'
        return 'happy'
      }

      if (explicit && vids[explicit]) return explicit
      /* happy 被停用时退回 idle —— 别让被切过的头发出现在画面里 */
      const pick = c => {
        const k = (c === 'happy' && !HAPPY_OK) ? 'idle' : c
        return vids[k] ? k : 'idle'
      }

      if (seg && seg.card) return pick('happy')
      if (i === 0) return pick('happy')
      if (i === n - 1) return pick('happy')

      if (/翻车|失败|报错|不行|炸了|崩|挂|全没了|白干|难|累|穷|哭|装死|断电/.test(t)) {
        neutral = 0
        return pick('sad')
      }
      /* thinking 是唯一睁着眼睛的一组，视觉上和闭眼的拉开差距，
       * 所以"解释/追问"这类最该用它，别只认问号 */
      if (/[？?]|为什么|是不是|琢磨|想不通|估计|也许|怎么办|因为|所以|于是|本来|其实|对，|有人问/.test(t)) {
        neutral = 0
        return pick('thinking')
      }
      if (/[！!]|终于|居然|竟然|第一次|字面意思|才敢|全是我自己/.test(t)) {
        neutral = 0
        return pick('happy')
      }

      /* 中性段落：idle、idle、thinking 循环，约每 9 秒换一次眼睛 */
      const c = neutral % 3 === 2 ? 'thinking' : 'idle'
      neutral++
      return pick(c)
    },

    /**
     * 打一帧同步标记，让 make.mjs 能在录像里精确定位"正片第一帧"。
     * 为什么需要：录屏的 t=0 不是 newPage 那一刻，也不是 first-paint
     * （实测 headless 里 first-paint 报在页面基本画完之后，差 0.09s，
     *  拿它切头等于没切）。唯一可靠的办法是往画面里塞一个能被机器认出的
     * 标记，然后在 ffmpeg 里逐帧找它。
     * 标记停留 SYNC_LEAD 秒后消失，再过两帧才开演 —— 这样标记不会被录进正片。
     * @returns {Promise<number>} 标记起点到正片起点的秒数
     */
    async markStart() {
      /* 🔴 先等录屏真正跑起来。以前标记只停 0.15s，靠皮套素材加载那两秒"垫"着
       * 才录得到；改成静图之后页面秒开，标记在第一帧被采集之前就消失了，
       * make.mjs 找不到标记 → 不切头 → 音画整体错位。
       * 现在：先等 300ms，再停 400ms，并用页面时钟实测"标记起点→正片起点"。 */
      await new Promise(r => setTimeout(r, 300))
      const t0 = performance.now()
      const d = document.createElement('div')
      d.id = 'syncMark'
      d.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;' +
        'background:#FF00FF;z-index:9999;pointer-events:none'
      document.body.appendChild(d)
      await new Promise(r => setTimeout(r, 400))
      d.remove()
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      /* 实测值（含两帧 rAF 的延迟），不写常数 */
      const lead = (performance.now() - t0) / 1000
      window.__SYNC_LEAD__ = lead
      return lead
    },

    get current() { return cur },
  }
})()
