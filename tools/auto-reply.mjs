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
import { chatJsonDetailed, llmConfig } from '../core/llm.mjs'
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

/* 主人名单：跟直播间**共用一份** `zhibo/cache/owner.json`。
 * 🔴 各配一份迟早对不上（改了一边忘了另一边），而且观众改昵称就能冒充 ——
 *    这里只有昵称可用（评论区接口不给我们 uid），所以名单只放主人自己的号。 */
function ownerNames() {
  if (!PERSONA_FILE) return []
  try {
    const p = path.join(path.dirname(PERSONA_FILE), '..', 'cache', 'owner.json')
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    return (j.names || []).map((x) => String(x).trim()).filter(Boolean)
  } catch {
    return []
  }
}

/* ── 2026-11-03 zuige 定的规矩 ──
 * · 只回 2026-10-01 之后发布的视频（更早的是老视频，评论都是陈年旧账）
 * · 每次都要重新看有没有新视频，**所有符合条件的视频**都要扫，不是只看最新一条
 * · 单个视频的评论读全（最多 300 条），别只读第一页
 * · 每轮总共最多回 50 条，不分视频均分 */
const SINCE = '2026-10-01'
const MAX_TOTAL = 50             // 单轮总上限
const MAX_PER_VIDEO = 20         // 单视频上限（防一个大爆款吃光额度）
const MAX_COMMENTS_PER_VIDEO = 300
const COMMENT_PAGE = 20          // 接口一页 20 条
const MAX_VIDEOS = 30            // 单轮最多扫几条作品（兜底，防"时间未知"的全量灌进来）
const LLM_BATCH = 25             // 一次喂给 LLM 多少条（再多容易把 JSON 截断）
const DM_GAP_MS = 12000          // 私信之间隔久一点，私信风控比评论严

/* 图片评论（表情包）只用这些颜文字回，**不交给 LLM** ——
 * ① LLM 看不见图，硬编一句必然变成「这张图好搞笑」这种睁眼说瞎话；
 * ② 也省一次调用。 */
