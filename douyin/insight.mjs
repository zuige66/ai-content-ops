/* douyin/insight.mjs —— 抖音账号数据（只读）
 * ═══════════════════════════════════════════════════════════════
 * 全部走「页面上下文 fetch credentials:include」。这些接口是创作者后台
 * 页面自己在用的，不逆向签名、不伪造 a_bogus，所以不需要维护签名算法。
 *
 * 🔴 这个文件只读。写操作（回复/编辑）在 douyin/manage.mjs。
 *
 * 接口对照（2026-10-31 实测，详见 .workbuddy-ai/memory/2026-10-31.md）：
 *   账号资料   www.douyin.com/aweme/v1/web/user/profile/self/
 *   作品列表   creator/janus/douyin/creator/pc/work_list（带 statistics）
 *              creator/aweme/v1/creator/item/list/（带加密 item_id，评论要用）
 *   评论       creator/aweme/v1/creator/comment/list/?item_id=<加密>
 *   直播       creator/dp/douyin/v1/data/live/data/room/replay/history_list_for_creator
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ROOT } from '../core/log.mjs'
import { launchPersistent, getLive, pin } from '../core/browser.mjs'

const CREATOR = 'https://creator.douyin.com'
const WEB = 'https://www.douyin.com'

/* 🔴 两个域各留一个常驻页：creator 的接口在 creator 域、账号资料在 www 域，
 *    跨域 fetch 会被 CORS 拦（同源才带得上 cookie）。别想着一个页面通吃。 */
const PAGES = { creator: null, web: null }
const PENDING = { creator: null, web: null }

/* 🔴 三个接口会被控制台同时打（挂载时 profile/works/live 一起发）。并发去
 *  newPage 会开出好几张页，其中一张还在跳转时另一张就 fetch，直接 500。
 *  所以建页要串行：同一个域永远只认一个 in-flight promise。 */
async function pageFor(which) {
  const cur = PAGES[which]
  if (cur && !cur.isClosed()) return cur
  if (PENDING[which]) return PENDING[which]
  const home = which === 'web' ? WEB : `${CREATOR}/creator-micro/home`
  PENDING[which] = (async () => {
    /* 🔴 已经有 context 就直接用，别走 launchPersistent —— 它的模式不匹配逻辑会
     *    把用户正在用的有头窗口关掉（比如刚点了「在后台编辑」弹出那个）。 */
    const live = getLive('douyin')
    const ctx = live || (await launchPersistent('douyin', { headless: true, pinned: true })).ctx
    if (live) pin('douyin')
    const p = await ctx.newPage()
    await p.goto(home, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { })
    /* 首页会重定向到 creator-micro/home，DOM 就绪不代表跳完了。
     * 不等这一步，紧接着的 evaluate 会撞上"上下文已销毁"。 */
    await p.waitForLoadState('load', { timeout: 15000 }).catch(() => { })
    await p.waitForTimeout(1200)
    PAGES[which] = p
    return p
  })().finally(() => { PENDING[which] = null })
  return PENDING[which]
}

/** 在页面里发 GET 并解析。失败返回 {status:0,error}，不往外抛 */
async function jget(url, which = 'creator', { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const p = await pageFor(which)
    try {
      return await p.evaluate(async (u) => {
        try {
          const res = await fetch(u, { credentials: 'include' })
          const t = await res.text()
          let j = null
          try { j = JSON.parse(t) } catch { /* 非 JSON */ }
          return { status: res.status, json: j, raw: t.slice(0, 300) }
        } catch (e) { return { status: 0, error: String(e).slice(0, 160) } }
      }, url)
    } catch (e) {
      /* 🔴 创作者首页会重定向，页面还在跳的时候 evaluate 会抛
       *    "Execution context was destroyed ... because of a navigation"。
       *    这不是登录失效，等它稳一下重试就行 —— 别把它当成掉线去触发熔断。 */
      const msg = String((e && e.message) || e)
      const transient = /Execution context was destroyed|Target closed|detached|navigat/i.test(msg)
      if (!transient || attempt >= retries) return { status: 0, error: msg.slice(0, 160) }
      await new Promise((r) => setTimeout(r, 1500))
      if (p.isClosed()) PAGES[which] = null
    }
  }
}

