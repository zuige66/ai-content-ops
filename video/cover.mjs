/* video/cover.mjs —— 封面生成（左皮套 + 右超级标题，透视 + 景深）
 * ═══════════════════════════════════════════════════════════════
 * 和出片同一套思路：HTML/CSS 排版 → 无头浏览器截图 → ffmpeg 缩放。
 * 零 token、零 AI 绘图，改一行字就能重出，比找设计师快得多。
 *
 * 为什么截 2 倍再缩回 1920：
 *   1 倍截图的中文字边缘是硬的（没有次像素抗锯齿），缩回来看得出毛刺。
 *   2 倍截 + Lanczos 缩到 1920，等于做了一次高质量降采样，字口干净。
 *
 * 用法：
 *   node video/cover.mjs                          # 用 _script.json
 *   node video/cover.mjs path/to/script.json
 *   node video/cover.mjs --big "白饭不够吃" --sub "一句话副标题" --day 3
 *   node video/cover.mjs --out video/out/cover.png --scale 1
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import ffmpegPath from 'ffmpeg-static'
import { ROOT } from '../core/log.mjs'
import { readConfig, run } from '../core/shell.mjs'
import { petPayload } from './pet-assets.mjs'

const W = 1920, H = 1080
const TPL = path.join(ROOT, 'video', 'templates', 'cover', 'index.html')
/**
 * @param {object} o
 * @param {string} o.big     超级标题（6-10 字最好）
 * @param {string} [o.sub]   副标题
 * @param {number} [o.day]
 * @param {string} [o.out]   输出 png 路径
 * @param {number} [o.scale] 采样倍数，默认 2
 */
export async function makeCover(o = {}) {
  const cfg = readConfig()
  const pet = petPayload(cfg)
  const out = path.resolve(o.out || path.join(ROOT, 'video', 'out', 'cover.png'))
  fs.mkdirSync(path.dirname(out), { recursive: true })

  const browser = await chromium.launch({ channel: cfg.chrome?.channel || 'chrome', headless: true })
    .catch(() => chromium.launch({ channel: 'msedge', headless: true }))
  let raw
  try {
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: Math.max(1, Math.min(3, Number(o.scale) || 2)),
    })
    const page = await ctx.newPage()
    const errs = []
    page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
    await page.goto('file:///' + TPL.replace(/\\/g, '/'))
    await page.evaluate(d => window.__COVER__(d), {
      big: o.big || '',
      sub: o.sub || '',
      day: Number.isFinite(Number(o.day)) ? Number(o.day) : 1,
      brand: o.brand || '红烧鱼日记',
      pet: pet.still,
    })
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 })
      .catch(() => { throw new Error('封面模板没就绪' + (errs.length ? '：' + errs[0] : '')) })
    raw = path.join(path.dirname(out), '_cover_raw.png')
    await page.screenshot({ path: raw })
    await ctx.close()
  } finally {
    await browser.close()
  }

  /* 2 倍图 → Lanczos 缩到 1920×1080 */
  const r = await run(ffmpegPath, [
    '-y', '-i', raw,
    '-vf', `scale=${W}:${H}:flags=lanczos`,
    '-frames:v', '1', out,
  ], { timeoutMs: 60000 })
  fs.existsSync(raw) && fs.unlinkSync(raw)
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error('封面缩放失败：' + r.stderr.slice(-300))
  return { png: out, width: W, height: H, kb: Math.round(fs.statSync(out).size / 1024) }
}

/* ── CLI ── */
if (import.meta.url === 'file:///' + process.argv[1].replace(/\\/g, '/')) {
  const args = process.argv.slice(2)
  const get = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }
  const scriptFile = args.find(a => !a.startsWith('--') && a.endsWith('.json'))
  let s = {}
  if (scriptFile) s = JSON.parse(fs.readFileSync(scriptFile, 'utf8'))
  else if (fs.existsSync(path.join(ROOT, '_script.json'))) s = JSON.parse(fs.readFileSync(path.join(ROOT, '_script.json'), 'utf8'))

  const res = await makeCover({
    big: get('big') || s.coverText || s.journalTitle || '红烧鱼日记',
    sub: get('sub') || s.title || (s.segments && s.segments[0] && s.segments[0].text) || '',
    day: get('day') ?? s.day,
    out: get('out'),
    scale: get('scale'),
  })
  console.log(`封面：${res.png}（${res.width}×${res.height}，${res.kb}KB）`)
}
