/* tools/douyin-replay.mjs —— 两件事，全程只读
 *  A. 复现：不带页面自己那串签名参数，直接调关键接口，看后端能不能主动取数
 *  B. 找入口：把创作者后台的 JS bundle 抓下来，正则搜「评论/修改」的写接口路径
 * 用法：node tools/douyin-replay.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { launchPersistent } from '../core/browser.mjs'
import { ROOT } from '../core/log.mjs'

const { ctx } = await launchPersistent('douyin', { headless: true })
const page = await ctx.newPage()
const R = {}

const clip = (s, n = 300) => String(s || '').replace(/\s+/g, ' ').slice(0, n)

/* ── A. 复现测试 ── */
await page.goto('https://creator.douyin.com/creator-micro/content/manage', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(4000)

R.replay = await page.evaluate(async () => {
  const out = {}
  const j = async (name, url, init) => {
    try {
      const r = await fetch(url, { credentials: 'include', ...(init || {}) })
      const t = await r.text()
      let o = null; try { o = JSON.parse(t) } catch { }
      const top = o ? Object.keys(o).slice(0, 12) : []
      const arrKey = o ? Object.keys(o).find(k => Array.isArray(o[k]) && o[k].length && typeof o[k][0] === 'object') : null
      out[name] = { status: r.status, len: t.length, top, arrKey, firstKeys: arrKey ? Object.keys(o[arrKey][0]).slice(0, 16) : null, sample: t.slice(0, 260) }
    } catch (e) { out[name] = { error: String(e).slice(0, 140) } }
  }
  const now = Date.now()
  const ymd = d => new Date(d).toISOString().slice(0, 10)

  // 1. 作品列表（创作者视角，最小参数）
  await j('workList', 'https://creator.douyin.com/janus/douyin/creator/pc/work_list?status=0&count=20&max_cursor=0&device_platform=android')
  // 2. 数据总览（最近 7 天）
  await j('overview', 'https://creator.douyin.com/aweme/janus/creator/data/overview/all/?last_days_type=1')
  // 3. 直播历史（近 90 天）
  await j('liveHistory', `https://creator.douyin.com/dp/douyin/v1/data/live/data/room/replay/history_list_for_creator?startDate=${ymd(now - 90 * 864e5)}&endDate=${ymd(now)}&limit=100&needLiving=1&download=0`)
  // 4. 评论列表（item_id 从作品列表里拿不到，这里先试空 id 看报错形状）
  await j('commentListNoId', 'https://creator.douyin.com/aweme/v1/creator/comment/list/?cursor=0&count=10&sort=TIME&aid=2906')
  return out
})

/* 拿到作品 id 后再取评论 */
const wl = R.replay.workList
R.workIds = null
if (wl && wl.status === 200) {
  R.workIds = await page.evaluate(async () => {
    const r = await fetch('https://creator.douyin.com/janus/douyin/creator/pc/work_list?status=0&count=20&max_cursor=0&device_platform=android', { credentials: 'include' })
    const o = await r.json()
    const list = o.aweme_list || o.items || []
    return list.slice(0, 6).map(a => ({
      id: a.aweme_id || a.item_id || a.id,
      desc: String(a.desc || a.item_title || '').slice(0, 40),
      create: a.create_time,
      stats: a.statistics ? Object.keys(a.statistics).slice(0, 10) : null,
      cover: a.Cover?.url_list?.[0] ? 'Cover.url_list[0]' : null,
    }))
  })
}

if (R.workIds && R.workIds[0]) {
  const id = encodeURIComponent(R.workIds[0].id)
  R.replayComments = await page.evaluate(async (iid) => {
    const u = `https://creator.douyin.com/aweme/v1/creator/comment/list/?cursor=0&count=10&item_id=${iid}&sort=TIME&aid=2906`
    const r = await fetch(u, { credentials: 'include' })
    const t = await r.text()
    let o = null; try { o = JSON.parse(t) } catch { }
    const list = o?.comment_info_list || []
    return {
      status: r.status, len: t.length, total: o?.total_count, got: list.length,
      first: list[0] ? {
        text: list[0].text, digg: list[0].digg_count, replies: list[0].reply_count,
        time: list[0].create_time, user: list[0].user_info?.screen_name,
        hasCommentId: !!list[0].comment_id,
      } : null,
    }
  }, id)
}

/* ── B. JS bundle 里搜写接口路径 ── */
const bundles = await page.evaluate(() => performance.getEntriesByType('resource')
  .map(e => e.name).filter(n => /\.js(\?|$)/.test(n)).slice(0, 40))

const pat = /\/(?:aweme|janus|web|dp|account)\/[A-Za-z0-9_\/]*(?:comment|item|user|profile|avatar|update|delete|reply|publish)[A-Za-z0-9_\/]*/g
const found = new Set()
for (const b of bundles) {
  try {
    const txt = await page.evaluate(async (u) => {
      try { const r = await fetch(u); return r.ok ? await r.text() : '' } catch { return '' }
    }, b)
    if (!txt) continue
    for (const m of txt.match(pat) || []) found.add(m)
  } catch { /* 单个 bundle 失败不影响 */ }
}
R.routes = [...found].sort()
R.bundleCount = bundles.length

fs.writeFileSync(path.join(ROOT, 'state', 'replay-douyin.json'), JSON.stringify(R, null, 2), 'utf8')

console.log('=== A. 主动调用复现 ===')
for (const [k, v] of Object.entries(R.replay)) {
  console.log(` ${k.padEnd(15)} ${v.status ?? v.error} len=${v.len ?? '-'} ${v.arrKey ? '数组:' + v.arrKey : ''} ${v.top ? v.top.join(',') : ''}`)
}
console.log('\n=== 作品（前几条）===')
console.log(JSON.stringify(R.workIds, null, 1).slice(0, 900))
console.log('\n=== 评论复现 ===')
console.log(JSON.stringify(R.replayComments))
console.log('\n=== B. bundle 里的相关路径（' + R.routes.length + ' 条 / ' + R.bundleCount + ' 个 bundle）===')
for (const r of R.routes.filter(x => /comment|reply|update|delete|avatar|profile|user\/(info|update)|item/.test(x))) console.log('  ' + r)

await page.close()
await ctx.close()