/* ══════════════════════════════════════════════════════════════
 * 缓存：**落盘**，重启不丢。
 *
 * 规则（按使用习惯定的，别改）：
 *   · 平时一律读本地 state/cache/douyin/，毫秒级返回，不打抖音
 *   · 只有两种情况会真去抓：① 服务启动时的预热  ② POST /douyin/refresh
 *   · 所以这里**故意不设 TTL** —— 一旦按时间过期，就等于每次开页面都在
 *     偷偷打接口，既慢又容易触发风控，还违背"刷新才更新"的预期
 *
 * 数据新鲜度靠返回值里的 cachedAt 透出，前端会显示"抓取于 X 前"。
 * ══════════════════════════════════════════════════════════════ */
const CACHE_DIR = path.join(ROOT, 'state', 'cache', 'douyin')
const cache = new Map()      // 内存镜像，避免每次读盘
const inflight = new Map()   // 并发去重：首屏三个接口同时来，只打一次

/** key → 文件名。可读前缀方便人肉排查，hash 后缀防重名/防超长/防路径穿越 */
function fileOf(key) {
  const safe = String(key).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  const h = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 8)
  return path.join(CACHE_DIR, `${safe}-${h}.json`)
}

function diskRead(key) {
  try {
    const o = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'))
    return o && Number(o.at) ? o : null
  } catch { return null }
}

function diskWrite(key, rec) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(fileOf(key), JSON.stringify(rec))
  } catch { /* 落盘失败只影响下次重启，不该让请求失败 */ }
}

/**
 * 取数据。返回 { at, v } —— at 是这份数据的抓取时间。
 * force=true 时无视本地，真去抓（刷新按钮 / 启动预热用）。
 */
async function cached(key, fn, { force = false } = {}) {
  if (!force) {
    const mem = cache.get(key)
    if (mem) return mem
    const disk = diskRead(key)
    if (disk) {
      cache.set(key, disk)
      return disk
    }
  }
  if (inflight.has(key)) return inflight.get(key)
  const p = (async () => {
    try {
      const v = await fn()
      /* 抓失败不落盘 —— 否则一次掉线就把空结果永久固化了 */
      const rec = { at: Date.now(), v }
      if (v && v.ok !== false) {
        cache.set(key, rec)
        diskWrite(key, rec)
      }
      return rec
    } finally { inflight.delete(key) }
  })()
  inflight.set(key, p)
  return p
}

/** 评论按作品分开存，作品多了会攒一堆文件。刷新时全清，顺手兜一下上限 */
function dropComments() {
  for (const k of [...cache.keys()]) if (k.startsWith('comments:')) cache.delete(k)
  try {
    for (const f of fs.readdirSync(CACHE_DIR)) {
      if (f.startsWith('comments_')) fs.unlinkSync(path.join(CACHE_DIR, f))
    }
  } catch { /* 目录还不存在，无所谓 */ }
}

export function clearCache() { cache.clear(); inflight.clear() }

/** 缓存现状：给前端/接口看"这批数据是什么时候抓的" */
export function cacheInfo() {
  const out = {}
  for (const [k, rec] of cache) out[k] = rec.at
  return out
}

/**
 * 全量刷新：账号资料 → 作品 → 直播，**串行**。
 * 串行不是偷懒：三个一起开会抢同一个 Chrome profile（之前踩过，直接 500）。
 * 评论缓存一并清掉，否则点刷新后评论还是旧的。
 */
export async function refreshAll() {
  const t0 = Date.now()
  const out = {}
  dropComments()
  const steps = [
    ['profile', () => profile({ force: true })],
    ['works', () => works({ limit: 20, force: true })],
    ['live', () => live({ force: true })],
    ['income', () => income({ force: true })],
  ]
  for (const [name, run] of steps) {
    try {
      const r = await run()
      out[name] = r && r.ok === false ? { ok: false, error: r.error } : { ok: true }
    } catch (e) {
      out[name] = { ok: false, error: String(e.message || e).slice(0, 200) }
    }
  }
  return { ok: Object.values(out).some((x) => x.ok), ms: Date.now() - t0, parts: out }
}

