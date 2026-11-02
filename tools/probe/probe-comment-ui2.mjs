/* tools/probe/probe-comment-ui2.mjs —— 抖音「回复能不能带表情包/图片」实测（有头）
 * ═══════════════════════════════════════════════════════════════
 * 上一版 probe-comment-ui.mjs 把 image_list 截断到 240 字符，而且回复框
 * 探测全空（页面没渲染完就查 DOM）。这一版：
 *   1. 完整保存评论原始 JSON（含 image_list 全量）
 *   2. 有头打开创作者后台评论页 + 作品页，各截一张图，人眼判断有没有表情/图片入口
 *   3. dump 页面上所有可输入元素和带 emoji/图片字样的按钮
 *
 * 只读，不发写请求。跑之前先停 server.mjs 并清掉 sessions/douyin 的残留进程。
 * 用法：node tools/probe/probe-comment-ui2.mjs [明文itemId]
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../../core/log.mjs'
import { launchPersistent } from '../../core/browser.mjs'
import * as insight from '../../douyin/insight.mjs'

const ITEM = process.argv[2] || '7703140636089699634'
const CREATOR = 'https://creator.douyin.com'
const WEB = 'https://www.douyin.com'

const { ctx } = await launchPersistent('douyin', { headless: false, pinned: true, viewport: { width: 1500, height: 950 } })
const page = await ctx.newPage()

const it = await insight._internal.resolveItem(ITEM)
if (!it.id) { console.error('认不出作品 id:', it.error); process.exit(1) }
const plain = it.plain || ITEM
console.log('加密 id:', String(it.id).slice(0, 40) + '…', ' 明文:', plain)

/* ── 1. 完整评论原始 JSON ── */
await page.goto(`${CREATOR}/creator-micro/interactive/comment`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
await page.waitForLoadState('load', { timeout: 20000 }).catch(() => { })
await page.waitForTimeout(5000)

const raw = await page.evaluate(async (itemId) => {
  const u = `https://creator.douyin.com/aweme/v1/creator/comment/list/?cursor=0&count=20&item_id=${encodeURIComponent(itemId)}&sort=TIME&aid=2906`
  const r = await fetch(u, { credentials: 'include' })
  return r.json().catch(() => null)
}, it.id)

fs.writeFileSync(path.join(ROOT, 'state', 'probe-comment-raw.json'), JSON.stringify(raw, null, 1))
const img = (raw?.comment_info_list || []).find(c => !c.text && c.image_list && c.image_list.length)
console.log('\n=== 图片评论原样 ===')
console.log(JSON.stringify(img && { user: img.user_info?.screen_name, image_list: img.image_list }, null, 1).slice(0, 1500))

/* ── 2. 创作者后台评论页 UI ── */
const dump = () => page.evaluate(() => {
  const short = (el) => ({
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 70),
    ph: el.getAttribute('placeholder') || '',
    txt: (el.textContent || '').trim().slice(0, 24),
    aria: el.getAttribute('aria-label') || '',
    title: el.getAttribute('title') || '',
  })
  const all = [...document.querySelectorAll('*')]
  return {
    url: location.href,
    editables: [...document.querySelectorAll('textarea,[contenteditable=true],input[type=text]')].map(short),
    iconish: all.filter(el => el.children.length === 0 && /表情|emoji|图片|image|picture|photo/i.test(
      (el.className || '') + (el.getAttribute('aria-label') || '') + (el.title || '') + (el.textContent || '')
    )).slice(0, 25).map(short),
    bodyText: (document.body.innerText || '').replace(/\n{2,}/g, '\n').slice(0, 800),
  }
})

const ui1 = await dump()
await page.screenshot({ path: path.join(ROOT, 'state', 'ui-creator-comment.png') }).catch(() => { })
console.log('\n=== 创作者后台评论页 ===')
console.log('url:', ui1.url)
console.log('可输入元素:', ui1.editables.length, JSON.stringify(ui1.editables).slice(0, 600))
console.log('疑似图标按钮:', JSON.stringify(ui1.iconish).slice(0, 900))
console.log('正文前 400:', ui1.bodyText.slice(0, 400))

/* ── 3. 作品页（普通 web 视角）── */
await page.goto(`${WEB}/video/${plain}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
await page.waitForTimeout(6000)
const ui2 = await dump()
await page.screenshot({ path: path.join(ROOT, 'state', 'ui-web-video.png') }).catch(() => { })
console.log('\n=== 作品页 ===')
console.log('url:', ui2.url)
console.log('可输入元素:', ui2.editables.length, JSON.stringify(ui2.editables).slice(0, 600))
console.log('疑似图标按钮:', JSON.stringify(ui2.iconish).slice(0, 900))

fs.writeFileSync(path.join(ROOT, 'state', 'probe-comment-ui2.json'), JSON.stringify({ at: Date.now(), ui1, ui2 }, null, 1))
console.log('\n截图: state/ui-creator-comment.png / state/ui-web-video.png')

await ctx.close().catch(() => { })
