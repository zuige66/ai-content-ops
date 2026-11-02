/* bili/session.mjs —— B站登录态：判定、体检（跟 douyin/session 同构） */
import fs from 'node:fs'
import path from 'node:path'
import { launchPersistent, hasCookie, profileDir } from '../core/browser.mjs'

export const LOGIN_URL = 'https://passport.bilibili.com/login'
export const COOKIE_NAMES = ['SESSDATA']

export async function launch(opts) { return launchPersistent('bili', opts) }

export async function quickCheck(ctx) {
  const ok = await hasCookie(ctx, 'bilibili.com', COOKIE_NAMES)
  return { ok, why: ok ? '' : 'cookies 里没有 SESSDATA（未登录或已掉线）' }
}

/** 体检：nav 接口在页面上下文里带凭证调，返回 isLogin 和昵称。
 *  没登录返回 soft（不触发熔断）；有 cookie 但接口不认才是掉号。
 *
 *  🔴 自己 newPage 出来的页必须自己关（抖音版有 own+finally，这份丢了）。
 *     /status 每 6 秒轮询一次，不关的话每个平台每分钟攒 10 个 tab，
 *     跑一晚上浏览器就废了。 */
export async function checkAlive(ctx) {
  const quick = await quickCheck(ctx)
  if (!quick.ok) return { ok: false, why: quick.why, soft: true }
  let page
  let own = false
  try {
    page = ctx.pages().find(p => p.url().includes('bilibili.com'))
    if (!page) {
      page = await ctx.newPage()
      own = true
      await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }
    const r = await page.evaluate(async () => {
      try {
        const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
        const j = await res.json()
        if (j && j.code === 0 && j.data && j.data.isLogin) return { ok: true, uid: j.data.mid, name: j.data.uname }
        return { ok: false, why: j && j.message || '接口说未登录' }
      } catch (e) { return { ok: false, why: String(e).slice(0, 120) } }
    })
    return r
  } catch (e) {
    return { ok: false, why: String(e && e.message || e).slice(0, 160) }
  } finally {
    if (own && page) await page.close().catch(() => {})
  }
}

/* 🔴 ctx.cookies() 是 async，必须 await —— 少一个 await 会让登录成功的返回炸掉 */
export async function exportCookies(ctx) {
  const all = await ctx.cookies()
  const dom = all.filter(c => c.domain.includes('bilibili.com'))
  const str = dom.map(c => `${c.name}=${c.value}`).join('; ')
  const p = path.join(profileDir('bili'), 'cookies.txt')
  fs.writeFileSync(p, str, 'utf8')
  return p
}
