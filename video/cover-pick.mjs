/* video/cover-pick.mjs —— 项目推荐系列的封面出图
 * ═══════════════════════════════════════════════════════════════
 * 和 cover.mjs 分开，不是重复造轮子：那套是「日记体」的横屏封面
 * （左皮套 + 右超级标题），这套是「项目推荐」的竖屏封面
 * （三层景深 + 项目截图 + 大肥鱼）。两套的尺寸、配色、构图全不一样，
 * 塞进一个文件里会变成一堆 if。
 *
 * 用法：
 *   node video/cover-pick.mjs --big dsh-Go --sub 一周四千星 --star 4.4k --starNote 一周
 *   node video/cover-pick.mjs --shot video/assets/dsh-go/01-hero.webp --out video/out/cover/dsh-go.png
 *
 * 默认景深墙用 assets 目录里所有功能图，缺图就用 hero 自己铺。
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import ffmpegPath from 'ffmpeg-static'
import { ROOT } from '../core/log.mjs'
import { readConfig, run } from '../core/shell.mjs'

const W = 1920, H = 1080
const TPL = path.join(ROOT, 'video', 'templates', 'cover-pick', 'index.html')
const fileUrl = (p) => 'file:///' + path.resolve(p).replace(/\\/g, '/')

/**
 * @param {object} o
 * 画幅：1920×1080 横屏（2026-11-02 定，全系列默认横屏，不再出竖屏）
 *
 * @param {string} o.big        第一行大字（项目名，≤6 字最好）
 * @param {string} o.sub        第二行（结果，≤6 字）
 * @param {string} [o.star]     星标数字，如 '4.4k'
 * @param {string} [o.starNote] 星标后缀，如 '一周'
 * @param {string} [o.shot]     中景那张清晰截图
 * @param {string[]} [o.wall]   远景墙用的图（缺省 = shot 重复铺）
 * @param {string} [o.pet]      大肥鱼立绘
 * @param {string} [o.out]      输出 png
 * @param {number} [o.scale]    采样倍数，默认 2
 */
export async function makeCoverPick(o = {}) {
  const cfg = readConfig()
  const pet = o.pet || cfg.video?.petFaces?.happy || cfg.video?.petImage
  if (!pet) throw new Error('没有大肥鱼立绘：config.video.petFaces.happy 是空的')

  const shot = path.resolve(o.shot || path.join(ROOT, 'video', 'assets', 'dsh-go', '01-hero.webp'))
  /* 远景墙：优先用传入的，否则拿 shot 平铺四次。
     单图铺满虽然单调，但糊到 26px 之后本来就只剩色块，够用。 */
  const wall = (o.wall && o.wall.length ? o.wall : [shot, shot, shot, shot]).map(fileUrl)

  const out = path.resolve(o.out || path.join(ROOT, 'video', 'out', 'cover', `pick-${Date.now()}.png`))
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
    await page.evaluate(d => window.__COVERPICK__(d), {
      big: o.big || '',
      sub: o.sub || '',
      star: o.star || '',
      starNote: o.starNote || '',
      shot: fileUrl(shot),
      wall,
      pet: fileUrl(pet),
    })
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 })
      .catch(() => { throw new Error('封面模板没就绪' + (errs.length ? '：' + errs[0] : '')) })
    raw = path.join(path.dirname(out), '_pick_raw.png')
    await page.screenshot({ path: raw })
    await ctx.close()
  } finally {
    await browser.close()
  }

  /* 2 倍图 → Lanczos 缩回目标尺寸。直接 1 倍截的话中文字边缘是硬的。 */
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
  const res = await makeCoverPick({
    big: get('big') || 'dsh-Go',
    sub: get('sub') || '一周四千星',
    star: get('star') || '',
    starNote: get('starNote') || '一周',
    shot: get('shot'),
    out: get('out'),
    scale: get('scale'),
  })
  console.log(`封面：${res.png}（${res.width}×${res.height}，${res.kb}KB）`)
}
