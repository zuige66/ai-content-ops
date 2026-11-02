/* tools/auto-reply.mjs —— 平峰时段自动回评论 + 回私信
 * ═══════════════════════════════════════════════════════════════
 * 为什么限定平峰：DeepSeek 2026-08-17 起改峰谷定价，工作日
 * 09:00–12:00 / 14:00–18:00 价格翻倍。自动回复是纯后台活儿，不赶时间，
 * 放平峰跑就是白省一半。判断逻辑在 core/offpeak.mjs。
 *
 * 两类活儿：
 *   评论 —— creator 后台接口，走 server 的 POST /douyin/reply（自带熔断+60s限速）
 *   私信 —— www.douyin.com/chat，走 douyin/dm.mjs（CDP 附着）
 *
 * 🔴 幂等靠 state/auto-reply-state.json：
 *    · 已回过的 commentId 永久记账，不重复回
 *    · 私信存每个会话的「消息指纹」，指纹没变就不再打扰
 *
 * 用法：
 *   node tools/auto-reply.mjs            # 按当前时段判断，平峰才干活
 *   node tools/auto-reply.mjs --force    # 忽略时段（手动调试用）
 *   node tools/auto-reply.mjs --dry      # 只生成不发送
 *   node tools/auto-reply.mjs --yes      # 真发（不加就只演练）
 *   node tools/auto-reply.mjs --no-dm    # 这轮不回私信
 *   node tools/auto-reply.mjs --sticker  # 强制本轮对图片消息回表情包
 * ═══════════════════════════════════════════════════════════════
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT, logEvent } from '../core/log.mjs'
import { chatJsonDetailed } from '../core/llm.mjs'
import { isOffPeak, describe } from '../core/offpeak.mjs'
import { readConfig } from '../core/shell.mjs'
import * as insight from '../douyin/insight.mjs'
import * as dm from '../douyin/dm.mjs'

const ARGS = process.argv.slice(2)
const FORCE = ARGS.includes('--force')
const DRY = ARGS.includes('--dry')
const YES = ARGS.includes('--yes') && !DRY
const NO_DM = ARGS.includes('--no-dm')
const WANT_STICKER = ARGS.includes('--sticker')

const BASE = 'http://127.0.0.1:18090'
const STATE_FILE = path.join(ROOT, 'state', 'auto-reply-state.json')
const STICKER = path.join(ROOT, 'assets', 'stickers', 'sticker-01-hongshaoyu.png')

/* 人设卡：优先用 config.json 里配的路径，其次几个常见位置，最后退回内置简版。
 * 🔴 以前写死 D:/Workplace/zhibo/prompts/...，换机器就静默退化成简版人设，
 *    回复语气会整个跑偏，而日志里只留一句「用简版人设」很容易看漏。 */
function resolvePersonaFile() {
  const fromCfg = (() => {
    try { return readConfig().persona || '' } catch { return '' }
  })()
  const candidates = [
    fromCfg,
    path.join(ROOT, 'assets', 'persona.md'),
    path.join(ROOT, 'prompts', 'dafeiyu-live.md'),
    'D:/Workplace/zhibo/prompts/dafeiyu-live.md',
  ].filter(Boolean)
  for (const f of candidates) {
    try { if (fs.statSync(f).isFile()) return f } catch { /* 试下一个 */ }
  }
  return ''
}
const PERSONA_FILE = resolvePersonaFile()

const MAX_PER_VIDEO = 8        // 单条视频单轮最多回几条，防失控
const DM_GAP_MS = 12000        // 私信之间隔久一点，私信风控比评论严
const VIDEO_LOOKBACK = 2       // 只看最新几条作品

/* ═══════════ 状态 ═══════════ */
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return { repliedComments: s.repliedComments || {}, dmSeen: s.dmSeen || {}, lastRun: s.lastRun || null }
  } catch {
    return { repliedComments: {}, dmSeen: {}, lastRun: null }
  }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  const replied = s.repliedComments
  /* 只留最近 400 条，防止文件无限膨胀 */
  const keys = Object.keys(replied).sort((a, b) => (replied[b].at || 0) - (replied[a].at || 0))
  for (const k of keys.slice(400)) delete replied[k]
  s.lastRun = Date.now()
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1), 'utf8')
}

