/* tools/probe/probe-comment-ui.mjs —— 一次性探测：抖音评论原始字段 + 回复框表情面板
 * ═══════════════════════════════════════════════════════════════
 * 要回答两个问题（2026-11-02 加）：
 *   1. 空正文的评论（天鹰梦那条）到底是不是「贴纸/表情包」？原始字段长什么样？
 *   2. 创作者后台的回复框，除了文字还能发什么？有没有表情面板、能不能发图片？
 *
 * 只读：不发任何写请求。跑之前要先停掉 server.mjs（同一个 profile 不能两个进程抢）。
 * 用法：node tools/probe/probe-comment-ui.mjs [明文itemId]
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../../core/log.mjs'
import { launchPersistent } from '../../core/browser.mjs'
import * as insight from '../../douyin/insight.mjs'

const ITEM = process.argv[2] || '7703140636089699634'
const CREATOR = 'https://creator.douyin.com'
const out = path.join(ROOT, 'state', 'probe-comment-ui.json')

const { ctx } = await launchPersistent('douyin', { headless: true, pinned: true })
const page = await ctx.newPage()
await page.goto(`${CREATOR}/creator-micro/interactive/comment`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
await page.waitForLoadState('load', { timeout: 20000 }).catch(() => { })
await page.waitForTimeout(4000)

const it = await insight._internal.resolveItem(ITEM)
if (!it.id) { console.error('认不出作品 id:', it.error); process.exit(1) }
console.log('加密 id:', String(it.id).slice(0, 40) + '...')

const raw = await page.evaluate(async (itemId) => {
  const u = `https://creator.douyin.com/aweme/v1/creator/comment/list/?cursor=0&count=20&item_id=${encodeURIComponent(itemId)}&sort=TIME&aid=2906`
  const r = await fetch(u, { credentials: 'include' })
  const j = await r.json().catch(() => null)
  return j
}, it.id)

/* 原始结构：只留字段名 + 前 200 字符，避免把整包吐进上下文 */
function shape(o, depth = 0) {
  if (o === null || o === undefined) return String(o)
  if (Array.isArray(o)) return o.length ? [shape(o[0], depth + 1)] : []
  if (typeof o === 'object') {
    const r = {}
    for (const k of Object.keys(o)) {
      const v = o[k]
      r[k] = (v && typeof v === 'object') ? shape(v, depth + 1)
        : (typeof v === 'string' ? v.slice(0, 120) : v)
    }
    return r
  }
  return o
}

const list = (raw && (raw.comment_info_list || raw.comment_list)) || []
const rows = list.map((c) => {
  /* 空 text 的评论，把非空的可疑字段全捞出来 */
  const suspects = {}
  for (const [k, v] of Object.entries(c)) {
    if (k === 'text' || k === 'user_info') continue
    if (v && typeof v === 'object' && Object.keys(v).length) suspects[k] = JSON.stringify(v).slice(0, 240)
    else if (typeof v === 'string' && v) suspects[k] = v.slice(0, 240)
  }
  return {
    comment_id: String(c.comment_id || '').slice(0, 30) + '…',
    user: c.user_info && c.user_info.screen_name,
    text: c.text,
    textLen: (c.text || '').length,
    digg: c.digg_count, replyCount: c.reply_count,
    keys: Object.keys(c).sort(),
    suspects,
    fullShape: shape(c),
  }
})

/* 回复框 UI 探测：找所有 input/textarea，以及「表情」相关按钮 */
const ui = await page.evaluate(() => {
  const q = (sel) => [...document.querySelectorAll(sel)]
  const short = (el) => ({
    tag: el.tagName,
    cls: String(el.className || '').slice(0, 80),
    placeholder: el.getAttribute('placeholder') || '',
    text: (el.textContent || '').trim().slice(0, 30),
    aria: el.getAttribute('aria-label') || '',
  })
  const clickable = q('[class*=emoji],[class*=Emoji],[class*=expression],[class*=Expression],[class*=sticker],[class*=Sticker],[class*=emoticon]')
  return {
    textareas: q('textarea').map(short),
    inputs: q('input[type=text],input:not([type])').map(short),
    contentEditables: q('[contenteditable=true]').map(short),
    emojiLike: clickable.map(short).slice(0, 20),
    fileInputs: q('input[type=file]').map(el => ({ accept: el.getAttribute('accept') || '' })),
    imgBtns: q('img,svg,[class*=icon]').filter(el => /表情|emoji|图片|image/i.test((el.getAttribute('class') || '') + (el.getAttribute('alt') || '') + (el.getAttribute('aria-label') || ''))).map(short).slice(0, 15),
  }
})

const rec = { at: Date.now(), item: { id: String(it.id).slice(0, 40) + '…', plainId: it.plain || ITEM }, rawTopKeys: raw ? Object.keys(raw) : [], rows, ui }
fs.writeFileSync(out, JSON.stringify(rec, null, 1))

console.log('\n=== 原始顶层字段 ===', rec.rawTopKeys.join(', '))
console.log('\n=== 评论（重点看空正文那条）===')
for (const r of rows) {
  console.log(`- ${r.user} | text="${r.text}" (len ${r.textLen}) | ${new Date((list.find(c => true) && 0) || 0).getTime() ? '' : ''}`)
  if (!r.textLen) {
    console.log('  字段全集:', r.keys.join(','))
    console.log('  非空可疑字段:', JSON.stringify(r.suspects, null, 1).slice(0, 1200))
  }
}
console.log('\n=== 回复框 UI ===')
console.log(JSON.stringify(ui, null, 1).slice(0, 2000))
console.log('\n落盘:', out)

await ctx.close().catch(() => { })