/* ── 账号资料：头像 / 简介 / 背景 / 粉丝 ── */
export async function profile({ force = false } = {}) {
  const { at, v } = await cached('profile', async () => {
    const r = await jget(`${WEB}/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383`, 'web')
    if (!r.json || !r.json.user) return { ok: false, error: r.error || '拿不到账号资料（登录态可能失效）' }
    const u = r.json.user
    const pick = (o) => (o && o.url_list && o.url_list[0]) || ''
    return {
      ok: true,
      profile: {
        uid: u.uid,
        secUid: u.sec_uid,
        uniqueId: u.unique_id || u.short_id,
        nickname: u.nickname,
        signature: u.signature,
        avatar: pick(u.avatar_larger) || pick(u.avatar_300x300) || pick(u.avatar_thumb),
        avatarThumb: pick(u.avatar_thumb),
        cover: (u.cover_url && u.cover_url[0] && u.cover_url[0].url_list && u.cover_url[0].url_list[0]) || '',
        followerCount: u.follower_count,
        followingCount: u.following_count,
        awemeCount: u.aweme_count,
        totalFavorited: u.total_favorited,
        favoritingCount: u.favoriting_count,
        city: u.city, province: u.province, country: u.country,
      },
    }
  }, { force })
  return { ...v, cachedAt: at }
}

/** 作品列表：item/list 给加密 id（评论要用）+ work_list 给播放/点赞等统计，按明文 id 合并 */
export async function works({ limit = 20, force = false } = {}) {
  /* 🔴 2026-11-03：**不能拿 limit 直接去请求**。
   *    实测 `item/list?count=2` 返回的前两条里没有 11-02 刚发的那个视频，
   *    而 `count=10` 时它就排在第 0 位 —— 抖音那个接口的条数少时排序不可靠
   *    （缓存 key 也跟着 limit 分裂，works:1 / works:2 / works:20 各存一份，
   *    互相不一致）。后果：只扫"最近两条"时永远看不到最新那条视频，
   *    评论自然没人回。
   *    改成：固定多抓一批 → 自己按 createTime 倒序 → 再截断到 limit。
   *    缓存也统一成一份 `works:all`，别再按 limit 分裂。 */
  /* 🔴 抓取条数必须是**常量**，不能跟着 limit 走 —— 缓存 key 是固定的
   *    `works:all`，如果第一次调用 FETCH=30、第二次 limit=60 又去抓 60，
   *    缓存里存的东西就取决于"谁先调用"，调试时数据忽多忽少极难复现。
   *    固定 60：够覆盖两年内所有作品，也远大于任何调用方会要的数量。 */
  const FETCH = 60
  const { at, v } = await cached('works:all', async () => {
    const a = await jget(`${CREATOR}/aweme/v1/creator/item/list/?cursor=&aid=2906&count=${FETCH}`)
    const b = await jget(`${CREATOR}/janus/douyin/creator/pc/work_list?status=0&count=${FETCH}&max_cursor=0&device_platform=android`)
    const list = (a.json && a.json.item_info_list) || []
    const extra = new Map()
    for (const w of (b.json && b.json.aweme_list) || []) {
      const id = String(w.aweme_id || '')
      // work_list 这边的 create_time / desc 比 item/list 全（item/list 常给 0）
      if (id) extra.set(id, { stats: w.statistics || {}, createTime: Number(w.create_time) || 0, desc: w.desc || '' })
    }
    if (!list.length) {
      return { ok: false, error: a.json ? `接口返回 0 条（status ${a.status}）` : (a.error || '作品列表拿不到') }
    }
    const items = list.map(x => {
      const plain = String(x.item_id_plain || '')
      const m = extra.get(plain) || { stats: {}, createTime: 0, desc: '' }
      const s = m.stats
      return {
        id: x.item_id,                 // 加密 id：评论接口只认这个
        plainId: plain,                // 明文 id：给前端展示 / 打开作品页
        title: String(x.title || '').slice(0, 120),
        desc: String(m.desc || x.title || '').slice(0, 500),
        cover: x.cover_image_url || '',
        createTime: m.createTime || Number(x.create_time) || 0,
        duration: Number(x.duration) || 0,
        mediaType: x.media_type,
        commentCount: Number(x.comment_count) || 0,
        stats: {
          play: Number(s.play_count) || 0,
          digg: Number(s.digg_count) || 0,
          comment: Number(s.comment_count) || 0,
          share: Number(s.share_count) || 0,
          collect: Number(s.collect_count) || 0,
        },
      }
    })
    /* 按发布时间**新→旧**。createTime 拿不到的沉到最后，别让它们冒充最新。 */
    items.sort((x, y) => (y.createTime || 0) - (x.createTime || 0))
    return { ok: true, items }
  }, { force })
  return { ...v, items: (v.items || []).slice(0, Math.min(limit, FETCH)), cachedAt: at }
}

