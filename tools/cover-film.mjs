/* tools/cover-film.mjs —— 纸墨风统一封面，一次出三张
 * ═══════════════════════════════════════════════════════════════
 * 2026-11-03 起，**日报（大肥鱼日记）和 GitHub 项目推荐共用这一套封面**。
 * 版式是 cover-day1 的 v2（左字右鱼 + DAY 实心徽章），主人认可的；
 * 这次只加了 kicker —— 项目视频在 DAY 后面补一行「GITHUB 项目推荐」。
 *
 * 三张比例各有各的用途，**不能互相裁**：
 *   cover.png      1920×1080  16:9  视频片头 / 通用
 *   cover-4x3.png  1440×1080   4:3  抖音「设置横封面」
 *   cover-3x4.png   810×1080   3:4  抖音「设置竖封面」（信息流主位）
 *
 * 🔴 抖音横封面是 4:3，不是 16:9。传 16:9 平台盖 4:3 裁剪框、默认居中，
 *    左右各切 12%，大字被砍成「sh-G」。所以必须按 4:3 单独排版。
 *
 * 用法：
 *   node tools/cover-film.mjs --day 1 --big 七天账本 --sub 五十碗饭 \
 *        --stat "26 场直播 · 1007 音浪 · 第一次炒股被禁 1 天" \
 *        --stat3x4 "26 场直播 · 1007 音浪|第一次炒股，被禁 1 天" \
 *        --out video/out/day1
 *
 *   node tools/cover-film.mjs --day 1 --kicker "GITHUB 项目推荐" \
 *        --big dsh-Go --sub "安卓手机跑 Ubuntu" --stat "5.4k star · 八天 · AGPL-3.0" \
 *        --out video/out/day1-dshgo
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../core/log.mjs'
import { readConfig } from '../core/shell.mjs'

const args = process.argv.slice(2)
const get = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }

const TPL = path.join(ROOT, 'video', 'templates', 'cover-paper', 'index.html')
const abs = p => {
  if (!p) return ''
  const s = String(p)
  if (/^(file:|https?:|data:)/.test(s)) return s
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'file:///' + s.replace(/\\/g, '/')
  return 'file:///' + path.join(ROOT, s).replace(/\\/g, '/')
}

const cfg = readConfig()
const pet = abs(get('pet') || cfg.video?.petFaces?.happy || cfg.video?.petImage || '')

const big = get('big')
if (!big) {
  console.error('缺 --big（封面上那行大字，2~6 字最好）')
  process.exit(1)
}

const DATA = {
  day: get('day') || 'DAY 1',
  kicker: get('kicker') || '',
  big,
  sub: get('sub') || '',
  /* 竖版一行放不下会被鱼压住，用 `|` 给竖版单独断行 */
  stat: get('stat') || '',
  stat3x4: get('stat3x4') || get('stat') || '',
  pet,
}

const outDir = get('out') || path.join(ROOT, 'video', 'out', 'covers')
fs.mkdirSync(outDir, { recursive: true })

const SIZES = [
  { size: '16x9', w: 1920, h: 1080, file: 'cover.png' },
  { size: '4x3', w: 1440, h: 1080, file: 'cover-4x3.png' },
  { size: '3x4', w: 810, h: 1080, file: 'cover-3x4.png' },
]

const browser = await chromium.launch({ channel: cfg.chrome?.channel || 'chrome', headless: true })
  .catch(() => chromium.launch({ channel: 'msedge', headless: true }))

let bad = 0
for (const s of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(String(e).slice(0, 160)))
  await page.goto('file:///' + TPL.replace(/\\/g, '/'))
  await page.evaluate((d) => window.__COVER__(d), {
    ...DATA,
    size: s.size,
    stat: s.size === '3x4' ? DATA.stat3x4 : DATA.stat,
  })
  /* 等字体 + 立绘解码，不然截出来是半截空白 */
  await page.waitForFunction(() => Array.from(document.images).every(im => im.complete), null, { timeout: 15000 })
    .catch(() => { })
  await page.waitForTimeout(420)

  /* 🔴 溢出检测：主字/副标题超框会被裁掉，缩略图上才发现就晚了 */
  const over = await page.evaluate(() => {
    const out = []
    for (const id of ['big', 'sub', 'day', 'kicker', 'stat']) {
      const el = document.getElementById(id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.right > innerWidth + 1 || r.left < -1 || r.bottom > innerHeight + 1) {
        out.push(`${id} 超框 right=${Math.round(r.right)}/${innerWidth} bottom=${Math.round(r.bottom)}/${innerHeight}`)
      }
    }
    return out
  })
  if (over.length) { bad++; console.log(`  ⚠ ${s.size} 溢出：` + over.join('；')) }
  if (errs.length) { bad++; console.log(`  ⚠ ${s.size} 报错：` + errs.join(' | ')) }

  const f = path.join(outDir, s.file)
  await page.screenshot({ path: f })
  console.log(`  ${s.size.padEnd(5)} ${String(s.w).padStart(4)}×${s.h}  ${s.file}`)
  await ctx.close()
}
await browser.close()
console.log('\n输出目录：' + path.relative(ROOT, outDir))
if (bad) { console.log('⚠ 有告警，逐张打开看一遍再收工'); process.exit(2) }
