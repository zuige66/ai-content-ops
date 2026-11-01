/* bili/login.mjs —— B站扫码登录（passport.bilibili.com 的二维码页）
 * 跟 douyin/login.mjs 同构；B站的二维码就是一个 <img class="qrcode">，好截。 */
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'
import { launchPersistent, getLive } from '../core/browser.mjs'
import * as session from './session.mjs'

const QR_SHOT = path.join(ROOT, 'state', 'qr-bili.png')

export async function startLogin() {
  const { ctx } = await launchPersistent('bili', { headless: false })
  const quick = await session.quickCheck(ctx)
  if (quick.ok) {
    logEvent('bili', 'login.already', { ok: true })
    return { already: true, why: '已经登录过了，不用再扫' }
  }
  const page = ctx.pages()[0] || await ctx.newPage()
  await page.goto(session.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
  // 等二维码 img 出现（ passport 页默认就是扫码登录）
  try {
    await page.waitForSelector('img.qrcode, .login-qr img, canvas.qrcode', { timeout: 20000 })
  } catch { /* 截整页兜底，照样能扫 */ }
  await page.screenshot({ path: QR_SHOT, fullPage: false })
  logEvent('bili', 'login.start', { ok: true })
  return { already: false, shot: QR_SHOT }
}

export async function pollLogin() {
  // 🔴 只看已经开着的登录浏览器（getLive），绝不顺手新开 —— 没开始登录就别弹窗
  const ctx = getLive('bili')
  if (!ctx) return { loggedIn: false, why: '还没开始登录（先点「开始登录」）' }
  const quick = await session.quickCheck(ctx)
  if (quick.ok) {
    const alive = await session.checkAlive(ctx)
    if (alive.ok) {
      const cookieFile = await session.exportCookies(ctx)
      logEvent('bili', 'login.success', { ok: true, uid: alive.uid, name: alive.name })
      return { loggedIn: true, who: alive, cookieFile }
    }
    return { loggedIn: false, why: `cookie 有了但接口不认：${alive.why}` }
  }
  let why = '还没扫上（等手机确认）'
  try {
    const page = ctx.pages()[0]
    if (page) {
      const t = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '')
      if (/过期|刷新/.test(t) && /二维码|扫码/.test(t)) why = '二维码过期了，重新点「开始登录」'
    }
  } catch { /* ignore */ }
  return { loggedIn: false, why }
}
