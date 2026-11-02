/* 探测私信左侧会话列表的结构：类名、未读红点、可点区域
 */
import { chromium } from 'playwright-core'
import { ROOT } from '../../core/log.mjs'
import path from 'node:path'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => p.url().includes('/chat')) || await ctx.newPage()
if (!page.url().includes('/chat')) {
  await page.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(9000)
}

const info = await page.evaluate(() => {
  // 1) 找会话项：class 里带 conversation / session / chatItem 的
  const byClass = {}
  for (const el of document.querySelectorAll('[class]')) {
    const c = String(el.className || '')
    for (const m of c.match(/[A-Za-z][A-Za-z0-9]*(conversation|session|chatItem|ChatItem|Conversation)[A-Za-z0-9]*/g) || []) {
      byClass[m] = (byClass[m] || 0) + 1
    }
  }

  // 2) 用几何位置找左栏（x<460）里高度 60~90 的行
  const rows = []
  for (const el of document.querySelectorAll('div,li,a')) {
    const r = el.getBoundingClientRect()
    if (r.x < 0 || r.x > 300) continue
    if (r.width < 200 || r.width > 460) continue
    if (r.height < 55 || r.height > 95) continue
    const t = (el.textContent || '').trim()
    if (!t) continue
    rows.push({
      cls: String(el.className || '').slice(0, 60),
      text: t.replace(/\s+/g, ' ').slice(0, 50),
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
    })
  }
  const uniq = []
  const seen = new Set()
  for (const r of rows) {
    const k = `${r.y}`
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(r)
  }

  // 3) 未读角标：红色小圆点/数字
  const badges = [...document.querySelectorAll('*')].filter(el => {
    const s = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.width > 30 || r.height < 8 || r.height > 30) return false
    const bg = s.backgroundColor || ''
    return /rgb\(2[0-5]\d|rgb\(1\d\d,\s*[0-9]{1,2},/.test(bg) && el.children.length === 0
  }).map(el => {
    const r = el.getBoundingClientRect()
    return { t: (el.textContent || '').trim().slice(0, 4), x: Math.round(r.x), y: Math.round(r.y), bg: getComputedStyle(el).backgroundColor }
  })

  return { byClass: Object.entries(byClass).sort((a, b) => b[1] - a[1]).slice(0, 15), rows: uniq.slice(0, 10), badges: badges.slice(0, 10) }
})

console.log('=== 会话相关类名 ===')
console.log(JSON.stringify(info.byClass))
console.log('=== 左栏行 ===')
for (const r of info.rows) console.log(`y=${r.y} x=${r.x} ${r.w}x${r.h} | ${r.text} | cls=${r.cls}`)
console.log('=== 红点 ===')
console.log(JSON.stringify(info.badges))

await page.screenshot({ path: path.join(ROOT, 'state', 'dm-list.png') }).catch(() => { })
browser.close().catch(() => { })
