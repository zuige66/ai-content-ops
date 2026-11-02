/* tools/probe/capture-reply-api.mjs —— 抓一次真实的「回复」请求，拿到正确入参
 * ═══════════════════════════════════════════════════════════════
 * 背景：manage.mjs 记的 { comment_Id, item_id, text } 被服务端判「参数不合法」。
 * 这里用真人在页面上发一条回复的方式，把真实 POST 的 url + postData 抓下来。
 *
 * 🔴 会**真发一条**回复（不是干跑）。只发一条，用来换参数结构。
 * 用法：node tools/probe/capture-reply-api.mjs <评论文本关键字> <回复内容>
 *   例：node tools/probe/capture-reply-api.mjs 这鱼怎么是红色的 红的才显眼呀
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../../core/log.mjs'
import { launchPersistent } from '../../core/browser.mjs'

const NEEDLE = process.argv[2] || '这鱼怎么是红色的'
const TEXT = process.argv[3] || '红的才显眼呀'
const CREATOR = 'https://creator.douyin.com'

const { ctx } = await launchPersistent('douyin', { headless: false, pinned: true, viewport: { width: 1500, height: 950 } })
const page = await ctx.newPage()

const caught = []
page.on('request', (req) => {
  const u = req.url()
  if (!/douyin\.com/.test(u)) return
  if (req.method() !== 'POST') return
  const pd = req.postData() || ''
  /* 只关心评论相关的写接口 */
  if (!/comment/i.test(u)) return
  caught.push({ url: u.split('?')[0], query: u.split('?')[1] || '', body: pd.slice(0, 1200) })
})

await page.goto(`${CREATOR}/creator-micro/interactive/comment`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
await page.waitForLoadState('load', { timeout: 20000 }).catch(() => { })
await page.waitForTimeout(5000)

/* 定位「回复」按钮：直接用 playwright locator，它会自动把元素滚进视口
 * （评论列表是内部滚动容器，手写 scrollIntoView 折腾了三轮都不稳）。
 * --idx=N 指定第 N 个（0 起），默认第 5 个 = 第 6 条评论。 */
const idxArg = process.argv.find(a => a.startsWith('--idx='))
const IDX = idxArg ? Number(idxArg.slice(6)) : 5
const replyBtn = page.getByText('回复', { exact: true }).nth(IDX)
await replyBtn.waitFor({ state: 'attached', timeout: 20000 })
await replyBtn.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => { })
await page.waitForTimeout(600)
const target = await replyBtn.evaluate((el) => {
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), visible: r.y > 0 && r.y < innerHeight }
})
console.log('目标按钮可见?', target.visible)
console.log('点回复按钮 @', target)
await page.mouse.click(target.x, target.y)
await page.waitForTimeout(1800)

/* 输入框：优先 contenteditable，其次 textarea/input（都在回复框内，取最后出现的） */
const edit = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('[contenteditable=true],textarea,input[type=text]')]
    .filter(el => el.offsetWidth > 0)
  const el = cands[cands.length - 1]
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { tag: el.tagName, cls: String(el.className || '').slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) }
})
if (!edit) { console.error('没找到输入框'); await page.screenshot({ path: path.join(ROOT, 'state', 'cap-nofield.png') }); await ctx.close(); process.exit(1) }
console.log('输入框:', JSON.stringify(edit))

await page.mouse.click(edit.x, edit.y)
await page.waitForTimeout(500)
await page.keyboard.type(TEXT, { delay: 40 })
await page.waitForTimeout(800)
await page.screenshot({ path: path.join(ROOT, 'state', 'cap-typed.png') })

/* 点「发送」——回复框里那个，取最后一个可见的「发送」 */
const sendBtn = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('*')].filter(el =>
    el.children.length <= 1 && (el.textContent || '').trim() === '发送' && el.offsetWidth > 0)
  const el = btns[btns.length - 1]
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})
if (!sendBtn) { console.error('没找到发送按钮'); await ctx.close(); process.exit(1) }
console.log('点发送 @', sendBtn)
await page.mouse.click(sendBtn.x, sendBtn.y)
await page.waitForTimeout(4000)
await page.screenshot({ path: path.join(ROOT, 'state', 'cap-after-send.png') })

console.log('\n=== 抓到的 comment 相关 POST ===')
for (const c of caught) {
  console.log('URL:', c.url)
  console.log('QUERY:', c.query.slice(0, 300))
  console.log('BODY:', c.body)
  console.log('---')
}
fs.writeFileSync(path.join(ROOT, 'state', 'capture-reply-api.json'), JSON.stringify({ at: Date.now(), needle: NEEDLE, text: TEXT, caught }, null, 1))
console.log('落盘: state/capture-reply-api.json')

await ctx.close().catch(() => { })
