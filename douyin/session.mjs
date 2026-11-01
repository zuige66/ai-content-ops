/* douyin/session.mjs —— 抖音登录态：判定、体检、Cookie 导出
 * ═══════════════════════════════════════════════════════════════
 * 判定顺序（从便宜到贵）：
 *   1. HttpOnly cookie 里有没有 sessionid —— 唯一可信的来源
 *      （document.cookie 永远判负，这是踩过的实坑）
 *   2. 页面内 fetch 自己的主页接口 —— 能拿到 uid/昵称，最直观
 *   3. creator 页面有没有被重定向走 —— 投稿真正需要的登录态在这边
 *      deep=true 才会新开页去验（会打断扫码流程，轮询时别用）
 */
import fs from 'node:fs'
import path from 'node:path'
import { launchPersistent, hasCookie, profileDir } from '../core/browser.mjs'

export const LOGIN_URL = 'https://www.douyin.com/'
export const COOKIE_NAMES = ['sessionid', 'sessionid_ss']
const CREATOR_HOME = 'https://creator.douyin.com/creator-micro/home'

export async function launch(opts) { return launchPersistent('douyin', opts) }

/** 快判：HttpOnly cookie 里有没有 sessionid */
export async function quickCheck(ctx) {
  const ok = await hasCookie(ctx, 'douyin.com', COOKIE_NAMES)
  return { ok, why: ok ? '' : 'cookies 里没有 sessionid（未登录或已掉线）' }
}

/** 页面内 fetch 自己的主页接口。外部签名 POST 会 403，页面内带凭证请求不会。 */
async function viaApi(ctx) {
  let page
  try {
    page = ctx.pages().find(p => p.url().includes('douyin.com'))
    const own = !page
    if (!page) {
      page = await ctx.newPage()
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }
    const r = await page.evaluate(async () => {
      try {
        const res = await fetch('https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', { credentials: 'include' })
        const j = await res.json()
        if (j && j.user && j.user.uid) return { ok: true, uid: j.user.uid, name: j.user.nickname || '' }
        return { ok: false, why: '接口没认出登录态' }
      } catch (e) { return { ok: false, why: String(e).slice(0, 120) } }
    })
    if (own) await page.close().catch(() => {})
    return r
  } catch (e) {
    return { ok: false, why: String(e && e.message || e).slice(0, 160) }
  }
}

/** creator 页面有没有被踢回登录页。deep=true 时新开页去验，验完就关。 */
async function viaCreator(ctx, deep) {
  /* 先看已开着的页：登录成功后 creator 会自己跳到 creator-micro，零成本 */
  const opened = ctx.pages().find(p => p.url().includes('creator-micro'))
  if (opened) return { ok: true, uid: '', name: '', page: 'creator-micro' }
  if (!deep) return { ok: false, why: '没有 creator 页可看' }

  let page
  try {
    page = await ctx.newPage()
    await page.goto(CREATOR_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(2500)
    const url = page.url()
    const txt = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '')
    const logged = /creator-micro/.test(url) && !/扫码登录|验证码登录|请登录/.test(txt)
    return logged
      ? { ok: true, uid: '', name: '', page: 'creator-micro' }
      : { ok: false, why: `creator 页仍要求登录（${url.slice(0, 50)}）` }
  } catch (e) {
    return { ok: false, why: String(e && e.message || e).slice(0, 140) }
  } finally {
    if (page) await page.close().catch(() => {})
  }
}

/** 体检（写前用）。soft=true 表示"没登录"（不触发熔断）；
 *  soft=false 表示"cookie 在但谁都不认"= 掉号，要熔断。 */
export async function checkAlive(ctx, { deep = false } = {}) {
  const quick = await quickCheck(ctx)
  if (!quick.ok) return { ok: false, why: quick.why, soft: true }

  const api = await viaApi(ctx)
  if (api.ok) return { ...api, via: 'api' }

  const cr = await viaCreator(ctx, deep)
  if (cr.ok) return { ...cr, via: 'creator' }

  return { ok: false, why: `cookie 在但两处都不认（${api.why} / ${cr.why}）`, soft: false }
}

/** cookie 导出成文本（调试/HTTP 工具备用）。
 *  🔴 ctx.cookies() 是 async，必须 await —— 少一个 await 会让
 *  整条登录成功的返回炸掉（扫码明明成功了却报错）。 */
export async function exportCookies(ctx) {
  const all = await ctx.cookies()
  const dom = all.filter(c => c.domain.includes('douyin.com'))
  const str = dom.map(c => `${c.name}=${c.value}`).join('; ')
  const p = path.join(profileDir('douyin'), 'cookies.txt')
  fs.writeFileSync(p, str, 'utf8')
  return p
}
