/* tools/send-replies.mjs —— 把 state/replies-draft.json 的草案按两段式发出去
 * ═══════════════════════════════════════════════════════════════
 * 流程（每条都走）：
 *   1) POST /douyin/reply {confirm:false}  ← 只回显，确认接口认这组参数
 *   2) POST /douyin/reply {confirm:true}   ← 真发，服务端 guardedWrite 负责
 *      写前体检 / 60 秒限速 / 写后复检 / 掉号熔断
 *
 * 🔴 默认只跑 dry-run（不发）。要真发必须显式带 --yes。
 *    跳过名单从命令行给：--skip=天鹰梦,xxx
 *
 * 用法：
 *   node tools/send-replies.mjs                # 只回显
 *   node tools/send-replies.mjs --yes --skip=天鹰梦
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../core/log.mjs'

const BASE = 'http://127.0.0.1:18090'
const args = process.argv.slice(2)
const YES = args.includes('--yes')
const FINAL = args.includes('--final')
const skipArg = args.find(a => a.startsWith('--skip='))
const SKIP = new Set((skipArg ? skipArg.slice(7) : '').split(',').map(s => s.trim()).filter(Boolean))

/* --final 读 build-final-draft.mjs 产出（文案已人工确认，带数字 id）；
 * 否则读 gen-replies.mjs 的 LLM 草案（只有加密 id，发送前要服务端自反查）。 */
const src = path.join(ROOT, 'state', FINAL ? 'replies-final.json' : 'replies-draft.json')
const draft = JSON.parse(fs.readFileSync(src, 'utf8'))
const item = draft.item.plain
const rows = draft.replies
  .filter(r => r.reply && !SKIP.has(r.user))
  .map(r => ({ ...r, numId: r.numId || '' }))

console.log(`清单：${path.basename(src)}　模式：${YES ? '真发' : '仅回显（加 --yes 才发）'}`)
console.log(`作品 ${item}，共 ${rows.length} 条待发${SKIP.size ? `（跳过 ${[...SKIP].join('、')}）` : ''}\n`)

async function post(body) {
  const res = await fetch(BASE + '/douyin/reply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`)
  return j
}

let ok = 0, fail = 0
const results = []
for (const [n, r] of rows.entries()) {
  const tag = `[${n + 1}/${rows.length}] ${r.user}`
  try {
    const dry = await post({
      itemId: item, commentId: r.commentId, commentIdNum: r.numId, text: r.reply, confirm: false,
    })
    console.log(`${tag} 回显 OK → "${r.reply}"`)
    if (!YES) { results.push({ user: r.user, reply: r.reply, status: 'dry' }); continue }

    const t0 = Date.now()
    const sent = await post({
      itemId: item, commentId: r.commentId, commentIdNum: r.numId, text: r.reply, confirm: true,
    })
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`${tag} ✅ 已发送（耗时 ${sec}s，含限速等待）`)
    results.push({ user: r.user, reply: r.reply, status: 'sent', sec })
    ok++
  } catch (e) {
    console.log(`${tag} ❌ ${String(e.message || e).slice(0, 160)}`)
    results.push({ user: r.user, reply: r.reply, status: 'fail', error: String(e.message || e).slice(0, 200) })
    fail++
    /* 熔断/掉号这类错误继续发只会更糟，直接停 */
    if (/熔断|未登录|体检不通过|掉号/.test(String(e.message || e))) {
      console.log('⚠️ 命中熔断/登录异常，停止后续发送')
      break
    }
  }
}

const out = path.join(ROOT, 'state', `replies-sent-${Date.now()}.json`)
fs.writeFileSync(out, JSON.stringify({ at: Date.now(), mode: YES ? 'send' : 'dry', results }, null, 1))
console.log(`\n成功 ${ok} / 失败 ${fail} / 共 ${rows.length}；记录 ${out}`)
