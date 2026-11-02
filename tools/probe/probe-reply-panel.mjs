/* tools/probe/probe-reply-panel.mjs —— 实测：回复框的表情入口里到底是什么（有头）
 * ═══════════════════════════════════════════════════════════════
 * 要回答的问题：抖音创作者后台/作品页的「回复」，能不能发自定义表情包（图片）？
 *   · 只有 emoji  → web 端发不了表情包，只能换路子
 *   · 有图片/表情包 → 记下 DOM 结构，后面做成可复用流程
 *
 * 🔴 全程**不点发送**，只点「回复」和表情图标，最后 Esc 关掉。
 * 用法：node tools/probe/probe-reply-panel.mjs [明文itemId]
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../../core/log.mjs'
import { launchPersistent } from '../../core/browser.mjs'

const ITEM = process.argv[2] || '7703140636089699634'
const CREATOR = 'https://creator.douyin.com'
const shot = (n) => path.join(ROOT, 'state', `rp-${n}.png`)

const { ctx } = await launchPersistent('douyin', { headless: false, pinned: true, viewport: { width: 1500, height: 950 } })
const page = await ctx.newPage()
await page.goto(`${CREATOR}/creator-micro/interactive/comment`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
await page.waitForLoadState('load', { timeout: 20000 }).catch(() => { })
await page.waitForTimeout(5000)

/* 页面顶部有「选择作品」，作品内容要能对上 itemId；对不上就提示人工确认。
 * 这里只取当前页第一条评论的「回复」，所以先确认页面显示的是这条作品。 */
const head = await page.evaluate(() => (document.body.innerText || '').slice(0, 260))
console.log('页面头部:', head.replace(/\n+/g, ' | ').slice(0, 200))

/* ── 点第一条「回复」── */
const replyBtns = page.locator('text=回复')
const n = await replyBtns.count()
console.log('页面上的「回复」按钮数:', n)
if (!n) { console.error('没找到回复按钮'); await page.screenshot({ path: shot('0-noBtn') }); await ctx.close(); process.exit(1) }

await replyBtns.first().click({ timeout: 8000 }).catch((e) => console.log('点回复失败:', e.message))
await page.waitForTimeout(1500)
await page.screenshot({ path: shot('1-afterReply') })
console.log('截图1（点了回复后）')

/* 刚出现的可输入元素 */
const dumpEdit = () => page.evaluate(() => {
  const els = [...document.querySelectorAll('textarea,[contenteditable=true],input[type=text]')]
  return els.map(el => ({
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 60),
    ph: el.getAttribute('placeholder') || '',
    visible: !!(el.offsetWidth || el.offsetHeight),
    rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] })(),
  }))
})
console.log('可输入元素:', JSON.stringify(await dumpEdit(), null, 1).slice(0, 800))

/* ── 找输入框旁边那个笑脸图标 ──
 * 之前截图看是灰色 ☺。它可能是 svg / img / 字体图标。
 * 策略：在可见的输入区附近找小尺寸的可点元素，逐个 hover 拿 title/class。 */
const cand = await page.evaluate(() => {
  const out = []
  const walk = (rootEl) => {
    for (const el of rootEl.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      if (r.width > 40 || r.height > 40) continue
      if (el.children.length > 2) continue
      const cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')
      const aria = el.getAttribute('aria-label') || el.getAttribute('title') || ''
      const tag = el.tagName.toLowerCase()
      if (!/svg|img|i$|icon|emoji|face|smile/i.test(tag + ' ' + cls + ' ' + aria)) continue
      out.push({ tag, cls: cls.slice(0, 70), aria, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) })
    }
  }
  walk(document.body)
  return out.slice(0, 40)
})
console.log('\n可能的图标元素:', JSON.stringify(cand, null, 1).slice(0, 2000))

/* 优先点 emoji/表情相关的 */
const emojiEl = cand.find(c => /emoji|face|smile|表情/i.test(c.cls + c.aria))
if (emojiEl) {
  console.log('\n点表情图标:', emojiEl.tag, emojiEl.cls)
  await page.mouse.click(emojiEl.x + emojiEl.w / 2, emojiEl.y + emojiEl.w / 2).catch(() => { })
  await page.waitForTimeout(1800)
  await page.screenshot({ path: shot('2-emojiPanel') })
  const panel = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter(i => i.offsetWidth && i.offsetWidth < 60)
    const txt = document.body.innerText || ''
    return {
      smallImgs: imgs.slice(0, 30).map(i => ({ src: (i.src || '').slice(0, 90), alt: i.alt || '', w: i.offsetWidth })),
      hasStickerWords: /表情|表情包|收藏/.test(txt),
      tail: txt.slice(-400),
    }
  })
  console.log('表情面板内容:', JSON.stringify(panel, null, 1).slice(0, 1500))
} else {
  console.log('\n没自动识别到表情图标，看截图2/1人工判断')
  await page.screenshot({ path: shot('2-nopanel') })
}

fs.writeFileSync(path.join(ROOT, 'state', 'probe-reply-panel.json'), JSON.stringify({ at: Date.now(), cand, emojiEl }, null, 1))
await ctx.close().catch(() => { })
