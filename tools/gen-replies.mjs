/* tools/gen-replies.mjs —— 按大肥鱼人设给评论区逐条生成回复（只生成，不发）
 * ═══════════════════════════════════════════════════════════════
 * 读 prompts/dafeiyu-live.md 当人设底，喂评论列表给 LLM，出一条一批 reply。
 * 🔴 只产出 state/replies-draft.json，**不发任何写请求**。
 *    发送走 server 的 POST /douyin/reply（两段式 + 熔断器）。
 *
 * 用法：node tools/gen-replies.mjs [明文itemId]
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../core/log.mjs'
import { chatJsonDetailed } from '../core/llm.mjs'
import { launchPersistent } from '../core/browser.mjs'
import * as insight from '../douyin/insight.mjs'

const ITEM = process.argv[2] || '7703140636089699634'
const PERSONA = path.join('D:/Workplace/zhibo/prompts/dafeiyu-live.md')

/* 人设取前 120 行（你是谁 + 说话铁律 + 直播怎么待着），够用又不撑爆 prompt */
let persona = ''
try {
  persona = fs.readFileSync(PERSONA, 'utf8').split('\n').slice(0, 130).join('\n')
} catch { console.warn('读不到角色卡，退化成简版人设'); persona = '大肥鱼：软糯的 AI 女仆小姑娘，广东工业大学在读。' }

/* ── 1. 拉评论（含图片评论标记）+ 已有回复 ── */
const { ctx } = await launchPersistent('douyin', { headless: true, pinned: true })
const it = await insight._internal.resolveItem(ITEM)
if (!it.id) { console.error('认不出作品：', it.error); process.exit(1) }

const list = await insight.comments(ITEM, { count: 20, force: true })
if (!list.ok) { console.error('拉评论失败：', list.error); process.exit(1) }

const rows = []
for (const c of list.comments) {
  let mine = []
  if (c.replyCount > 0) {
    const r = await insight.replies(c.id).catch(() => null)
    if (r && r.ok) mine = r.replies.filter(x => x.isAuthor).map(x => x.text)
  }
  rows.push({ ...c, myReplies: mine })
}
await ctx.close().catch(() => { })

console.log(`评论 ${rows.length} 条，其中已有我回复的 ${rows.filter(r => r.myReplies.length).length} 条`)
for (const r of rows) {
  console.log(`- ${r.user} | ${r.text || '（图片评论）'} | 我已回: ${r.myReplies.join(' / ') || '无'}`)
}

/* ── 2. LLM 逐条生成 ── */
const payload = rows.map((r, i) => ({
  i,
  user: r.user,
  text: r.text || '',
  isImage: !r.text,
  myReplies: r.myReplies,
}))

const sys = `你在替抖音账号「zuige大肥鱼」回复自己视频下的评论。以下是你的人设卡，必须严格遵守：

${persona}

补充规则（评论区场景，与直播间不同，优先遵守）：
1. 每条回复 **20 个汉字以内**，一句话，**句尾不加句号**。
2. 不要 emoji 表情字符（🍚🐟❤️ 这类一律不用）。抖音官方表情请写成 [看] [发怒] 这种方括号编码，最多用一个。
3. 可以直接叫对方昵称，也可以叫「你」；不许叫「宝宝/亲爱的/老婆/主人」。
4. 遇到梗要接住，不要客套。白饭、红烧、广工 都是自己的梗。
5. 对方发的是**图片评论**（isImage=true，通常是表情包），就用文字应一声、逗一句，不要假装看见了具体内容。
6. 不讨要礼物、不喊关注点赞、不提任何金融/收益/仓位相关的词。
7. 不要重复对方原话，不要复读。
8. 如果 myReplies 里已经有我回过的话，就换个说法再补一句；已经回过且没什么可补的，reply 给空字符串。
9. 语气软糯、有点小迷糊，但不能蠢；被骂也别硬顶。

只输出 JSON：{"replies":[{"i":0,"reply":"..."}]}`

const user = `这是我视频下的评论，逐条回复：\n${JSON.stringify(payload, null, 1)}`

const { data, usage, ms } = await chatJsonDetailed({ system: sys, user, maxTokens: 1200, temperature: 0.9 })
const out = (data.replies || []).map(x => {
  const row = rows[x.i]
  return {
    i: x.i,
    user: row?.user || '',
    commentId: row?.id || '',
    text: row?.text || '',
    isImage: !row?.text,
    reply: String(x.reply || '').trim(),
  }
}).filter(x => x.commentId)

const file = path.join(ROOT, 'state', 'replies-draft.json')
fs.writeFileSync(file, JSON.stringify({ at: Date.now(), item: { plain: it.plain || ITEM, enc: it.id }, usage, ms, replies: out }, null, 1))

console.log(`\nLLM 用时 ${ms}ms, tokens ${usage.total_tokens || '?'}`)
console.log('=== 草案 ===')
for (const r of out) {
  console.log(`[${r.i}] ${r.user}${r.isImage ? '（图片）' : ''}: ${r.text.slice(0, 24)}`)
  console.log(`    → ${r.reply || '（空，跳过）'}  （${[...r.reply].length} 字）`)
}
console.log('\n落盘:', file)