const state = loadState()
const fingerprint = (msgs) => crypto.createHash('md5')
  .update(msgs.map(m => (m.self ? 's:' : 'o:') + m.text).join('|'))
  .digest('hex').slice(0, 16)

function log(...a) { console.log(...a) }

/* ═══════════ 时段闸 ═══════════ */
log(`[时段] ${describe()}`)

/* 总开关：state/auto-reply-enabled.json 里 {"enabled":false} 就彻底不干活。
 * 用途是「临时别回」（出差、生病、想静一天），比去暂停自动化任务轻。
 * 默认不存在 = 开着。 */
const ENABLE_FILE = path.join(ROOT, 'state', 'auto-reply-enabled.json')
function isEnabled() {
  try { return JSON.parse(fs.readFileSync(ENABLE_FILE, 'utf8')).enabled !== false } catch { return true }
}
if (ARGS.includes('--off')) {
  fs.mkdirSync(path.dirname(ENABLE_FILE), { recursive: true })
  fs.writeFileSync(ENABLE_FILE, JSON.stringify({ enabled: false, at: new Date().toISOString() }, null, 1), 'utf8')
  log('[已关] 自动回复总开关关掉了。要恢复：node tools/auto-reply.mjs --on')
  process.exit(0)
}
if (ARGS.includes('--on')) {
  fs.mkdirSync(path.dirname(ENABLE_FILE), { recursive: true })
  fs.writeFileSync(ENABLE_FILE, JSON.stringify({ enabled: true, at: new Date().toISOString() }, null, 1), 'utf8')
  log('[已开] 自动回复总开关打开了。')
  process.exit(0)
}
if (!isEnabled()) {
  log('[跳过] 总开关是关的（state/auto-reply-enabled.json）。恢复：node tools/auto-reply.mjs --on')
  process.exit(0)
}

if (!isOffPeak() && !FORCE) {
  log('[跳过] 现在是 DeepSeek 高峰时段（工作日 9-12 / 14-18，价格翻倍）。')
  log('       下一轮平峰时段再来；想立刻跑加 --force。')
  logEvent('douyin', 'autoReply.skip', { ok: true, why: 'peak', when: describe() })
  process.exit(0)
}
if (!isOffPeak() && FORCE) log('[注意] 高峰时段强制跑，这一轮 LLM 花费翻倍。')

/* ═══════════ 人设 ═══════════ */
let persona = ''
try {
  persona = fs.readFileSync(PERSONA_FILE, 'utf8').split('\n').slice(0, 130).join('\n')
} catch {
  persona = '大肥鱼：软糯的 AI 女仆小姑娘，广东工业大学在读，蓝色头发，尾巴是鲸鱼尾。'
  log('[警告] 读不到角色卡，用简版人设')
}

/* ═══════════ 服务健康检查（评论发送依赖它） ═══════════ */
async function serverAlive() {
  try {
    const r = await fetch(BASE + '/douyin/cache', { signal: AbortSignal.timeout(4000) })
    return r.ok
  } catch { return false }
}

/** 服务没在跑就自己拉一个。
 *  为什么要自己拉：自动化触发时不保证 server 还活着（重启机器、手动关掉都常见），
 *  让脚本直接 exit 2 的话这一轮就白跑了，用户还看不到任何提示。
 *  用 detached 起，让 server 活过本脚本退出。 */
async function ensureServer() {
  if (await serverAlive()) return true
  log('[服务] 18090 没响应，正在拉一个 server 进程…')
  const { spawn } = await import('node:child_process')
  const logDir = path.join(ROOT, '.run')
  fs.mkdirSync(logDir, { recursive: true })
  const out = fs.openSync(path.join(logDir, 'auto-reply-server.log'), 'a')
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
    env: process.env,
  })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1000))
    if (await serverAlive()) { log(`[服务] 起来了（pid ${child.pid}）`); return true }
  }
  return false
}

/* ══════════════════════════════════════════════════════════════════
 * 一、评论
 * 🔴 全程走 server 的 HTTP 接口，**不自己 launchPersistent** ——
 *    server 已经占着 sessions/douyin 这个 profile，脚本再起一个必然报
 *    「Target page, context or browser has been closed」（第一版就栽在这）。
 *    顺带还能白拿 server 的熔断器和 60 秒限速。
 * ══════════════════════════════════════════════════════════════════ */
