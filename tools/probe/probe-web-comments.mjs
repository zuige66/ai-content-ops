/* tools/probe/probe-web-comments.mjs —— 从 www 域评论接口拿「数字 comment_id」
 * ═══════════════════════════════════════════════════════════════
 * 背景：creator 后台的 comment/list 只给加密串（@ivRu…==），
 * 而真正发回复的接口 multi_publish 要的是**数字** reply_to_comment_ids
 * （实测 7703207823286764338）。数字 id 只在 www 域评论接口里。
 *
 * 只读。用法：node tools/probe/probe-web-comments.mjs [明文awemeId]
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../../core/log.mjs'
import { launchPersistent } from '../../core/browser.mjs'

const AWEME = process.argv[2] || '7703140636089699634'
const { ctx } = await launchPersistent('douyin', { headless: true, pinned: true })
const page = await ctx.newPage()

await page.goto(`https://www.douyin.com/video/${AWEME}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
await page.waitForLoadState('load', { timeout: 20000 }).catch(() => { })
await page.waitForTimeout(4000)

const r = await page.evaluate(async (awemeId) => {
  const u = `https://www.douyin.com/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&aweme_id=${awemeId}&cursor=0&count=20&item_type=0`
  try {
    const res = await fetch(u, { credentials: 'include' })
    const t = await res.text()
    let j = null
    try { j = JSON.parse(t) } catch { }
    return { status: res.status, json: j, raw: t.slice(0, 200) }
  } catch (e) { return { status: 0, error: String(e).slice(0, 160) } }
}, AWEME)

if (!r.json) {
  console.log('拿不到 JSON：', r.status, r.error || r.raw)
  await ctx.close(); process.exit(1)
}

const list = r.json.comments || r.json.comment_info_list || []
console.log('status', r.status, '条数', list.length, 'total', r.json.total)
const rows = list.map(c => ({
  comment_id: c.cid || c.comment_id,
  isNumber: /^\d+$/.test(String(c.cid || c.comment_id || '')),
  text: String(c.text || '').slice(0, 40),
  user: c.user?.nickname || c.user_info?.screen_name || '',
  replyCount: c.reply_comment_total ?? c.reply_count ?? 0,
}))
rows.forEach((x, i) => console.log(`[${i}] ${x.comment_id} 数字?${x.isNumber} | ${x.user} | ${x.text || '（无文字/图片）'}`))

fs.writeFileSync(path.join(ROOT, 'state', 'probe-web-comments.json'), JSON.stringify({ at: Date.now(), aweme: AWEME, status: r.status, rows, topKeys: Object.keys(r.json) }, null, 1))
console.log('落盘: state/probe-web-comments.json')
await ctx.close().catch(() => { })
