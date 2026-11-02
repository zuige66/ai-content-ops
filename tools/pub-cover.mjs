/**
 * pub-cover.mjs —— 给抖音创作者平台的上传页设置横封面 + 竖封面。
 *
 * 为什么单独有这个工具：抖音的封面弹窗里有两个 tab（「设置横封面」/
 * 「设置竖封面」），默认停在横封面。不切 tab 直接 setInputFiles，图会
 * 塞进横封面 —— 3:4 的图被塞进 4:3，横封面被改坏、竖封面纹丝不动，
 * 而且日志里完全看不出来。这件事踩了三次，所以固化成脚本。
 *
 * 前提：本机 Chrome 以 --remote-debugging-port=9222 启动，且已登录
 *       creator.douyin.com、页面停在上传页（表单已填）。
 *       走 CDP 接管真人浏览器，Playwright 自带实例会被判机器人。
 *
 * 用法：
 *   node tools/pub-cover.mjs --dir video/out/pick-1793622590797
 *   node tools/pub-cover.mjs --dir ... --only h      只设横封面
 *   node tools/pub-cover.mjs --dir ... --dry         只截图不动手
 *
 * 收尾用 process.exit(0)，绝不 b.close() —— CDP 连的是用户的真人浏览器，
 * close() 会把人家的页面全关掉，表单跟着丢。
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const flag = k => argv.includes('--' + k)

const DIR = arg('dir', '')
const ONLY = arg('only', 'both') // both | h | v
const DRY = flag('dry')
const SHOT = arg('shot', path.join(DIR || '.', '_pubcover'))

if (!DIR || !fs.existsSync(DIR)) {
  console.log('缺 --dir，或者目录不存在：', DIR)
  process.exit(1)
}
const H_IMG = path.join(DIR, 'cover-4x3.png')
const V_IMG = path.join(DIR, 'cover-3x4.png')
for (const f of [H_IMG, V_IMG]) {
  if (!fs.existsSync(f)) console.log('⚠ 缺文件：', f, '（会跳过对应的一步）')
}
fs.mkdirSync(SHOT, { recursive: true })

const b = await chromium.connectOverCDP('http://127.0.0.1:9222')
let page = null
for (const c of b.contexts()) {
  for (const p of c.pages()) if (/creator\.douyin\.com/.test(p.url())) page = p
}
if (!page) {
  console.log('没找到 creator.douyin.com 的页面。先手动登录并打开上传页。')
  process.exit(1)
}
console.log('接管页面：', page.url())

const shot = async n => {
  await page.screenshot({ path: path.join(SHOT, n + '.png') }).catch(() => {})
}

/** 点一个叶子节点（文案精确匹配），返回是否点到。
 *  用 evaluate 而不是 locator.click()：这些 tab 外面常套 <label>，
 *  locator 会被指针事件拦截，重试到超时。 */
const clickLeaf = (re, nth = 0) =>
  page.evaluate(
    ([src, n]) => {
      const rx = new RegExp(src)
      const els = [...document.querySelectorAll('*')].filter(
        e => e.children.length === 0 && rx.test((e.innerText || '').trim())
      )
      if (!els[n]) return 'not-found'
      els[n].click()
      return 'clicked'
    },
    [re.source, nth]
  )

/** 塞文件：优先接 filechooser，接不到就找隐藏 input。
 *  只取 accept 含 image 的最后一个，避免塞进视频/附件 input。 */
const upload = async img => {
  const [fc] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 9000 }).catch(() => null),
    page.locator('text=上传封面').first().click({ timeout: 6000 }).catch(() => {}),
  ])
  if (fc) {
    await fc.setFiles(img)
    return 'filechooser'
  }
  const fi = page.locator('input[type=file][accept*="image"]').last()
  if (await fi.count()) {
    await fi.setInputFiles(img)
    return 'input'
  }
  return 'failed'
}

const confirm = async () => {
  for (const name of ['确定', '完成', '确认', '保存']) {
    const btn = page.getByRole('button', { name, exact: true }).last()
    if (await btn.count()) {
      await btn.click({ timeout: 5000 }).catch(() => {})
      return name
    }
  }
  return 'none'
}

/* ── 横封面 ─────────────────────────────────────────────── */
if (ONLY === 'both' || ONLY === 'h') {
  if (fs.existsSync(H_IMG)) {
    console.log('\n[横封面] 4:3', H_IMG)
    await page.locator('text=设置封面').first().click({ timeout: 8000 }).catch(e => console.log('  进弹窗失败：', e.message))
    await page.waitForTimeout(1500)
    console.log('  切 tab：', await clickLeaf(/^设置横封面$/))
    await page.waitForTimeout(1200)
    await shot('h1-tab')
    if (!DRY) {
      console.log('  上传：', await upload(H_IMG))
      await page.waitForTimeout(3800)
      await shot('h2-uploaded')
      console.log('  确认：', await confirm())
      await page.waitForTimeout(2000)
      await shot('h3-done')
    }
  } else {
    console.log('[横封面] 跳过，缺', H_IMG)
  }
}

/* ── 竖封面 ─────────────────────────────────────────────── */
/* 竖封面入口是封面控件里的第 2 个（nth(1)）。点不到就直接找 tab 文案。 */
if (ONLY === 'both' || ONLY === 'v') {
  if (fs.existsSync(V_IMG)) {
    console.log('\n[竖封面] 3:4', V_IMG)
    await page.locator('[class*="coverControl"]').nth(1).click({ timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(2000)
    /* 🔴 这一步是关键：不切 tab 会把 3:4 的图塞进 4:3 的横封面 */
    console.log('  切 tab：', await clickLeaf(/^设置竖封面$/))
    await page.waitForTimeout(1500)
    await shot('v1-tab')
    if (!DRY) {
      console.log('  上传：', await upload(V_IMG))
      await page.waitForTimeout(4200)
      await shot('v2-uploaded')
      console.log('  确认：', await confirm())
      await page.waitForTimeout(2400)
      await shot('v3-done')
    }
  } else {
    console.log('[竖封面] 跳过，缺', V_IMG)
  }
}

console.log('\n截图 →', SHOT)
console.log('🔴 必须人眼回看截图：横封面是 4:3 那张、竖封面是 3:4 那张，')
console.log('   别两张都变成同一张。平台还会报「封面存在文字展示不全」，')
console.log('   报了就说明字被裁了，回去改模板重出图。')
process.exit(0)
