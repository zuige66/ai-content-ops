/* tools/probe/probe-reply-panel2.mjs —— 精确点开回复框的 ☺，看面板里有什么
 * ═══════════════════════════════════════════════════════════════
 * 上一版按 class 猜图标失败（候选里全是左侧导航）。这一版换思路：
 * 点了「回复」之后，**回复框容器**里那个 ☺ 是唯一的小 svg，
 * 直接 dump 容器 outerHTML + 按容器内坐标点它。
 *
 * 🔴 只点「回复」和 ☺，绝不点「发送」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../../core/log.mjs'
import { launchPersistent } from '../../core/browser.mjs'

const CREATOR = 'https://creator.douyin.com'
const shot = (n) => path.join(ROOT, 'state', `rp2-${n}.png`)

const { ctx } = await launchPersistent('douyin', { headless: false, pinned: true, viewport: { width: 1500, height: 950 } })
const page = await ctx.newPage()
await page.goto(`${CREATOR}/creator-micro/interactive/comment`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
await page.waitForLoadState('load', { timeout: 20000 }).catch(() => { })
await page.waitForTimeout(5000)

await page.getByText('回复', { exact: true }).first().click({ timeout: 8000 }).catch(() => { })
await page.waitForTimeout(1500)

/* 回复框里那句「回复 XXX：」所在的容器，往上找 3 层拿到整个输入区 */
const box = await page.evaluate(() => {
  const label = [...document.querySelectorAll('*')].find(el =>
    el.children.length === 0 && /^回复\s/.test((el.textContent || '').trim()))
  if (!label) return null
  let node = label
  for (let i = 0; i < 4 && node.parentElement; i++) node = node.parentElement
  const r = node.getBoundingClientRect()
  /* 容器内所有 svg / img，标出坐标（相对 viewport） */
  const icons = [...node.querySelectorAll('svg,img,i')].map(el => {
    const b = el.getBoundingClientRect()
    return {
      tag: el.tagName.toLowerCase(),
      cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '').slice(0, 60),
      x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      src: el.tagName === 'IMG' ? (el.src || '').slice(0, 80) : '',
    }
  }).filter(i => i.w > 0 && i.w < 60)
  return {
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    html: node.outerHTML.slice(0, 2200),
    icons,
    editables: [...node.querySelectorAll('textarea,[contenteditable=true],input')].map(el => ({
      tag: el.tagName, cls: String(el.className || '').slice(0, 50), ph: el.getAttribute('placeholder') || '',
    })),
  }
})
if (!box) { console.error('没定位到回复框'); await page.screenshot({ path: shot('x') }); await ctx.close(); process.exit(1) }

console.log('回复框 rect:', box.rect)
console.log('容器内可输入:', JSON.stringify(box.editables))
console.log('容器内图标:', JSON.stringify(box.icons, null, 1))
console.log('\n容器 HTML 摘要:\n', box.html.slice(0, 1200))

/* 点容器里第一个 svg（按经验那个就是 ☺） */
const icon = box.icons.find(i => i.tag === 'svg')
if (icon) {
  const cx = icon.x + icon.w / 2, cy = icon.y + icon.h / 2
  console.log('\n点击图标 @', cx, cy)
  await page.mouse.click(cx, cy)
  await page.waitForTimeout(2000)
  await page.screenshot({ path: shot('panel') })
  const panel = await page.evaluate(() => {
    const body = document.body.innerText || ''
    const imgs = [...document.querySelectorAll('img')].filter(i => i.offsetWidth > 0 && i.offsetWidth <= 64)
    const spans = [...document.querySelectorAll('span,div')]
      .filter(el => el.children.length === 0 && (el.textContent || '').length === 1 && el.offsetWidth > 0 && el.offsetWidth < 40)
      .map(el => el.textContent).slice(0, 80)
    return {
      oneCharSpans: spans,                 // emoji 面板里的单个字符
      smallImgs: imgs.slice(0, 40).map(i => ({ src: (i.src || '').slice(0, 100), alt: i.alt || '', w: i.offsetWidth })),
      tail: body.slice(-300),
    }
  })
  console.log('\n面板 emoji 字符:', JSON.stringify(panel.oneCharSpans).slice(0, 800))
  console.log('面板图片:', JSON.stringify(panel.smallImgs).slice(0, 1500))
  console.log('页面尾部文字:', panel.tail.replace(/\n+/g, ' | '))
  fs.writeFileSync(path.join(ROOT, 'state', 'probe-reply-panel2.json'), JSON.stringify({ at: Date.now(), box, panel }, null, 1))
} else {
  console.log('容器里没有 svg，看 rp2-panel.png')
}

await ctx.close().catch(() => { })
