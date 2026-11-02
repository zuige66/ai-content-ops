/* tools/cover.mjs —— 一次出三张封面（16:9 / 4:3 / 3:4）
 * ═══════════════════════════════════════════════════════════════
 * 抖音横封面是 4:3、竖封面是 3:4，视频是 16:9。
 * 拿 16:9 去裁 4:3 会切掉左右各 12%，封面大字直接砍成「sh-G」；
 * 裁 3:4 只剩中间一条。三个比例必须各自排版。
 *
 * 用法：
 *   node tools/cover.mjs                          # 用最新脚本，输出到 video/out/covers/<slug>/
 *   node tools/cover.mjs --script video/scripts/_script_dsh-go.json
 *   node tools/cover.mjs --out video/out/pick-1793622590797
 *
 * 产物：
 *   cover.png      1920×1080  16:9  视频片头 / 封面源
 *   cover-4x3.png  1440×1080   4:3  抖音「设置横封面」
 *   cover-3x4.png   810×1080   3:4  抖音「设置竖封面」（信息流主位）
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../core/log.mjs'
import { readConfig } from '../core/shell.mjs'

const args = process.argv.slice(2)
const get = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }

const TPL = path.join(ROOT, 'video', 'templates', 'cover-multi', 'index.html')
const ROOT_URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/'

const abs = p => {
  if (!p) return ''
  const s = String(p)
  if (/^(file:|https?:|data:)/.test(s)) return s
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'file:///' + s.replace(/\\/g, '/')
  return ROOT_URL + s.replace(/^[.\/\\]+/, '').replace(/\\/g, '/')
}

const scriptPath = get('script') || path.join(ROOT, 'video', 'scripts', '_script_dsh-go.json')
const data = JSON.parse(fs.readFileSync(scriptPath, 'utf8'))

const [bigRaw, subRaw] = String(data.coverText || '').split('|')
const big = String(bigRaw || '').trim()
const sub = String(subRaw || '').trim()
if (!big) { console.error('脚本里没有 coverText（格式：第一行|第二行）'); process.exit(1) }

const cfg = readConfig()
const pet = abs(cfg.video?.petFaces?.happy || cfg.video?.petImage || '')

/* 背景墙：拿第一镜的图，压暗虚化后当纹理。没有就退化成纯深色底。 */
const wall = abs(data.shots?.[0]?.img || data.shots?.[0]?.win?.bg || '')

const slug = String(data.slug || path.basename(scriptPath).replace(/^_script_|\.json$/g, ''))
const outDir = get('out') || path.join(ROOT, 'video', 'out', 'covers', slug)
fs.mkdirSync(outDir, { recursive: true })

const SIZES = [
  { size: '16x9', w: 1920, h: 1080, file: 'cover.png' },
  { size: '4x3', w: 1440, h: 1080, file: 'cover-4x3.png' },
  { size: '3x4', w: 810, h: 1080, file: 'cover-3x4.png' },
]

const browser = await chromium.launch({ channel: 'chrome', headless: true })
for (const s of SIZES) {
  const page = await browser.newPage({
    viewport: { width: s.w, height: s.h },
    deviceScaleFactor: 1,
  })
  page.on('pageerror', e => console.log('  页面报错：' + e.message))
  await page.goto('file:///' + TPL.replace(/\\/g, '/'))
  await page.evaluate(d => window.__COVER__(d), {
    size: s.size, brand: data.brand || 'GITHUB 项目推荐', big, sub, pet, wall,
  })
  /* 等图解码 + 一帧合成，否则截出来是半截空白 */
  await page.waitForFunction(() => Array.from(document.images).every(im => im.complete), null, { timeout: 15000 })
    .catch(() => { })
  await page.waitForTimeout(320)
  const out = path.join(outDir, s.file)
  await page.screenshot({ path: out })
  console.log(`  ${s.size.padEnd(5)} ${s.w}×${s.h}  →  ${path.relative(ROOT, out)}`)
  await page.close()
}
await browser.close()

console.log(`\n三张封面 → ${path.relative(ROOT, outDir)}`)
console.log('逐张打开看：主字完整、鱼完整、边缘没切。只看 16:9 那张不算验过。')