async function api(pathname, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + pathname, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  })
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`)
  return j
}

async function handleComments() {
  /* 先让 server 去抓一遍新的（它自己有缓存，force 才真打抖音） */
  await api('/douyin/refresh', { method: 'POST' }).catch(e => log('[评论] 刷新失败（继续用缓存）：' + String(e.message).slice(0, 80)))

  const works = await api(`/douyin/works?limit=${VIDEO_LOOKBACK}`)
  const targets = (works.items || []).slice(0, VIDEO_LOOKBACK)
  log(`[评论] 检查最近 ${targets.length} 条作品`)

  const pending = []
  for (const w of targets) {
    let list
    try {
      list = await api(`/douyin/comments?item=${encodeURIComponent(w.plainId)}&count=30`)
    } catch (e) {
      log(`  · ${w.plainId} 拉评论失败：${String(e.message).slice(0, 80)}`)
      continue
    }
    log(`  · ${String(w.title || '').slice(0, 20)} 评论 ${list.comments.length} 条`)

    for (const c of list.comments) {
      const key = String(c.numId || c.id)
      if (state.repliedComments[key]) continue          // 本地账本已记
      if (c.isAuthor) continue                          // 自己发的不回
      /* replyCount>0 时才去查是不是我回的 —— 每条都查太慢 */
      let mine = []
      if (c.replyCount > 0) {
        const r = await api(`/douyin/replies?comment=${encodeURIComponent(c.id)}`).catch(() => null)
        if (r && r.ok) mine = (r.replies || []).filter(x => x.isAuthor).map(x => x.text)
      }
      if (mine.length) {
        state.repliedComments[key] = { at: Date.now(), why: 'history', user: c.user }
        continue
      }
      pending.push({
        itemPlain: w.plainId, commentId: c.id, numId: c.numId || '',
        user: c.user, text: c.text || '', isImage: Boolean(c.isImage),
        replyCount: c.replyCount,
      })
    }
  }

  /* 每条视频最多回 MAX_PER_VIDEO 条 */
  const byVideo = {}
  const clipped = []
  for (const p of pending) {
    byVideo[p.itemPlain] = byVideo[p.itemPlain] || 0
    if (byVideo[p.itemPlain] >= MAX_PER_VIDEO) continue
    byVideo[p.itemPlain]++
    clipped.push(p)
  }

  log(`[评论] 待回 ${pending.length} 条，本轮取 ${clipped.length} 条`)
  if (!clipped.length) return { checked: pending.length, sent: 0 }

  /* ── LLM 批量生成（一次调用，省 token） ── */
  const sys = `你在替抖音账号「zuige大肥鱼」回复自己视频下的评论。以下是你的人设卡，必须严格遵守：

${persona}

补充规则（评论区场景，与直播间不同，优先遵守）：
1. 每条回复 **20 个汉字以内**，一句话，**句尾不加句号**。
2. 不要 emoji 表情字符（🍚🐟❤️ 这类一律不用）。抖音官方表情请写成 [看] [发怒] 这种方括号编码，最多用一个。
3. 可以直接叫对方昵称，也可以叫「你」；不许叫「宝宝/亲爱的/老婆/主人」。
4. 遇到梗要接住，不要客套。白饭、红烧、广工、鲸鱼 都是自己的梗。
5. 对方发的是**图片评论**（isImage=true，通常是表情包），就用文字应一声、逗一句，不要假装看见了具体内容。
6. 不讨礼物、不喊关注点赞、不提任何金融/收益/仓位相关的词。
7. 不要重复对方原话，不要复读。
8. 语气软糯、有点小迷糊，但不能蠢；被骂也别硬顶。

