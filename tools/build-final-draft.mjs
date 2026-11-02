/* tools/build-final-draft.mjs —— 组最终发送清单（文案已人工确认，只补 numId）
 * ═══════════════════════════════════════════════════════════════
 * 为什么单开一个：gen-replies.mjs 会重新调 LLM，文案会变；这一批文案是
 * zuige 点头过的，不能重新生成。这里只做「按昵称把文案和评论 id 绑起来」。
 *
 * 用法：node tools/build-final-draft.mjs
 * 产出：state/replies-final.json（send-replies.mjs --final 读它）
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../core/log.mjs'

const BASE = 'http://127.0.0.1:18090'
const ITEM = '7703140636089699634'

/* 昵称 → 文案。文案来源：LLM 生成 + zuige 确认；循/奶娃两条按误发情况调整过 */
const PLAN = [
  ['森波拉', '广工的水养出来的嘛'],
  ['SH1ènG', '广工鱼，独一份的'],
  ['昵称全是重复', '别红烧我，我还没熟[看]'],
  ['zb', '这碗饭我记下了，谢谢'],
  ['奶娃', '诶，怎么还生气了'],
  ['循', '红烧鱼当然红呀'],
  ['六花の勇者', '叫这么多声，我应不过来了'],
  ['未未', '红烧的扛得住，白饭可不一定'],
]
const SKIP = ['天鹰梦']   // 图片评论：web 端发不了表情包，zuige 决定跳过

const res = await fetch(`${BASE}/douyin/comments?item=${ITEM}&count=20`)
const j = await res.json()
if (!j.ok) { console.error('拉评论失败', j.error); process.exit(1) }

const norm = (s) => String(s || '').replace(/[\u200b-\u200f\ufeff]/g, '').trim()
const rows = []
for (const [user, text] of PLAN) {
  const c = j.comments.find(x => norm(x.user) === norm(user))
  if (!c) { console.log(`⚠️ 找不到评论者「${user}」，跳过`); continue }
  if (!c.numId) { console.log(`⚠️ 「${user}」没配上数字 id，跳过`); continue }
  rows.push({ user, comment: c.text || '(图片)', numId: c.numId, commentId: c.id, reply: text })
}

const out = path.join(ROOT, 'state', 'replies-final.json')
fs.writeFileSync(out, JSON.stringify({ at: Date.now(), item: { plain: ITEM }, skip: SKIP, replies: rows }, null, 1))

console.log(`共 ${rows.length} 条待发（跳过 ${SKIP.join('、')}）`)
for (const r of rows) console.log(`- ${r.user} (${r.numId}) ${r.comment.slice(0, 16)} → ${r.reply}`)
console.log('落盘:', out)
