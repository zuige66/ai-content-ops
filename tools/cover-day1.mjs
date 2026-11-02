/* tools/cover-day1.mjs —— Day1 纸墨封面，一次出三张
 * ═══════════════════════════════════════════════════════════════
 * 三张比例各有各的用途，**不能互相裁**：
 *   cover.png      1920×1080  16:9  视频片头 / 通用
 *   cover-4x3.png  1440×1080   4:3  抖音「设置横封面」
 *   cover-3x4.png   810×1080   3:4  抖音「设置竖封面」（信息流主位）
 *
 * 🔴 踩过的坑（.workbuddy-ai/memory/2026-11-02.md）：
 *    抖音横封面是 4:3，不是 16:9。传 16:9 平台盖 4:3 裁剪框、默认居中，
 *    左右各切 12%，大字被砍成「sh-G」。所以必须按 4:3 单独排版。
 *
 * 用法：
 *   node tools/cover-day1.mjs
 *   node tools/cover-day1.mjs --out video/out/day1
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../core/log.mjs'
import { readConfig } from '../core/shell.mjs'

const args = process.argv.slice(2)
const get = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }

const TPL = path.join(ROOT, 'video', 'templates', 'cover-day1', 'index.html')
const abs = p => {
  if (!p) return ''
  const s = String(p)
  if (/^(file:|https?:|data:)/.test(s)) return s
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'file:///' + s.replace(/\\/g, '/')
  return 'file:///' + path.join(ROOT, s).replace(/\\/g, '/')
}

const cfg = readConfig()
const pet = abs(cfg.video?.petFaces?.happy || cfg.video?.petImage || '')

/* 封面文案。改这里就够了 —— 三张图共用同一份数据，各自排版。 */
const DATA = {
  day: 'DAY 1',
  big: '七天账本',
  sub: '五十碗饭',
  /* `|` 断行：竖版一行放不下，会被鱼压住。横版一行读得完，不用断。
   * 🔴 封禁原因是这张封面的钩子 —— 别只写「被禁 1 天」，观众不知道她干了啥。 */
  stat: '26 场直播 · 1007 音浪 · 第一次炒股被禁 1 天',
  stat3x4: '26 场直播 · 1007 音浪|第一次炒股，被禁 1 天',
  pet,
}

const outDir = get('out') || path.join(ROOT, 'video', 'out', 'day1')
fs.mkdirSync(outDir, { recursive: true })

const SIZES = [
  { size: '16x9', w: 1920, h: 1080, file: 'cover.png' },
  { size: '4x3', w: 1440, h: 1080, file: 'cover-4x3.png' },
  { size: '3x4', w: 810, h: 1080, file: 'cover-3x4.png' },
]

const browser = await chromium.launch({ channel: cfg.chrome?.channel || 'chrome', headless: true })
for (const s of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', e => errs.push(String(e).slice(0, 160)))
  await page.goto('file:///' + TPL.replace(/\\/g, '/'))
  await page.evaluate((d) => window.__COVER__(d), {
    ...DATA,
    size: s.size,
    /* 竖版用两行的数据条 */
    stat: s.size === '3x4' ? DATA.stat3x4 : DATA.stat,
  })
  await page.waitForTimeout(400)   // 等字体和立绘解码
  const f = path.join(outDir, s.file)
  await page.screenshot({ path: f })
  if (errs.length) console.log(`⚠ ${s.size}:`, errs.join(' | '))
  console.log(`${s.size.padEnd(5)} ${s.w}×${s.h}  ${s.file}`)
  await ctx.close()
}
await browser.close()
console.log('\n输出目录：' + outDir)
