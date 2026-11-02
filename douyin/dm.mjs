/* douyin/dm.mjs —— 抖音私信（网页版 /chat）
 * ═══════════════════════════════════════════════════════════════
 * 为什么单独一个模块：私信走的是 www 域的聊天页，跟 creator 后台完全不同。
 * 而且**私信能发图片**（file input accept=".jpg,.jpeg,.png,.gif,.mp4"），
 * 评论区不能 —— 要回表情包只有这条路。
 *
 * 🔴 硬限制（页面自己写的）：
 *    「对方回复或关注你之前，只能发送一条文字消息」
 *    也就是对陌生人只能发 1 条，发完对方不回就发不出第二条。
 *    所以发给陌生人的内容必须是**一次到位**的，不能拆成几句。
 *
 * 🔴 只用 CDP 附着（attachLive），不自己起浏览器：
 *    /chat 是登录态页面，起新的空 profile 会要求重新扫码。
 *    连接用完只 disconnect，绝不 close —— close 会把用户的浏览器关掉。
 * ═══════════════════════════════════════════════════════════════
 */
import fs from 'node:fs'
import { chromium } from 'playwright-core'
import { logEvent } from '../core/log.mjs'
import { ensureLiveChrome } from '../core/browser.mjs'
import { readConfig } from '../core/shell.mjs'

const CHAT_URL = 'https://www.douyin.com/chat'
const SEL = {
  item: '[class*="conversationConversationItemwrapper"]',
  stranger: '[class*="conversationStrangerBoxwrapper"]',
  title: '[class*="conversationConversationItemtitle"]',
  current: '[class*="conversationConversationItemcurConversation"]',
  editor: '.messageEditorinputArea, [contenteditable="true"]',
  sendBtn: '[class*="publishBtn"]',
  fileInput: 'input[type="file"]',
}

let browser = null
let page = null
let strangerExpanded = false

/** 连上现有的 Chrome（9222），定位 /chat 页；没有就新开一个 tab。
 *  🔴 端口不能写死 9222：config.chrome.debugPort 才是真值。
 *     以前写死 + 从不调 ensureLiveChrome，调试端口没开时整轮私信直接报废。 */
