/* 完整走一遍：goto /chat → 点陌生人分组 → 打印右栏结构 */
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find(p => p.url().includes('/chat'))

const fix = () => page.evaluate(() => {
  const w = document.querySelector('[class*="ConversationListwrapper"]')
  if (w && /matrix\(1,\s*0,\s*0,\s*1,\s*-?\d/.test(getComputedStyle(w).transform)) w.style.transform = 'none'
})

await page.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(9000)
await fix()
console.log('=== 加载后 ===')
console.log(await page.evaluate(() => {
  const w = document.querySelector('[class*="ConversationListwrapper"]')
  return '左栏: ' + (w ? w.innerText.replace(/\n+/g, ' | ').slice(0, 150) : '无')
}))

const sb = page.locator('[class*="conversationStrangerBoxwrapper"]').first()
console.log('分组件数:', await sb.count())
const bb = await sb.boundingBox()
console.log('分组框:', JSON.stringify(bb))
if (bb) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
await page.waitForTimeout(3000)
await fix()
await page.waitForTimeout(1000)

const st = await page.evaluate(() => {
  const list = document.querySelector('[class*="MessageListlist"]')
  const cur = document.querySelector('[class*="curConversation"]')
  // 右栏所有高度 > 50 的文本块
  const blocks = []
  for (const el of document.querySelectorAll('div')) {
    const rc = el.getBoundingClientRect()
    if (rc.x < 310 || rc.width < 180 || rc.height < 45 || rc.height > 140) continue
    if (el.children.length > 8) continue
    const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
    if (!t || t.length > 120) continue
    blocks.push({ x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height), t: t.slice(0, 50) })
  }
  return {
    hasList: !!list,
    listKids: list ? list.children.length : 0,
    cur: cur ? cur.innerText.replace(/\s+/g, ' ').slice(0, 30) : '',
    bodyTail: document.body.innerText.replace(/\n+/g, ' | ').slice(-260),
    blocks: blocks.slice(0, 10),
  }
})
console.log('\n=== 点分组后 ===')
console.log('有消息区:', st.hasList, ' kids:', st.listKids, ' 当前会话:', st.cur || '(无)')
console.log('页面尾部:', st.bodyTail)
console.log('右栏块:')
st.blocks.forEach(b => console.log('  ', JSON.stringify(b)))

browser.close().catch(() => { })
