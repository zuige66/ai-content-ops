/* video/make.mjs —— 视频闭环：文案 → TTS → 网页动画录屏 → ffmpeg 合成
 * ═══════════════════════════════════════════════════════════════
 * 为什么 token 便宜：内容是 DSH/人写的一页 HTML，录制/合成全是本地零 token。
 * 流程：
 *   1. ttsSynth(旁白) → voice.mp3 + 精确时长 dur（zhibo 的 tts.py 会返回）
 *   2. Playwright 开模板页（竖屏 recordVideo）→ 注入数据 → 等 __DONE__
 *   3. ffmpeg：webm + mp3 合成 mp4（音频 apad 到视频长度），抽关键帧
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import ffmpegPath from 'ffmpeg-static'
import { ROOT, logEvent } from '../core/log.mjs'
import { readConfig, ttsSynth, run } from '../core/shell.mjs'
import { getType } from './types.mjs'
import { petPayload } from './pet-assets.mjs'

const OUT = path.join(ROOT, 'video', 'out')

/* 用 segments 数据结构的模板（都是「气泡流」这一族）。
 * card 是老的自介绍卡，吃的是 lines，不走这套。 */
const SEG_TEMPLATES = new Set(['diary', 'talk'])

/* 气泡末尾不挂标点（每条都顶个「。」视觉上很重），但配音必须有停顿，
 * 不然二十几段会连成一口气读下来。所以：显示去掉句尾标点，拼旁白用「。」接。 */
const stripTail = s => String(s || '').replace(/[。！？!?；;，,、\s]+$/g, '')
function joinNarration(segments, lines) {
  if (segments) {
    const parts = segments.map(s => stripTail(s.text)).filter(Boolean)
    if (parts.length) return parts.join('。') + '。'
  }
  return lines.join('。')
}

/* 弹幕时间轴：优先用 TTS 给的逐句时间戳，拿不到再退回字数比例。
 *
 * 🔴 为什么要改：以前是「按字数把总时长摊给每段」，但中文 TTS 的停顿
 * （句号处 0.35 秒）完全不含在字数里，短句被严重高估。实测第一条弹幕
 * 比配音晚 1.5 秒，越往后越乱，观众的感受就是「声音先出来、弹幕后到」。
 * edge-tts 的 SentenceBoundary 免费给逐句 offset，用它才对得准。
 */
function buildStarts(segments, marks) {
  if (!segments || !marks || !marks.length) return null
  const spoken = segments.filter(s => s && !s.card && String(s.text || '').trim())
  /* 句数对不上就别硬对 —— 可能是老版本 tts.py 没返回时间戳，
   * 或者文案里混了 TTS 会额外断句的写法，交给字数比例兜底更安全 */
  if (spoken.length !== marks.length) return null
  const out = []
  let mi = 0
  for (const s of segments) {
    if (s && !s.card && String(s.text || '').trim()) {
      out.push(+(marks[mi].t / 1000).toFixed(3))
      mi++
    } else {
      /* 信息卡没有配音，得给它找一段属于自己的空档。
       * 🔴 不能直接用「下一句开始的时间」—— 那句自己也在那个时刻上屏，
       * 卡片刚加进去就被顶掉，实测只存在 1 毫秒，等于没出现。
       * 取前后两句的中点：前一句念到一半时卡片浮上来，一直停到下一句开口。 */
      const prev = out.length ? out[out.length - 1] : 0
      const next = mi < marks.length ? marks[mi].t / 1000 : prev + 2.4
      out.push(+((prev + next) / 2).toFixed(3))
    }
  }
  return out
}

/**
 * 在录像里找模板打的同步标记（左上角 24×24 纯品红），返回它出现的秒数。
 *
 * 为什么要这么麻烦：录屏的 t=0 既不是 newPage（晚约 0.8s），也不是
 * first-paint（headless 里首帧上报晚到离谱，实测只差 0.09s），
 * 用哪个都会让音画错开半秒到一秒。唯一稳的办法是往画面里塞一个
 * 机器能认的标记，再逐帧去找它。
 *
 * 做法：裁左上角 24×24 → 缩成 1×1 → 抽成 30fps 的 rgb24 裸流，
 * 每帧 3 字节，扫到第一个"红高、绿低、蓝高"的帧就是。
 */
async function findSyncSec(webm, dir) {
  const raw = path.join(dir, '_sync.rgb')
  const r = await run(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', webm,
    '-vf', 'crop=24:24:0:0,scale=1:1:flags=area', '-r', '30',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw,
  ], { timeoutMs: 180000 })
  try {
    if (r.code !== 0 || !fs.existsSync(raw)) return -1
    const b = fs.readFileSync(raw)
    for (let i = 0; i + 3 <= b.length; i += 3) {
      if (b[i] > 140 && b[i + 1] < 110 && b[i + 2] > 140) return i / 3 / 30
    }
    return -1
  } finally {
    try { fs.unlinkSync(raw) } catch (e) { /* 删不掉就算了 */ }
  }
}