/** 明文 id / 加密 id 都收，统一换成加密 id（评论接口只认加密串） */
async function resolveItem(idOrPlain) {
  const s = String(idOrPlain || '')
  if (s.startsWith('@')) return { id: s, plain: '' }
  const w = await works({ limit: 50 })
  if (!w.ok) return { id: '', plain: s, error: w.error }
  const hit = w.items.find(x => x.plainId === s) || w.items.find(x => String(x.id).includes(s))
  if (!hit) return { id: '', plain: s, error: '作品列表里没有这个 id（可能超出最近 20 条）' }
  return { id: hit.id, plain: hit.plainId, item: hit }
}

/* ── 评论列表 ── */
/** www 域的评论接口。**数字 comment_id 只有这里有**（creator 那边给的是加密串），
 *  而真正发回复的 multi_publish 只认数字 id —— 所以这张表是发回复的前置。
 *
 *  🔴 必须在**作品页**里发请求，不能在 www 首页：首页虽然同源、也返回 200，
 *     但页面里没有 a_bogus 签名 SDK，拿到的是 HTML 风控页而不是 JSON。
 *     （2026-11-02 实测：同一段 fetch 在 /video/<id> 里 200+JSON，在首页 200+HTML） */
export async function commentsWeb(awemeId, { count = 50 } = {}) {
  const p = await pageFor('web')
  const url = `${WEB}/aweme/v1/web/comment/list/?device_platform=webapp&aid=6383&aweme_id=${awemeId}&cursor=0&count=${count}&item_type=0`

  const run = () => p.evaluate(async (u) => {
    try {
      const res = await fetch(u, { credentials: 'include' })
      const t = await res.text()
      let j = null
      try { j = JSON.parse(t) } catch { }
      return { status: res.status, json: j, raw: t.slice(0, 160) }
    } catch (e) { return { status: 0, error: String(e).slice(0, 160) } }
  }, url)

  let r = await run()
  if (!r.json) {
    /* 首次多半是在首页 —— 切到作品页拿签名上下文再试一次 */
    await p.goto(`${WEB}/video/${awemeId}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { })
    await p.waitForLoadState('load', { timeout: 15000 }).catch(() => { })
    await p.waitForTimeout(2500)
    r = await run()
  }
  if (!r.json) return { ok: false, error: `web 评论接口 ${r.status}${r.error ? '：' + r.error : '，返回非 JSON：' + (r.raw || '').slice(0, 80)}` }

  const rows = (r.json.comments || r.json.comment_info_list || []).map(c => ({
    numId: String(c.cid || c.comment_id || ''),      // 数字 id：回复要用这个
    text: String(c.text || ''),
    user: (c.user && c.user.nickname) || '',
    createTime: Number(c.create_time) || 0,
    replyTotal: Number(c.reply_comment_total ?? c.reply_count ?? 0) || 0,
  })).filter(x => /^\d+$/.test(x.numId))
  return { ok: true, comments: rows, total: Number(r.json.total) || rows.length }
}

export async function comments(idOrPlain, { count = 20, cursor = 0, sort = 'TIME', force = false } = {}) {
  const it = await resolveItem(idOrPlain)
  if (!it.id) return { ok: false, error: it.error }
  const { at, v } = await cached(`comments:${it.id}:${cursor}`, async () => {
    const u = `${CREATOR}/aweme/v1/creator/comment/list/?cursor=${cursor}&count=${count}&item_id=${encodeURIComponent(it.id)}&sort=${sort}&aid=2906`
    const r = await jget(u)
    if (!r.json) return { ok: false, error: r.error || `评论接口返回 ${r.status}` }
    /* 加密 → 数字：靠 (昵称 + 正文) 配对。图片评论正文为空，只能靠昵称+时间兜，
     * 配不上就没 numId —— 调用方必须判断，别拿加密串去发回复（会「参数不合法」）。 */
    const web = await commentsWeb(it.plain || idOrPlain, { count: 50 }).catch((e) => ({ ok: false, error: String(e && e.message || e).slice(0, 160) }))
    const key = (u, t) => `${String(u).trim()}|${String(t).trim()}`
    const numMap = new Map()
    const userCount = new Map()      // 昵称 → 出现次数（兜底用，只有唯一时才敢配）
    if (web && web.ok) {
      for (const w of web.comments) {
        numMap.set(key(w.user, w.text), w.numId)
        const u = String(w.user).trim()
        userCount.set(u, (userCount.get(u) || 0) + 1)
      }
    }

    const rows = (r.json.comment_info_list || []).map(c => {
      const user = (c.user_info && c.user_info.screen_name) || ''
      const text = String(c.text || '')
      /* 图片评论在 creator 侧 text 为空、web 侧是「[图片表情]」，按正文永远配不上；
       * 所以退回按昵称配 —— 前提是这个昵称在这批评论里唯一，否则宁可不配。 */
      let numId = numMap.get(key(user, text)) || ''
      if (!numId && userCount.get(String(user).trim()) === 1) {
        const w = web.comments.find(x => String(x.user).trim() === String(user).trim())
        numId = (w && w.numId) || ''
      }
      return {
        id: c.comment_id,
        numId,   // 发回复用这个；空=没配上
        text,
        digg: Number(c.digg_count) || 0,
        replyCount: Number(c.reply_count) || 0,
        createTime: Number(c.create_time) || 0,
        isAuthor: Boolean(c.is_author),
        isImage: Boolean(c.image_list && c.image_list.length),
        image: (c.image_list && c.image_list[0] && c.image_list[0].url_list && c.image_list[0].url_list[0]) || '',
        user,
        avatar: (c.user_info && c.user_info.avatar_url) || '',
        userId: (c.user_info && c.user_info.user_id) || '',
      }
    })
    return {
      ok: true,
      item: it.item ? { id: it.id, plainId: it.plain, title: it.item.title, cover: it.item.cover } : { id: it.id, plainId: it.plain },
      comments: rows,
      /* 数字 id 是发回复的前提，这里把 web 那一步的成败透出来，排错不用猜 */
      webOk: Boolean(web && web.ok),
      webError: (web && web.error) || '',
      webTotal: (web && web.total) || 0,
      total: Number(r.json.total_count) || rows.length,
      hasMore: Boolean(r.json.has_more),
      cursor: r.json.cursor,
    }
  }, { force })
  return { ...v, cachedAt: at }
}

/* ── 某条评论下的回复 ── */
export async function replies(commentId, { count = 20, cursor = 0 } = {}) {
  const u = `${CREATOR}/aweme/v1/creator/comment/reply/list?cursor=${cursor}&count=${count}&comment_id=${encodeURIComponent(commentId)}&sort=TIME`
  const r = await jget(u)
  if (!r.json) return { ok: false, error: r.error || `回复接口返回 ${r.status}` }
  const rows = (r.json.comment_info_list || r.json.reply_list || []).map(c => ({
    id: c.comment_id, text: c.text, createTime: Number(c.create_time) || 0,
    user: (c.user_info && c.user_info.screen_name) || '', isAuthor: Boolean(c.is_author),
  }))
  return { ok: true, replies: rows, hasMore: Boolean(r.json.has_more) }
}

/* ── 直播：是否在播 + 历史场次 ── */
export async function live({ days = 90, limit = 50, force = false } = {}) {
  const { at, v } = await cached('live:' + days + ':' + limit, async () => {
    const ymd = d => new Date(d).toISOString().slice(0, 10)
    const now = Date.now()
    const r = await jget(`${CREATOR}/dp/douyin/v1/data/live/data/room/replay/history_list_for_creator?startDate=${ymd(now - days * 864e5)}&endDate=${ymd(now)}&limit=${limit}&needLiving=1&download=0`)
    if (!r.json || !r.json.data) return { ok: false, error: r.error || `直播接口返回 ${r.status}` }
    const series = (r.json.data.series || []).map(s => ({
      roomId: s.roomID,
      title: s.roomTitle,
      startTime: s.startTime,
      endTime: s.endTime,
      playStatus: s.playStatus,        // 2 = 还在播
      watch: Number(s.watchCnt) || 0,
      pcu: Number(s.pcu) || 0,
      like: Number(s.serverLikeCntTd) || 0,
      comment: Number(s.clientCommentUcntTd) || 0,
      newFollow: Number(s.liveNewFollowUcnt) || 0,
      durationText: s.liveDurationWithoutPause || '',
      cover: s.coverUri || '',
      /* 🔴 本场音浪。2026-11-02 补：接口一直有这个字段（roomLiveEarnScore），
       *    以前只取观看/点赞，把收入漏了。单位是**音浪**，不是元。
       *    换人民币口径见 zhibo/cache/gift-price.json 的注释：20 音浪 = 1 元（主播到手）。 */
      earnScore: Number(s.roomLiveEarnScore) || 0,
    }))
    const onAir = series.find(s => String(s.playStatus) === '2') || null
    /* 26 场的音浪总和 —— 视频里讲「赚了多少」直接取这个，别再手算 */
    const totalEarn = series.reduce((a, s) => a + s.earnScore, 0)
    return { ok: true, onAir, sessions: series, totalEarn }
  }, { force })
  return { ...v, cachedAt: at }
}

/* ── 收入总览：创作者后台「收入变现」页的账 ──
 *
 * 两个接口一起取，缺一个也能出数：
 *   income/category/summary  → 分品类（直播 webcast）的今日/昨日/7日/30日收益
 *   mission/user_summary     → 历史累计收益 history_total_income + 余额 total_balance
 *
 * 🔴 单位全是**音浪/抖币**，不是人民币。换算口径 20 音浪 = 1 元（主播到手价，
 *    平台已抽成），校准依据见 zhibo/docs/2026-10-30-白饭.md。
 * 🔴 抖音侧收益「每天 12 点前更新昨日数据」，所以今天播的今晚看不到，
 *    要报「现在赚了多少」只能用直播间实时的 roomLiveEarnScore（见 live()）。
 */
export async function income({ force = false } = {}) {
  const { at, v } = await cached('income', async () => {
    const base = `aid=2906&app_name=aweme_creator_platform&device_platform=web`
    const [sum, mis] = await Promise.all([
      jget(`${CREATOR}/aweme/v1/creator/income/category/summary/?${base}`),
      jget(`${CREATOR}/aweme/v1/creator/mission/user_summary/?${base}`),
    ])
    const a = sum.json, b = mis.json
    if (!a && !b) {
      return { ok: false, error: sum.error || mis.error || '收入接口都拿不到（登录态可能失效）' }
    }

    /** 从 dayN_income_summary 里挑「直播」这一项 */
    const pickLive = (block) => {
      const list = (block && block.category_list) || []
      const web = list.find(x => x && x.category_id === 'webcast') || list[0] || {}
      return {
        today: Number(web.today_total_income) || 0,
        yesterday: Number(web.yesterday_total_income) || 0,
        history: Number(block && block.history_total_income) || 0,
        updateDesc: web.data_update_desc || '',
      }
    }

    const d1 = pickLive(a && a.day1_income_summary)
    const d7 = pickLive(a && a.day7_income_summary)
    const d30 = pickLive(a && a.day30_income_summary)

    return {
      ok: true,
      /* 音浪 */
      earnScore: {
        today: Number(a && a.today_total_income) || d1.today || 0,
        yesterday: d1.yesterday,
        day7: d7.history,
        day30: d30.history,
        /* 历史累计：两个接口都有，优先 category/summary 的，缺了退 mission 的 */
        total: (b && b.income_summary && Number(b.income_summary.history_total_income))
          || d30.history || d1.history || 0,
        updateDesc: d1.updateDesc || '每天12点前更新昨日收益',
      },
      /* 抖币 */
      balance: Number((b && b.total_balance) ?? (a && a.total_balance)) || 0,
      /* 人民币参考值（20 音浪 = 1 元，主播到手价） */
      yuan: r2(((b && b.income_summary && Number(b.income_summary.history_total_income))
        || d30.history || d1.history || 0) / 20),
    }
  }, { force })
  return { ...v, cachedAt: at }
}

/** 保留两位小数，避免 147.75000000000003 这种浮点尾巴进画面 */
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100 }

export const _internal = { resolveItem }
