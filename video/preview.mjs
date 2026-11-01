/* video/preview.mjs —— 模板静态预览（调版式用，不录视频）
 * ═══════════════════════════════════════════════════════════════
 * 录一条 80 秒的片子要 100 秒，改一版版式等两分钟太慢。
 * 这个工具把 dur 压到 6 秒、不录视频，直接截 3 张图（开场/中段/结尾），
 * 几秒钟就能看出构图对不对。
 *
 * 用法：
 *   node video/preview.mjs                    # 用 _script.json
 *   node video/preview.mjs path/to/script.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../core/log.mjs'
import { readConfig } from '../core/shell.mjs'
import { getType } from './types.mjs'
import { petPayload } from './pet-assets.mjs'

const cfg = readConfig()
const scriptFile = process.argv[2] || path.join(ROOT, '_script.json')
const s = JSON.parse(fs.readFileSync(scriptFile, 'utf8'))
const type = getType(process.argv[3] || 'diary')

const OUT = path.join(ROOT, 'video', 'out', '_preview')
fs.mkdirSync(OUT, { recursive: true })

/* 压到 6 秒：段落全部塞进 6 秒里依次点亮，能一次看到"满屏"的状态 */
const DUR = 6

const browser = await chromium.launch({ channel: cfg.chrome?.channel || 'chrome', headless: true })
const ctx = await browser.newContext({
  viewport: { width: type.width, height: type.height },
  deviceScaleFactor: 1,
})
const page = await ctx.newPage()
const errs = []
page.on('pageerror', e => errs.push(String(e).slice(0, 200)))
await page.goto('file:///' + path.join(ROOT, 'video', 'templates', type.id, 'index.html').replace(/\\/g, '/'))

const payload = {
  day: Number.isFinite(Number(s.day)) ? Number(s.day) : 1,
  journalTitle: s.journalTitle || '日记',
  segments: s.segments,
  pet: petPayload(cfg),
  petImage: s.petImage || 'file:///D:/Workplace/zhibo/assets/pet2-still.png',
  dur: DUR,
}
await page.evaluate(d => { const fn = window.__CARDA__ || window.__DIARY__; fn(d) }, payload)

const shots = []
for (const [i, frac] of [[1, 0.25], [2, 0.6], [3, 0.95]]) {
  await page.waitForTimeout(Math.max(300, DUR * 1000 * frac - (i - 1) * DUR * 1000 * 0.3))
  const f = path.join(OUT, `${type.id}-p${i}.png`)
  await page.screenshot({ path: f })
  shots.push(f)
}
if (errs.length) console.log('⚠ 模板报错:', errs.join(' | '))
else console.log('无报错')
console.log(shots.join('\n'))
await browser.close()
