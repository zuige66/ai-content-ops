/* 精确定位「立即投稿」按钮 —— dry-run 里 count 返回 0，但截图里明明有 */
import { launchPersistent, getLive } from '../../core/browser.mjs'
import * as session from '../../bili/session.mjs'

const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame'
const VIDEO = 'video/out/pick-1793551323277/video.mp4'

const live = getLive('bili')
const ctx = live || (await launchPersistent('bili', { headless: true })).ctx
let page
try {
  page = await ctx.newPage()
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => { })
  await page.waitForTimeout(6000)
  await page.locator('input[type=file]').first().setInputFiles(VIDEO)

  /* 等上传完 */
  const t0 = Date.now()
  while (Date.now() - t0 < 300000) {
    const txt = await page.evaluate(() => document.body.innerText || '').catch(() => '')
    if (/上传中|正在上传|\d{1,3}%/.test(txt)) { await page.waitForTimeout(3000); continue }
    if (/请输入稿件标题/.test(txt)) break
    await page.waitForTimeout(3000)
  }
  console.log('表单就绪')

  /* 找所有含「投稿」的可点元素，不限 button 标签 */
  const found = await page.evaluate(() => {
    const out = []
    const vis = (el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    /* 1. 所有 button */
    for (const el of document.querySelectorAll('button')) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
      if (t) out.push({ kind: 'button', tag: el.tagName, text: t.slice(0, 24), cls: String(el.className || '').slice(0, 60), visible: vis(el), disabled: el.disabled })
    }
    /* 2. 任何 role=button */
    for (const el of document.querySelectorAll('[role="button"]')) {
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
      if (t && !out.some((x) => x.text === t.slice(0, 24))) out.push({ kind: 'role=button', tag: el.tagName, text: t.slice(0, 24), cls: String(el.className || '').slice(0, 60), visible: vis(el) })
    }
    /* 3. 任何含「投稿」二字的叶子/近叶子节点 */
    for (const el of document.querySelectorAll('*')) {
      const own = (el.innerText || '').replace(/\s+/g, ' ').trim()
      if (!own || own.length > 20) continue
      if (!/立即投稿|投稿|发布/.test(own)) continue
      if (el.children.length > 1) continue
      out.push({ kind: 'text-node', tag: el.tagName, text: own.slice(0, 24), cls: String(el.className || '').slice(0, 60), visible: vis(el), clickable: Boolean(el.onclick) || getComputedStyle(el).cursor === 'pointer' })
    }
    return out
  })

  console.log('\n=== 含「投稿/发布」字样的元素 ===')
  found.forEach((x) => console.log(`  [${x.kind}] <${x.tag}> "${x.text}" vis=${x.visible}${x.disabled !== undefined ? ' disabled=' + x.disabled : ''}${x.clickable !== undefined ? ' cursor-pointer=' + x.clickable : ''}\n      cls=${x.cls}`))

  /* Playwright 侧再验一次 */
  console.log('\n=== Playwright 定位结果 ===')
  for (const [name, loc] of [
    ['getByRole button 立即投稿 exact', page.getByRole('button', { name: '立即投稿', exact: true })],
    ['getByRole button 立即投稿', page.getByRole('button', { name: '立即投稿' })],
    ['getByText 立即投稿', page.getByText('立即投稿', { exact: true })],
    ['locator button:has-text', page.locator('button:has-text("立即投稿")')],
    ['getByRole button 存草稿', page.getByRole('button', { name: '存草稿', exact: true })],
  ]) {
    const n = await loc.count().catch((e) => 'ERR ' + e.message.slice(0, 40))
    let v = '-'
    if (typeof n === 'number' && n > 0) v = await loc.first().isVisible().catch(() => '?')
    console.log(`  ${name.padEnd(38)} count=${n} visible=${v}`)
  }

  await page.screenshot({ path: '.run/trash/bili-btn.png', fullPage: true })
  console.log('\n截图: .run/trash/bili-btn.png')
} catch (e) {
  console.error('失败:', String(e && e.message || e).slice(0, 300))
} finally {
  if (page) await page.close().catch(() => { })
  process.exit(0)
}