只输出 JSON：{"replies":[{"i":0,"reply":"..."}]}`

  const payload = clipped.map((p, i) => ({ i, user: p.user, text: p.text, isImage: p.isImage }))
  let drafts = []
  try {
    const { data, usage, ms } = await chatJsonDetailed({ system: sys, user: JSON.stringify(payload, null, 1), maxTokens: 1200, temperature: 0.9 })
    log(`[评论] LLM ${ms}ms / ${usage.total_tokens || '?'} tokens`)
    drafts = (data.replies || []).map(x => ({ ...clipped[x.i], reply: String(x.reply || '').trim() })).filter(x => x.reply && x.itemPlain)
  } catch (e) {
    log('[评论] LLM 失败：' + String(e.message || e).slice(0, 200))
    return { checked: pending.length, sent: 0, error: 'llm' }
  }

  for (const d of drafts) log(`   ${d.user}${d.isImage ? '（图片）' : ''}: "${d.text.slice(0, 20)}" → "${d.reply}"`)

  if (!YES) {
    log(`[评论] 演练模式，${drafts.length} 条都没发（加 --yes 才发）`)
    return { checked: pending.length, ready: drafts.length, sent: 0 }
  }

  /* ── 发送 ── */
  let sent = 0, fail = 0, stoppedAtPeak = false
  for (const [n, d] of drafts.entries()) {
    /* 时段守卫：一轮最多 16 条 × 60 秒 ≈ 16 分钟，8:00 起跑碰不到 9:00。
     * 但网络卡住/评论暴涨时仍可能滑进高峰，所以每条前再确认一次 ——
     * 进了高峰就停手，剩下的留到下一轮。宁可晚点回，也不要出现
     * 「9 点还在别人视频底下发消息」这种事。 */
    if (!isOffPeak() && !FORCE) {
      log('[评论] 已进入高峰时段，停止发送，剩余留到下一轮')
      stoppedAtPeak = true
      break
    }
    const tag = `[${n + 1}/${drafts.length}] ${d.user}`
    try {
      /* 🔴 两步走，别再一条命令直发：先不带 confirm 回显 payload，
       *    确认服务端认得这组 id 之后再带 confirm:true 真发。
       *    以前这里直接 confirm:true，等于把「两段式」这道闸在脚本里自己拆了。 */
      const preview = await api('/douyin/reply', {
        method: 'POST',
        body: { itemId: d.itemPlain, commentId: d.commentId, commentIdNum: d.numId, text: d.reply },
      })
      if (preview && preview.ok === false) throw new Error(preview.error || '回显阶段被拒')
      await api('/douyin/reply', {
        method: 'POST',
        body: { itemId: d.itemPlain, commentId: d.commentId, commentIdNum: d.numId, text: d.reply, confirm: true },
      })
      log(`${tag} ✅ ${d.reply}`)
      state.repliedComments[String(d.numId || d.commentId)] = { at: Date.now(), user: d.user, reply: d.reply }
      saveState(state)
      sent++
    } catch (e) {
      const msg = String(e.message || e).slice(0, 150)
      log(`${tag} ❌ ${msg}`)
      fail++
      if (/熔断|未登录|体检不通过|掉号/.test(msg)) { log('[评论] 命中熔断/掉号，停止本轮'); break }
    }
  }

  log(`[评论] 发出 ${sent} 条，失败 ${fail} 条${stoppedAtPeak ? '（因进入高峰提前停止）' : ''}`)
  return { checked: pending.length, sent, fail, stoppedAtPeak }
}

/* ══════════════════════════════════════════════════════════════════
 * 二、私信
 * ══════════════════════════════════════════════════════════════════ */
async function handleDm() {
  /* 先把页面拉回干净的 /chat —— 上一次可能停在某个陌生人列表页或聊天窗里，
   * 直接读会话会全部「读消息失败」。 */
  await dm.backToNormal().catch(() => { })
  let s
  try {
    s = await dm.listSessions()
  } catch (e) {
    log('[私信] 打不开聊天页：' + String(e.message || e).slice(0, 150))
    return { sent: 0, error: 'open' }
  }
  if (!s.ok) { log('[私信] ' + s.error); return { sent: 0, error: s.error } }
  log(`[私信] ${s.sessions.length} 个会话`)

  const queue = []
  for (const sess of s.sessions) {
    if (!sess.name) continue
    if (sess.name === '陌生人消息') continue       // 聚合入口，不是真会话
    if (/系统通知|官方|小助手/.test(sess.name)) continue

    /* 按名字点，不按序号 —— 列表会重排，序号在两次调用之间就变了 */
    await dm.openSession(sess.name)
    await new Promise(r => setTimeout(r, 1200))
    const t = await dm.readThread({ limit: 12 })
    if (!t.ok) { log(`  · ${sess.name} 读消息失败`); continue }

    const msgs = t.messages
    /* 只看真人说的话：时间分隔条和抖音系统提示（"只能发送一条文字消息"这类）
     * 都不算"对方刚开口"。第一版没过滤，结果给两个根本没说话的陌生人各发了
     * 一条私信 —— 私信只能发一次，发错就补不回来了。 */
    const real = msgs.filter(m => !m.timeOnly && !m.system)
    const fp = fingerprint(real)
    const seen = state.dmSeen[sess.name]
    const lastReal = real[real.length - 1]
    const lastMine = [...real].reverse().find(m => m.self)
    const lastIsOther = Boolean(lastReal && !lastReal.self)

    log(`  · ${sess.name}｜真人消息 ${real.length} 条｜${lastReal ? (lastIsOther ? '最后一条来自对方' : '最后一条是我') : '没有真人消息'}`)

    if (!lastReal) { continue }                   // 纯系统会话，跳过
    /* 判断要不要回：
     *   ① 指纹变了（有新消息）
     *   ② 最后一条是对方说的（说明轮到我了） */
    if (seen && seen.fp === fp) { continue }
    if (!lastIsOther) { state.dmSeen[sess.name] = { fp, at: Date.now() }; continue }

    const info = await dm.canSend()
    if (!info.canSend) { log(`    → 输入区不可用，跳过`); continue }
    if (info.limited && lastMine) {
      /* 对方回复前只能发一条，而我已经发过了 —— 这一轮不能发 */
      log(`    → 限一条且我已发过，等对方先回`)
      state.dmSeen[sess.name] = { fp, at: Date.now() }
      continue
    }

    queue.push({ name: sess.name, i: sess.i, msgs, real, fp, limited: info.limited })
  }

  if (!queue.length) { log('[私信] 没有需要回的会话'); return { sent: 0 } }

  /* ── LLM 生成私信回复 ── */
  const sys = `你在扮演抖音账号「zuige大肥鱼」回私信。人设卡：

