/* peek-comments.mjs —— 只读排查：看某条作品的真实评论 + 回复关系
 * ═══════════════════════════════════════════════════════════════
 * 用法：node tools/peek-comments.mjs <plainAwemeId>
 *
 * 为什么要有它：creator 后台那个评论接口（douyin/insight.mjs 的 comments）
 * 返回的 is_author 语义是坏的，光看它分不清「谁回的」「回没回」。
 * 这里直接打 www 域 /aweme/v1/web/comment/list/ + .../list/reply/，
 * 能拿到真实的「评论人 → 谁回了什么」，排查「某条评论为什么没回」最直接。
 *
 * 🔴 只读，一个字节都不写。走 CDP 附着到项目自己的调试 Chrome（config.chrome.debugPort）。
 * ═══════════════════════════════════════════════════════════════ */
import { chromium } from 'playwright-core'

const ID = process.argv[2]
if (!ID) { console.error('要给 plainId'); process.exit(1) }

const WEB = 'https://www.douyin.com'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page = ctx.pages().find(p => /douyin\.com/.test(p.url()))
if (!page) { page = await ctx.newPage() }

const list = async () => page.evaluate(async (u) => {
  try {
    const res = await fetch(u, { credentials: 'include' })
    const t = await res.text()
    try { return JSON.parse(t) } catch { return { __raw: t.slice(0, 200) } }
  } catch (e) { return { __err: String(e) } }
}, `${WEB}/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&aweme_id=${ID}&cursor=0&count=50&item_type=0`)

const reply = async (cid) => page.evaluate(async (u) => {
  try {
    const res = await fetch(u, { credentials: 'include' })
    const t = await res.text()
    try { return JSON.parse(t) } catch { return { __raw: t.slice(0, 200) } }
  } catch (e) { return { __err: String(e) } }
}, `${WEB}/aweme/v1/web/comment/list/reply/?device_platform=webapp&aid=6383&item_id=${ID}&comment_id=${cid}&cursor=0&count=20&item_type=0`)

let j = await list()
if (!j.comments && !j.comment_info_list) {
  await page.goto(`${WEB}/video/${ID}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { })
  await page.waitForTimeout(3000)
  j = await list()
}

const arr = j.comments || j.comment_info_list || []
console.log('=== 顶层评论', arr.length, '条 ===')
for (const c of arr) {
  const nick = (c.user && c.user.nickname) || '?'
  const replyTotal = c.reply_comment_total ?? c.reply_count ?? 0
  const isAuthor = c.is_author ?? false
  console.log(`\n【${nick}】 is_author=${isAuthor} 回复数=${replyTotal} cid=${c.cid || c.comment_id}`)
  console.log('  正文:', JSON.stringify(String(c.text || '').slice(0, 60)))
  if (replyTotal > 0) {
    const r = await reply(c.cid || c.comment_id)
    const ra = r.comments || r.comment_info_list || []
    for (const x of ra) {
      console.log(`    ↳ [${(x.user && x.user.nickname) || '?'}] is_author=${x.is_author ?? false} :: ${String(x.text || '').slice(0, 50)}`)
    }
  }
}

await browser.close().catch(() => { })   // connectOverCDP 的 close 只是 disconnect，不会关掉用户的 Chrome
