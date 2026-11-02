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
  const { at, v } = await cached('works:' + limit, async () => {
    const a = await jget(`${CREATOR}/aweme/v1/creator/item/list/?cursor=&aid=2906&count=${limit}`)
    const b = await jget(`${CREATOR}/janus/douyin/creator/pc/work_list?status=0&count=${limit}&max_cursor=0&device_platform=android`)
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
    return { ok: true, items }
  }, { force })
  return { ...v, cachedAt: at }
}

/** 明文 id / 加密 id 都收，统一换成加密 id（评论接口只认加密串） */
async function resolveItem(idOrPlain) {
  const s = String(idOrPlain || '')
  if (s.startsWith('@')) return { id: s, plain: '' }
  const w = await works({ limit: 20 })
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
    }))
    const onAir = series.find(s => String(s.playStatus) === '2') || null
    return { ok: true, onAir, sessions: series }
  }, { force })
  return { ...v, cachedAt: at }
}

export const _internal = { resolveItem }