${persona}

私信场景规则（比评论区更克制）：
1. **30 个汉字以内**，可以两小句，句尾不加句号，不用 emoji 字符（要就用 [看] 这种方括号编码，最多一个）。
2. 陌生人的私信**对方回复前我只能发一条**，所以这一句必须一次到位：接住对方的话 + 留个尾巴。
3. 不许叫「宝宝/亲爱的/老婆/主人」；不许要礼物、不许喊关注、不许加微信/QQ/任何站外联系方式。
4. 不透露真实住址、学校具体位置、主人是谁、设备细节。
5. 被问「你是不是 AI」就软软地岔开，不承认也不否认地打太极。
6. 完全不提任何金融/收益/仓位/合约相关的词。
7. 如果对方最后一条是图片或看不懂的内容（isImage=true），就轻松带过，别硬猜。
8. 不要复读对方原话。

只输出 JSON：{"replies":[{"i":0,"reply":"...","isImage":false}]}
其中 isImage=true 表示你判断对方最后一条是图片/表情包、用文字不好接，建议直接回表情包。`

  const payload = queue.map((q, i) => {
    const last = q.real[q.real.length - 1]
    return {
      i, name: q.name,
      lastText: last.text,
      isImage: !last.text || /暂不支持该消息类型|\[图片\]/.test(last.text),
      recent: q.real.slice(-4).map(m => (m.self ? '我: ' : '对方: ') + m.text),
    }
  })

  let plans = []
  try {
    const { data, usage, ms } = await chatJsonDetailed({ system: sys, user: JSON.stringify(payload, null, 1), maxTokens: 1000, temperature: 0.9 })
    log(`[私信] LLM ${ms}ms / ${usage.total_tokens || '?'} tokens`)
    plans = (data.replies || []).map(x => {
      const q = queue[x.i]
      if (!q) return null
      return { ...q, reply: String(x.reply || '').trim(), sticker: Boolean(x.isImage) || WANT_STICKER }
    }).filter(Boolean)
  } catch (e) {
    log('[私信] LLM 失败：' + String(e.message || e).slice(0, 200))
    return { sent: 0, error: 'llm' }
  }

  for (const p of plans) log(`   ${p.name}: ${p.sticker ? '（回表情包）' : '"' + p.reply + '"'}`)

  if (!YES) {
    log(`[私信] 演练模式，${plans.length} 条都没发（加 --yes 才发）`)
    return { ready: plans.length, sent: 0 }
  }

  let sent = 0
  for (const p of plans) {
    if (!isOffPeak() && !FORCE) { log('[私信] 已进入高峰时段，停止发送，剩余留到下一轮'); break }
    try {
      await dm.openSession(p.name)
      await new Promise(r => setTimeout(r, 1500))
      if (p.sticker && fs.existsSync(STICKER)) {
        await dm.sendImage(STICKER)
        log(`   ${p.name} ✅ 已发表情包`)
      } else if (p.reply) {
        await dm.sendText(p.reply)
        log(`   ${p.name} ✅ ${p.reply}`)
      } else {
        log(`   ${p.name} ⏭ 没有内容，跳过`)
        continue
      }
      state.dmSeen[p.name] = { fp: 'sent-' + Date.now(), at: Date.now() }
      saveState(state)
      sent++
      await new Promise(r => setTimeout(r, DM_GAP_MS))
    } catch (e) {
      log(`   ${p.name} ❌ ${String(e.message || e).slice(0, 150)}`)
    }
  }
  return { sent }
}

/* ══════════════════════════════════════════════════════════════════
 * 三、陌生人消息（只报告，不自动发）
 * ══════════════════════════════════════════════════════════════════
 * 为什么不做全自动：
 *   1. 「陌生人消息」分组**跟未读绑定** —— 读过一次就收起来，入口消失，
 *      想再进去只能等新消息。自动化跑到第二轮就找不到入口了。
 *   2. 展开后左栏子项被分组头遮挡（子项 y≈88 落在分组 60~126 里），
 *      坐标点永远点到分组头上，只有布局偶然崩坏时才能点进去。
 *   3. 抖音规定对陌生人**只能发一条文字**，发错无法撤回重发。
 * 所以改成：能读到就列出来推给用户，发不发由人决定。
 */
async function reportStrangers() {
  try {
    const s = await dm.listStrangers()
    if (!s.ok) return { error: s.error }
    if (!s.strangers.length) return { found: 0 }
    log(`[陌生人] 发现 ${s.strangers.length} 个会话（只报告，不自动发）`)
    for (const x of s.strangers) log(`   ${x.name}（${x.time}）：${x.preview}`)
    return { found: s.strangers.length, list: s.strangers.map(x => ({ name: x.name, time: x.time, preview: x.preview })) }
  } catch (e) {
    return { error: String(e.message || e).slice(0, 160) }
  }
}


const summary = { at: new Date().toISOString(), mode: YES ? 'send' : 'dry', when: describe() }

const alive = await ensureServer()
if (!alive) {
  log('[致命] 控制台服务拉不起来（' + BASE + ' 打不通，自动 spawn 也失败）。')
  log('       手动跑一次：node server.mjs  或双击 start-backend.bat')
  log('       评论发送依赖它的熔断器和限速，不能绕过。')
  process.exit(2)
}

try {
  summary.comments = await handleComments()
} catch (e) {
  summary.comments = { error: String(e.message || e).slice(0, 200) }
  log('[评论] 异常：' + summary.comments.error)
}

if (!NO_DM) {
  try {
    summary.dm = await handleDm()
  } catch (e) {
    summary.dm = { error: String(e.message || e).slice(0, 200) }
    log('[私信] 异常：' + summary.dm.error)
  }
  try {
    summary.strangers = await reportStrangers()
  } catch (e) {
    summary.strangers = { error: String(e.message || e).slice(0, 160) }
  }
} else {
  log('[私信] 本轮跳过（--no-dm）')
}

/* 收尾：只断开 CDP 连接，**绝不关用户的浏览器**。
 * 🔴 以前这里 getLive('douyin').close() —— liveMode 下那个 context 就是
 *    用户自己的 Chrome，一 close 窗口就没了；而且和 douyin/dm.mjs 头部
 *    「连接用完只 disconnect，绝不 close」的约定直接矛盾。 */
await dm.close().catch(() => { })

saveState(state)
const out = path.join(ROOT, 'state', `auto-reply-${Date.now()}.json`)
fs.writeFileSync(out, JSON.stringify(summary, null, 1), 'utf8')
log('\n=== 本轮结果 ===')
log(JSON.stringify(summary, null, 1))
log('记录：' + out)
logEvent('douyin', 'autoReply.done', { ok: true, ...JSON.parse(JSON.stringify(summary)) })
process.exit(0)
