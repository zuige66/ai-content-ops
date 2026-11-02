/* 用真实 Chrome 打开控制台，验证前端改动没有运行时报错
 * 只读：不点发布、不建 job。 */
import { chromium } from 'playwright-core'

const BASE = 'http://127.0.0.1:18090'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
  .catch(() => chromium.launch({ channel: 'msedge', headless: true }))

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

const errors = []
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200))
})

await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 45000 })
await page.waitForTimeout(2500)

const shot = async (name) => {
  await page.screenshot({ path: `.run/trash/ui-${name}.png` })
}

/* 1. 首屏 */
await shot('01-login')
console.log('1. 首屏加载，错误数 =', errors.length)

/* 2. 切到视频工坊 */
await page.getByText('视频工坊', { exact: true }).first().click()
await page.waitForTimeout(2000)
await shot('02-video')
const hasWorkshop = await page.getByText('选题', { exact: true }).count()
console.log('2. 视频工坊渲染，选题区块 =', hasWorkshop > 0)

/* 3. 成片库是否有「投稿」按钮 */
const pubBtns = await page.getByRole('button', { name: '投稿' }).count()
console.log('3. 成片库「投稿」按钮数量 =', pubBtns)

/* 4. 点第一条成片库的「投稿」，看投稿区是否出现 */
if (pubBtns > 0) {
  await page.getByRole('button', { name: '投稿' }).first().click()
  await page.waitForTimeout(1500)
  await shot('03-publish-panel')
  const panel = await page.getByText('投稿', { exact: true }).count()
  const platformSeg = await page.getByText('B站', { exact: true }).count()
  console.log('4. 投稿区出现 =', panel > 0, '｜平台切换 =', platformSeg > 0)
}

/* 5. 策划台 → 去出片 */
await page.getByText('策划台', { exact: true }).first().click()
await page.waitForTimeout(2000)
await shot('04-plans')
const goShoot = await page.getByRole('button', { name: /去出片|重新出片/ }).count()
console.log('5. 策划台「去出片」按钮 =', goShoot)

if (goShoot > 0) {
  await page.getByRole('button', { name: /去出片|重新出片/ }).first().click()
  await page.waitForTimeout(2500)
  await shot('05-plan-loaded')
  const banner = await page.getByText(/内容来自策划/).count()
  const topicVal = await page.locator('input[placeholder*="一句话说清"]').inputValue().catch(() => '')
  console.log('6. 策划已装载 =', banner > 0, '｜主题 =', JSON.stringify(topicVal).slice(0, 70))
}

console.log('\n=== 运行时报错 ===')
if (errors.length) {
  errors.slice(0, 10).forEach((e) => console.log('  ' + e))
} else {
  console.log('  无')
}

await browser.close()
process.exit(errors.length ? 1 : 0)