export async function makeVideo(job, { step }) {
  const cfg = readConfig()
  const p = job.params
  const title = String(p.title || '大家好，我是红烧鱼').slice(0, 60)
  const lines = (Array.isArray(p.lines) ? p.lines : []).map(s => String(s).slice(0, 80)).slice(0, 6)
  /* 🔴 这里原来是 slice(0, 24)。写第 25 段开始就被静默丢掉 —— 连配音都
   * 一起丢（narration 也是从这份 segments 拼的），成片少一句话，日志上
   * 完全看不出来。80 秒的片子 40 段都装得下，别在这里做减法。 */
  const segments = Array.isArray(p.segments) ? p.segments.slice(0, 60) : null
  const narration = String(
    p.narration || joinNarration(segments, lines) || title,
  ).slice(0, 1200)
  /* 画幅跟着「视频类型」走，不再写死 config —— 竖屏日记和横屏鱼说不是一个尺寸 */
  const type = getType(p.template)
  const W = type.width, H = type.height
  step(`版式：${type.name}（${W}×${H}）`)

  const dir = path.join(OUT, job.id)
  fs.mkdirSync(dir, { recursive: true })

  /* 1. 配音：时长拿得死死的，动画就按它对齐 */
  step(`TTS 合成配音（${narration.length} 字）`)
  const { dur, marks } = await ttsSynth(narration, path.join(dir, 'voice.mp3'))
  if (!dur || dur <= 0) throw new Error('tts.py 没返回时长，动画没法对齐')
  step(`配音 ${dur.toFixed(1)}s${marks.length ? `（${marks.length} 句时间戳）` : '（无时间戳，退回字数分配）'}`)

  /* 2. 录网页动画 */
  step('打开模板页录制')
  /* dur 是 tts.py 按字节估的（误差 1% 左右）。有逐句时间戳就用最后一句的
   * 收尾时刻兜一下，别让画面比配音短、把最后一句吃掉。 */
  const marksEnd = marks.length ? Math.max(...marks.map(m => (m.t + m.d) / 1000)) : 0
  const total = +(Math.max(dur, marksEnd + 0.3) + 0.8).toFixed(2)   // +0.8s 收尾持住
  /* 🔴 --allow-file-access-from-files 不是可选项。
   * 模板页是 file:// 打开的，表情图也是 file://。浏览器把 file:// 当
   * 「跨源」，WebGL 的 texImage2D 会直接拒收（报 cross-origin data），
   * 皮套就悄悄退回「叠图 + CSS」那条老路 —— 画面上看不出报错，
   * 只是动效全没了。原型验证时就是靠这个 flag 才跑通的。 */
  const browser = await chromium.launch({
    channel: cfg.chrome?.channel || 'chrome',
    headless: true,
    args: ['--allow-file-access-from-files'],
  })
    .catch(async e => {
      step('Chrome 启动失败，降级 Edge：' + String(e).slice(0, 80))
      return chromium.launch({
        channel: 'msedge',
        headless: true,
        args: ['--allow-file-access-from-files'],
      })
    })
  let webm
  let headSec = 0
  let syncLead = 0.15
  try {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      recordVideo: { dir, size: { width: W, height: H } },
    })
    /* 录像从 newPage 就开始，皮套素材加载的那一两秒也会被录进去。
     * 切头不靠墙钟 —— 录像的 t=0 既不是 newPage 也不是 first-paint，
     * 只能靠模板打的那块品红标记去画面里找（见 findSyncSec）。 */
    const page = await ctx.newPage()
    /* 模板 JS 出错会让 __DONE__ 永远不置位，最后只看到一句 timeout —— 把
     * 真实错误打出来，不然得靠猜 */
    const pageErrs = []
    page.on('pageerror', e => pageErrs.push(String(e).slice(0, 200)))
    /* 皮套降级是「安静失败」：画面还在，只是动效退回 CSS 版，
     * 录出来完全看不出异常，只有日志里能发现。所以把 warn 提上来。 */
    page.on('console', m => {
      const t = m.text()
      if (m.type() === 'warning' && /petgl|皮套/.test(t)) step('⚠ ' + t.slice(0, 160))
    })
    await page.goto('file:///' + path.join(ROOT, 'video', 'templates', type.id, 'index.html').replace(/\\/g, '/'))
    // 模板各自的入口函数不一样（card=__CARDA__ / 气泡流=__DIARY__），数据结构也不同
    const segOut = (segments || lines.map(t => ({ text: t }))).map(s =>
      s.card ? { card: { title: String(s.card.title || '').slice(0, 20), big: String(s.card.big || '').slice(0, 12), small: String(s.card.small || '').slice(0, 30) } }
             : { text: stripTail(s.text).slice(0, 60) })
    const segStarts = buildStarts(segOut, marks)
    const payload = SEG_TEMPLATES.has(type.id)
      ? {
          day: Number.isFinite(Number(p.day)) ? Number(p.day) : 1,
          journalTitle: String(p.journalTitle || '日记').slice(0, 20),
          /* 🔴 这里以前是 slice(0,24) —— 会把写好的长句静默砍掉。气泡能装
           * 两三行，60 字足够，别在注入环节做减法。 */
          segments: segOut,
          /* 每段的上屏时刻（秒），null 表示拿不到时间戳、模板自己按字数分 */
          starts: segStarts,
          pet: petPayload(cfg),
          petImage: p.petImage ? 'file:///' + path.resolve(p.petImage).replace(/\\/g, '/') : '',
          dur: total,
        }
      : { title, lines, narration, tag: p.tag, dur: total }
    await page.evaluate(d => { const fn = window.__CARDA__ || window.__DIARY__; fn(d) }, payload)
    /* 入口函数是 async 的：等皮套挂载完、正片真正开演 */
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 90000 })
      .catch(() => {})   // 老模板没有 __READY__，那就按 0 处理
    /* 模板自己会报「标记起点 → 正片起点」隔了多少秒，拿它把两者对齐 */
    syncLead = Number(await page.evaluate(() => window.__SYNC_LEAD__).catch(() => 0)) || 0.15
    /* 🔴 waitForFunction 的第二个参数是 arg，不是 options ——
     * 以前写成 (fn, {timeout}) 会被当成 arg 吞掉，超时永远是默认 30 秒，
     * 于是任何超过 30 秒的片子必然 timeout。options 必须放第三位。 */
    try {
      await page.waitForFunction('window.__DONE__ === true', null, { timeout: (total + 60) * 1000 })
    } catch (e) {
      throw new Error(`录制超时（${total}s 的片子没等到 __DONE__）` +
        (pageErrs.length ? `；模板报错：${pageErrs.slice(0, 2).join(' | ')}` : '；模板没报错，可能是动画没跑完'))
    }
    webm = await page.video().path()
    await ctx.close()      // 关了才有完整文件
  } finally {
    await browser.close()
  }

  /* 在录像里找同步标记，定位正片第一帧 */
  const markSec = await findSyncSec(webm, dir)
  headSec = markSec >= 0 ? markSec + syncLead : 0
  step(markSec >= 0
    ? `录制完成（切掉 ${headSec.toFixed(2)}s 准备时间），合成 mp4`
    : '录制完成（没找到同步标记，按不切头处理），合成 mp4')

  /* 3. ffmpeg 合成：视频 + 配音（apad 补齐到视频长，-shortest 尾巴对齐） */
  const mp4 = path.join(dir, 'video.mp4')
  /* 头部 trim 用滤镜做（帧级精确）：-ss 放输入前是按关键帧跳，会差好几帧。
   * 音频从 0 开始，所以只能切视频，不能整体 seek。 */
  const vf = headSec > 0.05
    ? ['-vf', `trim=start=${headSec.toFixed(3)},setpts=PTS-STARTPTS`]
    : []
  const r = await run(ffmpegPath, [
    '-y', '-i', webm, '-i', path.join(dir, 'voice.mp3'),
    ...vf,
    /* 🔴 以前是 -r 30 + preset veryfast（默认 crf 23）：录屏其实是 25fps，
     * 25→30 是重采样，动作会一顿一顿；crf 23 在 1080p 下只有 1.7Mbps，
     * 皮套边缘被压出彩色毛边。现在 25fps 对齐、crf 18 保边。 */
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-profile:v', 'high', '-r', '25',
    '-c:a', 'aac', '-b:a', '128k', '-af', 'apad', '-shortest',
    /* 🔴 录屏在 __DONE__ 之后还会继续录一秒左右（取文件路径 + 关上下文），
     * 那一段是静止画面。不按 total 截断，成片尾巴就多出一秒不动。 */
    '-t', String(total),
    mp4,
  ], { timeoutMs: 600000 })
  if (r.code !== 0 || !fs.existsSync(mp4) || fs.statSync(mp4).size < 10000) {
    throw new Error('ffmpeg 合成失败：' + r.stderr.slice(-400))
  }

  /* 4. 关键帧：均匀抽 4 张 + 首尾，给人看效果、给 DSH 当预览 */
  const kfs = []
  const stamps = [0.5, total * 0.3, total * 0.6, total * 0.95]
  for (let i = 0; i < stamps.length; i++) {
    const kf = path.join(dir, `frame-${i + 1}.png`)
    await run(ffmpegPath, ['-y', '-ss', String(stamps[i]), '-i', mp4, '-frames:v', '1', kf], { timeoutMs: 60000 })
    if (fs.existsSync(kf)) kfs.push(kf)
  }

  /* 5. 收拾现场：page@*.webm 是 Playwright 的原始录屏，纯中间产物 ——
   *    90 秒的片子能占 45MB，合成完再没有任何代码读它。
   *    不删的话 video/out 每出一片胖一倍，很快就分不清哪个是成片。
   *    想留原片调试模板的话，config.json 里 video.keepRawRecording = true。 */
  if (cfg.video?.keepRawRecording !== true) {
    try { fs.unlinkSync(webm) } catch { /* 删不掉不影响成片，别在这儿抛错 */ }
  }

  logEvent('video', 'make.done', { ok: true, jobId: job.id, mp4, dur: total, kb: Math.round(fs.statSync(mp4).size / 1024) })
  return { mp4, dir, dur: total, keyframes: kfs, title, narration }
}