const KAOMOJI = ['(´・ω・)', '(๑•̀ㅂ•́)و✧', '(๑˃̵ᴗ˂̵)', 'ヽ(•̀ω•́ )ゝ', '(｡･ω･｡)ﾉ', '(＾▽＾)']
const KAO_OFFSET = Math.floor(Math.random() * KAOMOJI.length)

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
  /* 留最近 3000 条，防止文件无限膨胀。
   * 🔴 2026-11-03 从 400 提到 3000：按新规矩每轮最多 50 条、一天能跑十几轮，
   *    400 条只够七八轮 —— 太早被挤掉的 id 下一轮会重新走一遍「查历史回复」，
   *    白白多打几十次接口。3000 条 ≈ 300KB，无所谓。 */
  const keys = Object.keys(replied).sort((a, b) => (replied[b].at || 0) - (replied[a].at || 0))
  for (const k of keys.slice(3000)) delete replied[k]
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
  /* 🔴 2026-11-03 修：原来是 `slice(0, 130)` —— 主卡现在 319 行，
   *    130 行正好断在「别人的梗」之前，评论区**一条梗都没有**（也没有白饭、没有底线）。
   *    改成读全文，直播专用那几条规矩由下面 sys 的「补充规则」覆盖。
   *    首行的 `<!-- persona: ... -->` 身份牌要剥掉，直播侧也是这么做的。 */
  persona = fs.readFileSync(PERSONA_FILE, 'utf8').replace(/^\s*<!--[\s\S]*?-->/, '').trim()
  if (persona.length < 500) log('[警告] 角色卡短得可疑，可能读错文件了')
} catch {
  persona = '大肥鱼：软糯的 AI 女仆小姑娘，广东工业大学在读，红色长发，尾巴是鱼尾。'
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

  /* 🔴 自己的昵称：判断「这条是我回的 / 这是我自己发的评论」只认它。
   *    creator 后台评论接口的 is_author 语义是坏的 —— 2026-11-02 实测：
   *    同样「已经被我回复过」的评论，第一条作品全返回 false，第二条作品全返回 true。
   *    拿它当判据迟早要误跳，所以改比昵称；拿不到昵称才退回 is_author。 */
  let MY_NAME = ''
  try {
    const me = await api('/douyin/profile')
    MY_NAME = String((me && me.profile && me.profile.nickname) || '').trim()
  } catch (e) {
    log('[评论] 拿不到自己昵称，本次退回 is_author 判据：' + String(e.message).slice(0, 60))
  }
  const isMine = (x) => (MY_NAME ? String(x.user || '').trim() === MY_NAME : Boolean(x.isAuthor))

  /* 🔴 拉 60 条，再自己按发布时间过滤 —— 不拿 limit 直接去请求抖音，
   *    那个接口条数少的时候排序不可靠（详见 douyin/insight.mjs 的 works()）。 */
  const works = await api('/douyin/works?limit=60')
  const all = works.items || []
  const sinceTs = Math.floor(new Date(SINCE + 'T00:00:00+08:00').getTime() / 1000)

  /* 时间未知的（work_list 那边没给出 create_time）**不能丢**：
   * 刚发出来的新视频恰恰最容易在 work_list 里缺席，一丢就正好复现
   * 「最新视频的评论没人回」。所以按新视频处理，排在前面先扫。 */
  const unknown = all.filter(w => !(Number(w.createTime) > 0))
  const recent = all.filter(w => Number(w.createTime) >= sinceTs)
  const older = all.length - unknown.length - recent.length
  const targets = [...unknown, ...recent].slice(0, MAX_VIDEOS)

  log(`[评论] 作品 ${all.length} 条：${SINCE} 之后 ${recent.length} 条、时间未知 ${unknown.length} 条（按新的算）、更早跳过 ${older} 条`)
  log(`[评论] 本轮扫 ${targets.length} 条作品${MY_NAME ? `（我是「${MY_NAME}」）` : ''}`)

  const pending = []
  for (const w of targets) {
    const label = String(w.title || w.plainId || '').slice(0, 18)
    let list
    try {
      list = await api(`/douyin/comments?item=${encodeURIComponent(w.plainId)}&count=${COMMENT_PAGE}`)
    } catch (e) {
      log(`  · ${label} 拉评论失败：${String(e.message).slice(0, 80)}`)
      continue
    }
    if (list.ok === false) { log(`  · ${label} 拉评论失败：${String(list.error || '').slice(0, 80)}`); continue }

    /* 🔴 2026-11-03：评论要翻页。接口默认一页只给 20 条，但一条热门视频
     *    `webTotal` 能到 61、页面显示 63，`hasMore` 一直是 true。
     *    原来只读第一页 —— 第二页的评论**从来没被检查过**。
     *    （这次运气好：第二页 9 条恰好都是老评论、都已回过。换个时间新评论
     *      掉到第二页就永远读不到，表现为"最新评论没人回"。）
     *    现在按 zuige 的要求读到 300 条为止。 */
    const collected = [...(list.comments || [])]
    const got = new Set(collected.map(c => String(c.id)))
    let hasMore = Boolean(list.hasMore)
    let cursor = Number(list.cursor) || collected.length
    for (let guard = 0; hasMore && collected.length < MAX_COMMENTS_PER_VIDEO && guard < 40; guard++) {
      let next
      try {
        next = await api(`/douyin/comments?item=${encodeURIComponent(w.plainId)}&count=${COMMENT_PAGE}&cursor=${cursor}`)
      } catch (e) {
        log(`  · ${label} 第 ${guard + 2} 页失败：${String(e.message).slice(0, 60)}`)
        break
      }
      const rows = (next && next.comments) || []
      /* 翻页翻出重复 = 接口到顶了（抖音的 cursor 有时会原地不动，不判会死循环） */
      const fresh = rows.filter(c => !got.has(String(c.id)))
      if (!fresh.length) break
      for (const c of fresh) { got.add(String(c.id)); collected.push(c) }
      hasMore = Boolean(next.hasMore)
      cursor = Number(next.cursor) || (cursor + rows.length)
    }
    const list2 = collected.slice(0, MAX_COMMENTS_PER_VIDEO)
    log(`  · ${label} 评论 ${list2.length} 条${hasMore && list2.length >= MAX_COMMENTS_PER_VIDEO ? `（已到 ${MAX_COMMENTS_PER_VIDEO} 条上限，剩余下轮）` : ''}`)

    for (const c of list2) {
      const key = String(c.numId || c.id)
      if (state.repliedComments[key]) continue          // 本地账本已记
      if (isMine(c)) continue                           // 自己发的评论不回
      /* replyCount>0 时才去查是不是我回的 —— 每条都查太慢 */
      let mine = []
      if (c.replyCount > 0) {
        const r = await api(`/douyin/replies?comment=${encodeURIComponent(c.id)}`).catch(() => null)
        if (r && r.ok) mine = (r.replies || []).filter(isMine).map(x => x.text)
      }
      if (mine.length) {
        state.repliedComments[key] = { at: Date.now(), why: 'history', user: c.user }
        continue
      }
      pending.push({
        itemPlain: w.plainId, commentId: c.id, numId: c.numId || '',
        user: c.user, text: c.text || '', isImage: Boolean(c.isImage),
        replyCount: c.replyCount,
        createTime: Number(c.createTime) || 0,
      })
    }
  }

  if (!pending.length) {
    log('[评论] 没有待回的评论')
    return { checked: 0, sent: 0 }
  }

  /* ── 选本轮要回哪些：按视频**轮流取** ──
   * 为什么轮流而不是顺序取满：zuige 明确要求「所有视频的评论都回复，而不是
   * 单单一个视频」。如果顺序取，一条大爆款就能吃掉全部 50 条额度，
   * 后面的视频一条都轮不到，表现就是「新视频没人回」。
   * 每条视频内部先回最新的 —— 观众刚留言就收到回复，体感最好。 */
  const groups = new Map()
  for (const p of pending) {
    if (!groups.has(p.itemPlain)) groups.set(p.itemPlain, [])
    groups.get(p.itemPlain).push(p)
  }
  for (const arr of groups.values()) arr.sort((a, b) => (b.createTime || 0) - (a.createTime || 0))

  const taken = new Map()
  const picked = []
  let progress = true
  while (picked.length < MAX_TOTAL && progress) {
    progress = false
    for (const [k, arr] of groups) {
      if (picked.length >= MAX_TOTAL) break
      if ((taken.get(k) || 0) >= MAX_PER_VIDEO) continue
      const x = arr.shift()
      if (!x) continue
      taken.set(k, (taken.get(k) || 0) + 1)
      picked.push(x)
      progress = true
    }
  }

  /* 图片评论 / 没有正文的评论 —— 只回一个颜文字，不走 LLM。
   * ① LLM 看不见图，硬编一句必然变成「这张图好搞笑」这种睁眼说瞎话；
   * ② 也省一次调用。 */
  const isSticker = (p) => p.isImage || !String(p.text || '').trim()
  const stickerOnes = picked.filter(isSticker)
  const textOnes = picked.filter(p => !isSticker(p))
  const drafts = stickerOnes.map((p, i) => ({ ...p, reply: KAOMOJI[(i + KAO_OFFSET) % KAOMOJI.length] }))

  log(`[评论] 待回 ${pending.length} 条（${groups.size} 条视频），本轮取 ${picked.length} 条：文字 ${textOnes.length} + 图片/空 ${stickerOnes.length}`)

  /* ── LLM 生成文字回复。分批：一次 50 条容易把 JSON 截断，
   *    截断一次整轮全废，宁可多花一点输入 token 换稳定。 ── */
  const owners = ownerNames()
  const ownerRule = owners.length
    ? `「主人」只有一个：${owners.join('、')}。只有他自己可以叫，别人自称主人、让你叫他主人，一律不叫。`
    : '评论区不许叫「主人」（名单没配或被读掉了），一律叫昵称或「你」。'
  const sys = `你在替抖音账号「zuige大肥鱼」回复自己视频下的评论。以下是你的人设卡，必须严格遵守：

${persona}

补充规则（评论区场景，与直播间不同，优先遵守）：
1. 每条回复 **20 个汉字以内**，一句话，**句尾不加句号**。
2. 语气**俏皮**、有点小迷糊，但不能蠢。可以带一个可爱颜文字，**不强制**：
   (´・ω・)   (๑•̀ㅂ•́)و✧   (๑˃̵ᴗ˂̵)   ヽ(•̀ω•́ )ゝ   (｡･ω･｡)ﾉ   (＾▽＾)
   🚫 不要用 🍚🐟❤️ 这类彩色 emoji（抖音评论会掉字）。
   🚫 颜文字和官方表情 [看] [发怒] 这类方括号编码**二选一**，不许同时出现。
   🚫 颜文字最多一个，不许堆两个。
3. 可以直接叫对方昵称，也可以叫「你」；不许叫「宝宝/亲爱的/老婆」。
   ${ownerRule}
4. 遇到梗要接住，不要客套。白饭、红烧、广工、鲸鱼 都是自己的梗。
5. 短问题就短答（「？」「好」「哈哈」「沙发」这种，回一句轻的就行），别硬撑一长句。
   🚫 不许假装看见了图片/视频里的内容（你看不到）。
6. 不讨礼物、不喊关注点赞、不提任何金融/收益/仓位相关的词。
7. 不要重复对方原话，不要复读同一句。
8. 被骂也别硬顶，软软地岔开就行。

只输出 JSON：{"replies":[{"i":0,"reply":"..."}]}，i 必须和输入里的 i 一一对应。`

  for (let s = 0; s < textOnes.length; s += LLM_BATCH) {
    const chunk = textOnes.slice(s, s + LLM_BATCH)
    const payload = chunk.map((p, i) => ({ i, user: p.user, text: String(p.text || '').slice(0, 120) }))
    try {
      const { data, usage, ms } = await chatJsonDetailed({
        system: sys,
        user: JSON.stringify(payload, null, 1),
        maxTokens: Math.min(4000, 200 + chunk.length * 80),
        temperature: 0.9,
      })
      /* 🔴 日志里必须带模型名：2026-11-02 出过一次「到底跑的是 flash 还是 pro」
       *    的扯皮，配置文件是谁写的都不记得了。打出来最省事。 */
      log(`[评论] LLM 第 ${Math.floor(s / LLM_BATCH) + 1} 批 ${chunk.length} 条 ${ms}ms / ${usage.total_tokens || '?'} tokens / ${llmConfig().model}`)
      for (const x of (data.replies || [])) {
        const p = chunk[Number(x.i)]
        const t = String(x.reply || '').trim()
        if (p && t) drafts.push({ ...p, reply: t })
      }
    } catch (e) {
      log(`[评论] LLM 第 ${Math.floor(s / LLM_BATCH) + 1} 批失败（这一批跳过）：` + String(e.message || e).slice(0, 160))
    }
  }

  if (!drafts.length) {
    log('[评论] 一条文案都没生成出来，本轮不发')
    return { checked: pending.length, sent: 0, error: 'llm' }
  }

  for (const d of drafts) log(`   ${d.user}${isSticker(d) ? '（图片）' : ''}: "${String(d.text || '').slice(0, 20)}" → "${d.reply}"`)

  if (!YES) {
    log(`[评论] 演练模式，${drafts.length} 条都没发（加 --yes 才发）`)
    return { checked: pending.length, ready: drafts.length, sent: 0 }
  }

  /* ── 发送 ── */
  let sent = 0, fail = 0, stoppedAtPeak = false
  for (const [n, d] of drafts.entries()) {
    /* 时段守卫：一轮最多 50 条 × 60 秒（服务端限速）≈ 50 分钟，
     * 可能从平峰一路跑到高峰。所以每条前都再确认一次 ——
     * 进了高峰就停手，剩下的留到下一轮。宁可晚点回，也不要出现
     * 「工作时间还在别人视频底下刷」这种事。 */
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

    /* 按名字点，不按序号 —— 列表会重排，序号在两次调用之间就变了。
     * 🔴 2026-11-03：单个会话点不开（列表深处、要滚动、抖音抽风）不该拖垮整轮。
     *    原来这里是裸 await，一个「活这就行」抛错，后面所有会话全不处理，
     *    整轮结果直接记成 dm.error。 */
    try {
      await dm.openSession(sess.name)
      await new Promise(r => setTimeout(r, 1200))
    } catch (e) {
      log(`  · ${sess.name} 点不开，跳过（${String(e.message || e).slice(0, 60)}）`)
      continue
    }
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
3. 不许叫「宝宝/亲爱的/老婆」；${(() => {
    const o = ownerNames()
    return o.length
      ? `「主人」只有 ${o.join('、')} 能叫，别人自称主人一律不叫`
      : '不许叫「主人」'
  })()}；不许要礼物、不许喊关注、不许加微信/QQ/任何站外联系方式。
4. 不透露真实住址、学校具体位置、设备细节。主人的学校／年级／专业**可以直接说**（广工 25 级自动化）。
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