export async function open({ port } = {}) {
  if (browser && browser.isConnected() && page && !page.isClosed()) return { page, reused: true }
  const cfg = (() => { try { return readConfig().chrome || {} } catch { return {} } })()
  const p = Number(port || cfg.debugPort || 9222)
  /* 先保证调试端口上有 Chrome 在跑 —— 没有就拉一个起来（独立进程，活过本脚本） */
  await ensureLiveChrome('douyin', { port: p })
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`)
  const ctx = browser.contexts()[0] || await browser.newContext()
  page = ctx.pages().find(p => p.url().includes('/chat'))
  strangerExpanded = false
  if (!page) {
    page = await ctx.newPage()
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await waitReady()
  }
  return { page, reused: Boolean(page) }
}

/** 等会话列表渲染出来（SPA，急不得） */
async function waitReady(timeoutMs = 25000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const n = await page.locator(SEL.item).count().catch(() => 0)
    if (n > 0) { await page.waitForTimeout(600); return true }
    await page.waitForTimeout(800)
  }
  return false
}

/** 布局体检。
 *  🔴 抖音聊天页有个「列表滑出」动画：展开陌生人分组时会滑出去，正常应该滑回来，
 *    但经常卡住 —— 整个 conversationConversationListwrapper 带着
 *    `transform: matrix(1,0,0,1,-303,0)`，所有会话被推到 x≈-303（视口左侧外面）。
 *    这时候元素"存在"但点不到：Playwright 的 click 会一直等到超时，
 *    而 el.click() 又能"点成功"（React 不响应）—— 表现为「所有会话读到的都是
 *    同一条消息」。先把 transform 清掉；清不掉再 reload 兜底。 */
async function ensureLayout() {
  const fixed = await page.evaluate(() => {
    const wrap = document.querySelector('[class*="ConversationListwrapper"]')
    if (!wrap) return 0
    const m = getComputedStyle(wrap).transform
    if (m && m !== 'none' && /matrix\(1,\s*0,\s*0,\s*1,\s*-?\d/.test(m)) {
      wrap.style.transform = 'none'
      return 1
    }
    return 0
  }).catch(() => 0)
  if (fixed) {
    await page.waitForTimeout(800)
    return true
  }
  /* 兜底：transform 清了还偏，就 reload */
  const broken = await page.evaluate(() => {
    const it = document.querySelector('[class*="conversationConversationItemwrapper"]')
      || document.querySelector('[class*="conversationStrangerBoxwrapper"]')
    if (!it) return false
    return it.getBoundingClientRect().x < -5
  }).catch(() => false)
  if (!broken) return false
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
  await page.waitForTimeout(7000)
  await waitReady()
  strangerExpanded = false
  return true
}

/** 断开 CDP（不关浏览器） */
export async function close() {
  if (browser) { await browser.close().catch(() => { }); browser = null; page = null }
}

/** 从会话项的一坨文本里剥出干净昵称。
 *  原始形如「森波拉周四10分钟内在线」「＠小邓不吃香菜08/16」——
 *  时间戳会粘在昵称后面，不剥掉的话按名字匹配会话永远匹配不上。 */
const TIME_TAIL = /(昨天\s*\d{1,2}:\d{2}|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|周[一二三四五六日])\s*$/
const ONLINE_TAIL = /\s*\d*分钟内?在线\s*$|\s*在线\s*$/
export function cleanName(raw) {
  let s = String(raw || '').trim()
  for (let i = 0; i < 3; i++) {
    const before = s
    s = s.replace(TIME_TAIL, '').replace(ONLINE_TAIL, '').trim()
    if (s === before) break
  }
  return s
}

/** 抖音把没互关的人的会话折叠在「陌生人消息」这一栏下面，**默认不展开**。
 *  不点开它，listSessions 只能看到已互关的会话 —— 真实来信全被藏起来了
 *  （第一版就是这样，用户看到的「陌生人消息没回复」其实是根本没读到）。
 *  点开之后再点一次会收起，所以这里要比对会话数量确认是"展开"而不是"收起"。 */
async function expandStranger() {
  if (strangerExpanded) return
  const sb = page.locator(SEL.stranger).first()
  if (!(await sb.count())) { strangerExpanded = true; return }
  const before = await page.locator(SEL.item).count()
  await sb.click({ timeout: 6000 }).catch(() => { })
  await page.waitForTimeout(1500)
  let after = await page.locator(SEL.item).count()
  if (after < before) {
    /* 点成收起了，再点一次展开 */
    await sb.click({ timeout: 6000 }).catch(() => { })
    await page.waitForTimeout(1500)
    after = await page.locator(SEL.item).count()
  }
  strangerExpanded = true
  return after
}

/* ══════════════════════════════════════════════════════════════════
 * 陌生人会话（折叠在「陌生人消息」分组里）
 * ══════════════════════════════════════════════════════════════════
 * 🔴 为什么单独一套：陌生人不走普通的 ConversationItem。
 *    点「陌生人消息」分组后，右侧会**变成陌生人会话列表页**（不是聊天窗），
 *    必须再点列表里的那一条才进聊天。而且左栏展开后子项和分组头的坐标重叠
 *    （子项 y≈88 落在分组 y 60~126 里），点左栏永远点到分组头上。
 *    所以固定走两级：点分组 → 点右栏列表项。
 */

/** 列出陌生人会话（会自动进到陌生人列表页）
 *  🔴 必须先回干净的 /chat：如果页面已经停在某个聊天窗里，
 *    再点「陌生人消息」分组不会弹出列表页（实测右栏只剩标题栏）。 */
export async function listStrangers() {
  await open()
  await backToNormal()
  await expandStranger()
  await ensureLayout()
  await page.waitForTimeout(1800)

  const rows = await page.evaluate(() => {
    const out = []
    const seen = new Set()
    for (const el of document.querySelectorAll('div,li,a')) {
      const rc = el.getBoundingClientRect()
      /* 右栏列表项：在右侧、够宽、高度像一行 */
      if (rc.x < 310) continue
      if (rc.width < 200) continue
      if (rc.height < 45 || rc.height > 120) continue
      if (el.children.length > 8) continue
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
      if (!t || t.length > 120) continue
      /* 必须有「名字 + 时间」这种形状 */
      const m = t.match(/^(.{1,20}?)\s*(昨天\s*\d{1,2}:\d{2}|\d{1,2}:\d{2}|\d{1,2}\/\d{1,2}|周[一二三四五六日])/)
      if (!m) continue
      const k = Math.round(rc.y) + '|' + m[1]
      if (seen.has(k)) continue
      seen.add(k)
      out.push({
        name: m[1].trim(),
        time: m[2],
        preview: t.slice(m[0].length).trim().slice(0, 60),
        x: Math.round(rc.x + rc.width / 2),
        y: Math.round(rc.y + rc.height / 2),
      })
    }
    return out
  })
  return { ok: true, strangers: rows }
}

/** 打开一个陌生人会话（点右栏列表项） */
export async function openStranger(name) {
  await open()
  await backToNormal()
  await expandStranger()
  await ensureLayout()
  await page.waitForTimeout(1800)

  const pos = await page.evaluate((want) => {
    for (const el of document.querySelectorAll('div,li,a')) {
      const rc = el.getBoundingClientRect()
      if (rc.x < 310 || rc.width < 200 || rc.height < 45 || rc.height > 120) continue
      if (el.children.length > 8) continue
      const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
      if (!t.startsWith(want)) continue
      return { x: Math.round(rc.x + rc.width / 2), y: Math.round(rc.y + rc.height / 2) }
    }
    return null
  }, name)

  if (!pos) throw new Error(`陌生人列表里找不到「${name}」`)
  await page.mouse.click(pos.x, pos.y)
  await page.waitForTimeout(3500)

  const ok = await page.evaluate(() => ({
    hasList: Boolean(document.querySelector('[class*="MessageListlist"]')),
    hasEditor: Boolean(document.querySelector('.messageEditorinputArea, [contenteditable="true"]')),
  }))
  if (!ok.hasList) throw new Error(`点开「${name}」后没有消息区（可能没进到聊天）`)
  return { ok: true, name, hasEditor: ok.hasEditor }
}

/** 回到普通会话列表（陌生人列表页是临时状态，发完要退出来） */
export async function backToNormal() {
  await open()
  await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
  await page.waitForTimeout(5000)
  strangerExpanded = false
  await waitReady()
  await ensureLayout()
  return { ok: true }
}


export async function listSessions() {
  await open()
  if (!(await waitReady())) return { ok: false, error: '会话列表没加载出来（可能登录态掉了）' }
  await ensureLayout()
  await expandStranger()
  await ensureLayout()
  const rows = await page.evaluate((sel) => {
    const items = [...document.querySelectorAll(sel)]
    return items.map((el, i) => {
      const t = el.querySelector('[class*="title"]')
      const all = (el.innerText || '').trim()
      const lines = all.split('\n').map(s => s.trim()).filter(Boolean)
      const name = (t && t.textContent || lines[0] || '').trim()
      /* 预览 = 去掉昵称、时间、在线状态那几行之后剩下的 */
      const preview = lines.filter(x => !/^\d{1,2}:\d{2}$|^\d{1,2}\/\d{1,2}$|^昨天|^周[一二三四五六日]/.test(x)).slice(1).join(' ')
      const hasBadge = Boolean(el.querySelector('[class*="unread"],[class*="badge"],[class*="Badge"]'))
      return { i, name, preview: preview.slice(0, 60), hasBadge }
    })
  }, SEL.item)
  for (const r of rows) r.name = cleanName(r.name)
  return { ok: true, sessions: rows }
}

/** 点开一个会话。
 *  **只接受名字** —— 展开陌生人分组后列表会按时间重排，序号在两次点击之间
 *  就变了，按 nth(i) 点会点到别人头上（实测两次都点到了"活这就行"）。
 *  名字是唯一稳定的锚点。 */
export async function openSession(iOrName) {
  await open()
  await ensureLayout()
  await expandStranger()
  await ensureLayout()   // 展开那一下会把列表滑走，必须再校一次

  if (typeof iOrName === 'string') {
    /* 🔴 必须用**真实鼠标点击**。在 evaluate 里调 el.click() 只会让标题变，
     *    右侧消息区不加载、出来全是空 —— React 只认真实事件流。
     *    所以这里先算出元素坐标再 mouse.click。 */
    const findBox = () => page.evaluate((want) => {
      const items = [...document.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
      for (const el of items) {
        const t = el.querySelector('[class*="title"]')
        const txt = (t && t.textContent || '').trim()
        if (!txt.includes(want)) continue
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), name: txt, visible: r.x > 0 && r.y > 0 && r.y < innerHeight - 20 }
      }
      return null
    }, iOrName)

    let box = await findBox()
    if (!box) throw new Error(`找不到会话「${iOrName}」`)
    if (!box.visible) { await ensureLayout(); box = await findBox() }
    if (!box) throw new Error(`会话「${iOrName}」位置异常`)

    /* 点完必须核对「当前会话」确实是目标 —— 这个页面偶尔右键头切了、
     * 消息区还停在上一个人，继续读就会把别人的话当成新消息（甚至回错人）。
     * 所以最多试 3 次，对不上就抛错，宁可这轮不回。 */
    const curName = () => page.evaluate(() => {
      const c = document.querySelector('[class*="curConversation"]')
      const t = c && c.querySelector('[class*="title"]')
      return (t && t.textContent || '').trim()
    })

    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.click(box.x, box.y)
      await page.waitForTimeout(2200)
      const cur = cleanName(await curName())
      if (cur.includes(iOrName) || iOrName.includes(cur)) {
        return { ok: true, name: cur || cleanName(box.name) }
      }
      /* 位置可能变了（列表重排），重新算一次再点 */
      const b2 = await findBox()
      if (b2) box = b2
    }
    throw new Error(`点了 3 次都没切到「${iOrName}」，放弃（防止读到别人的消息）`)
  }

  /* 🔴 序号分支已删除。它按 nth() 点，回退 el.click()（AGENTS 明令禁止：
   *    React 只认真实事件流），而且只读一次 .current 不核对是不是切到了目标
   *    —— 这个页面偶尔右键头切了、消息区还停在上一个人，继续读就会把别人的话
   *    当新消息，甚至回错人。列表本身还会重排，序号在两次调用之间就变了。
   *    调用方一律用名字（见 auto-reply.mjs），这里直接拒绝，别留一条违反红线的路。 */
  throw new Error(`openSession 只接受会话名（收到 ${JSON.stringify(iOrName)}）—— 序号会因列表重排而错位，且无法核对当前会话`)
}

/** 抖音在聊天页塞的系统提示，不是真人说的话。
 *  这些必须排除：误当成「对方刚说话」，就会给没开口的陌生人发私信
 *  （第一版就是这么错的，民T间无名客和＠小邓不吃香菜都被判成"有新消息"）。 */
const SYSTEM_HINTS = [
  /只能发送一条文字消息/,
  /对方回复或关注你之前/,
  /暂不支持该消息类型/,
  /对方设置了隐私/,
  /消息已发出，但被对方拒收/,
  /我是抖音安全助手/,
]
export function isSystemText(t) {
  const s = String(t || '')
  return !s || SYSTEM_HINTS.some(re => re.test(s))
}

/** 读当前会话的消息（从旧到新）。
 *  归属用 `isFromMe` 类名判断 —— 这是页面自己标的，比按坐标猜准得多。
 *  系统提示保留在列表里但打 system 标记，调用方自己决定要不要当"对方说话"。 */
export async function readThread({ limit = 20 } = {}) {
  await open()
  const msgs = await page.evaluate((n) => {
    const list = document.querySelector('[class*="MessageListlist"]')
    if (!list) return { err: '没找到消息列表容器' }
    const rows = []
    for (const child of list.children) {
      const text = (child.innerText || '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const self = Boolean(child.querySelector('[class*="isFromMe"]'))
      /* 时间分隔条有两种：一种是独立节点（没有 contentBox），
       * 另一种混在消息节点里只剩一行时间文本。两种都要排掉，
       * 否则「他> 昨天 20:42」会被当成对方说了一句话。 */
      const timeOnly = !child.querySelector('[class*="contentBox"]')
        || /^(昨天|今天|前天)?\s*\d{1,2}:\d{2}$/.test(text)
        || /^周[一二三四五六日]\s*\d{1,2}:\d{2}$/.test(text)
        || /^周[一二三四五六日]$/.test(text)
        || /^\d{1,2}\/\d{1,2}$/.test(text)
      rows.push({ text: text.slice(0, 300), self, timeOnly })
    }
    return { rows: rows.slice(-n) }
  }, limit)
  if (msgs.err) return { ok: false, error: msgs.err }
  const out = msgs.rows.map(r => ({ ...r, system: !r.timeOnly && isSystemText(r.text) }))
  return { ok: true, messages: out }
}

/** 判断这个会话「我能不能再发」。
 *  🔴 那句「只能发送一条文字消息」在左侧会话列表的预览里也会出现，
 *     所以要**只在右侧消息区内**找，不能查全页 body（第一版就栽在这，
 *     四个会话全被判成限一条）。 */
export async function canSend() {
  await open()
  const info = await page.evaluate(() => {
    const list = document.querySelector('[class*="MessageListlist"]')
    const areaText = list ? (list.innerText || '') : ''
    const limited = /只能发送一条文字消息|对方回复或关注你之前/.test(areaText)
    const editor = document.querySelector('.messageEditorinputArea, [contenteditable="true"]')
    const editable = editor ? editor.getAttribute('contenteditable') !== 'false' : false
    const placeholder = editor ? String(editor.getAttribute('data-placeholder') || editor.innerText || '') : ''
    /* 有些会话（系统通知/不支持的类型）输入区会被禁用或干脆不渲染 */
    return { limited, hasEditor: Boolean(editor), editable, placeholder: placeholder.slice(0, 40) }
  })
  return {
    canSend: info.hasEditor && info.editable,
    limited: info.limited,
    note: info.limited ? '对方回复前只能发一条文字' : '',
  }
}

/** 发一条文字。返回实际发出去的内容。 */
export async function sendText(text) {
  await open()
  const body = String(text || '').trim()
  if (!body) throw new Error('私信内容不能为空')
  if (body.length > 500) throw new Error(`私信太长（${body.length} 字）`)

  const editor = page.locator(SEL.editor).first()
  await editor.waitFor({ state: 'visible', timeout: 10000 })
  await editor.click()
  await page.waitForTimeout(300)
  /* contenteditable 里 type 比 fill 稳：fill 对 contenteditable 支持不好 */
  await page.keyboard.type(body, { delay: 30 })
  await page.waitForTimeout(500)

  const before = await page.evaluate(() => (document.body.innerText || '').length)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)

  /* 校验：发出去之后输入框应该空了，页面长度会变 */
  const after = await page.evaluate(() => {
    const ed = document.querySelector('.messageEditorinputArea, [contenteditable="true"]')
    return { len: (document.body.innerText || '').length, editorText: (ed && ed.innerText || '').trim() }
  })
  const sent = after.editorText.length === 0 && after.len !== before
  logEvent('douyin', 'dm.send', { ok: sent, len: body.length })
  if (!sent) throw new Error('私信可能没发出去（输入框没清空）')
  return { sent: true, text: body }
}

/** 发一张图片。走隐藏的 file input，避免点附件按钮弹出系统对话框。 */
export async function sendImage(filePath) {
  await open()
  if (!fs.existsSync(filePath)) throw new Error('图片不存在：' + filePath)
  const size = fs.statSync(filePath).size
  if (size > 20 * 1024 * 1024) throw new Error(`图片太大（${(size / 1024 / 1024).toFixed(1)}MB）`)
  if (!/\.(jpe?g|png|gif)$/i.test(filePath)) throw new Error('只支持 jpg/png/gif')

  const inputs = page.locator(SEL.fileInput)
  const n = await inputs.count()
  if (!n) throw new Error('页面上没有 file input，发不了图')
  await inputs.first().setInputFiles(filePath)
  await page.waitForTimeout(5000)

  /* 塞进去之后会弹「发送给 XX / 文件名 / 大小 / 取消 / 发送（1）」的确认条 */
  const sendBtn = page.getByText(/^发送（\d+）$|^发送\(\d+\)$/).last()
  if (!(await sendBtn.count())) {
    await page.getByText('取消', { exact: true }).last().click({ timeout: 3000 }).catch(() => { })
    throw new Error('塞图后没出现确认条')
  }
  await sendBtn.click({ timeout: 8000 })
  await page.waitForTimeout(4000)
  logEvent('douyin', 'dm.sendImage', { ok: true, file: filePath.split(/[\\/]/).pop(), kb: Math.round(size / 1024) })
  return { sent: true, file: filePath, kb: Math.round(size / 1024) }
}

/** 取消掉待发送的图片（清理测试残留用） */
export async function cancelPending() {
  await open()
  const c = page.getByText('取消', { exact: true }).last()
  if (await c.count()) { await c.click({ timeout: 3000 }).catch(() => { }) ; return true }
  return false
}
