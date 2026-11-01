/* douyin/login.mjs —— 抖音扫码登录（走创作者平台）
 * ═══════════════════════════════════════════════════════════════
 * 为什么不再走 login.douyin.com：
 *   那是头条联合登录页，默认停在「手机登录」。它的 tab 是
 *   <li role="tab">，用 el.click() 和真鼠标坐标点都切不过去
 *   （无 pageerror、无请求失败、active class 不变）—— 页面自己拦了。
 *   继续在那儿点等于跟一堵墙较劲。
 *
 * 换成 creator.douyin.com：
 *   · 默认就是「扫码登录」，二维码直接渲染，不用点任何东西
 *   · 投稿本来就要这个域的登录态，一举两得
 *
 * 二维码怎么取（关键）：
 *   #douyin_login_comp_scan_code_qrcode 里的 <img> 是
 *   data:image/png;base64,... 的 512×512 原图。
 *   直接解 base64 落盘 —— 不做截图缩放，扫得最清楚，也不会把
 *   桌面其它窗口截进去。
 *
 * 判成功：必须走 HttpOnly cookie（sessionid / sessionid_ss），
 *   document.cookie 永远判负。cookie 有了还要过接口体检，防止
 *   「cookie 在但已被踢」的假登录。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'
import { launchPersistent, getLive } from '../core/browser.mjs'
import * as session from './session.mjs'

export const LOGIN_URL = 'https://creator.douyin.com/'

const QR_SHOT = path.join(ROOT, 'state', 'qr-douyin.png')
const QR_PAGE = path.join(ROOT, 'state', 'qr-douyin-page.png')
const QR_SEL = '#douyin_login_comp_scan_code_qrcode img'

/* 二维码 img 的 src 缓存：src 没变就不重写文件，免得控制台每 2.5 秒闪一下 */
let lastSrc = ''

/** 从当前页面抓二维码。返回 {ok, src} —— ok=false 表示页面上没有可用二维码 */
async function grabQr(page) {
  return page.evaluate((sel) => {
    const img = document.querySelector(sel)
    if (!img) return { ok: false, why: '没找到二维码节点' }
    const src = img.src || ''
    if (!src) return { ok: false, why: '二维码 img 没有 src' }
    if (img.naturalWidth && img.naturalWidth < 100) return { ok: false, why: '二维码图太小（可能是占位图）' }
    return { ok: true, src, nat: img.naturalWidth }
  }, QR_SEL).catch(e => ({ ok: false, why: String(e).slice(0, 100) }))
}

/** 把 data URL 写成 png。非 data URL 返回 false，交给截图兜底 */
function writeDataUrl(src, file) {
  const m = /^data:image\/png;base64,(.+)$/s.exec(src)
  if (!m) return false
  try {
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'))
    return true
  } catch { return false }
}

/** 页面卡住时的诊断：把「为什么没二维码」说人话。
 *  🔴 顺序有讲究：先认「扫码登录」= 正常等待。页面上本来就有
 *  「验证码登录」这个 tab，拿「验证码」三个字去判会误报成验证墙。 */
async function diagnose(page) {
  const t = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '').catch(() => '')
  if (/二维码.*(失效|过期)|点击刷新|刷新二维码/.test(t)) {
    return { kind: 'expired', why: '二维码过期了 —— 会自动换一张，稍等' }
  }
  if (/扫码登录/.test(t)) return { kind: 'waiting', why: '还没扫上（等手机确认）' }
  if (/请完成安全验证|拖动滑块|滑块验证|短信验证码已发送|身份验证|新设备验证|为保障账号安全/.test(t)) {
    return { kind: 'wall', why: '卡在验证墙（滑块/短信/新设备）—— 去弹出的浏览器窗口里手动过一下' }
  }
  return { kind: 'other', why: '不在登录页（可能被跳转了）—— 看浏览器窗口当前停在哪个页面' }
}

/** 起有头 Chrome 到创作者平台登录页。已登录就直接说明，不再开。 */
export async function startLogin() {
  const { ctx } = await launchPersistent('douyin', { headless: false })
  const quick = await session.quickCheck(ctx)
  if (quick.ok) {
    logEvent('douyin', 'login.already', { ok: true })
    return { already: true, why: '已经登录过了，不用再扫' }
  }

  const page = ctx.pages().find(p => p.url().includes('creator.douyin.com')) || ctx.pages()[0] || await ctx.newPage()
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})

  /* 等二维码真的渲染出来（SPA + 异步拿码，最多 20 秒） */
  let got = null
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1000)
    const g = await grabQr(page)
    if (g.ok) { got = g; break }
    /* 顺手点掉「二维码已失效」上的刷新，自己续上 */
    if (i > 3) {
      await page.evaluate(() => {
        const el = [...document.querySelectorAll('div,span,button,a')]
          .find(e => e.childElementCount === 0 && /^(点击刷新|刷新二维码|刷新)$/.test((e.textContent || '').trim()))
        if (el) el.click()
      }).catch(() => {})
    }
  }

  if (!got) {
    const d = await diagnose(page)
    await page.screenshot({ path: QR_PAGE }).catch(() => {})
    logEvent('douyin', 'login.start.fail', { ok: false, why: d.why, kind: d.kind })
    return { already: false, ok: false, why: `没拿到二维码：${d.why}` }
  }

  /* 512×512 原图直接落盘；万一是 http 图，退回元素截图（DPR 2 也够清楚） */
  let wrote = writeDataUrl(got.src, QR_SHOT)
  if (!wrote) {
    try {
      const el = await page.$(QR_SEL)
      if (el) { await el.screenshot({ path: QR_SHOT }); wrote = true }
    } catch { /* 落到下面报错 */ }
  }
  lastSrc = got.src
  await page.screenshot({ path: QR_PAGE }).catch(() => {})

  const st = fs.existsSync(QR_SHOT) ? fs.statSync(QR_SHOT) : null
  logEvent('douyin', 'login.start', { ok: true, url: page.url().slice(0, 80), bytes: st ? st.size : 0, nat: got.nat })
  return {
    already: false,
    ok: true,
    shot: QR_SHOT,
    bytes: st ? st.size : 0,
    nat: got.nat,
    why: `二维码已就绪（${got.nat}×${got.nat} 原图），用抖音 App 扫`,
  }
}

/** 刷新二维码文件。控制台轮询 /login/douyin/qr 时调用 —— 只重抓二维码，
 *  不再把整个浏览器窗口截下来。返回文件路径，拿不到就返回上一张。 */
export async function qrShot() {
  const ctx = getLive('douyin')
  if (!ctx) return fs.existsSync(QR_SHOT) ? QR_SHOT : ''
  const page = ctx.pages().find(p => p.url().includes('creator.douyin.com') || p.url().includes('douyin.com'))
  if (!page) return fs.existsSync(QR_SHOT) ? QR_SHOT : ''
  const g = await grabQr(page)
  if (g.ok && g.src !== lastSrc) {
    if (writeDataUrl(g.src, QR_SHOT)) lastSrc = g.src
  }
  return fs.existsSync(QR_SHOT) ? QR_SHOT : ''
}

/** 轮询一次：登录上了没有。由 server 的 /login/douyin/check 反复调。
 *  🔴 只看已经开着的登录浏览器（getLive），绝不顺手新开 —— 没开始登录就别弹窗。 */
export async function pollLogin() {
  const ctx = getLive('douyin')
  if (!ctx) return { loggedIn: false, why: '还没开始登录（先点「开始登录」）' }
  const quick = await session.quickCheck(ctx)
  if (quick.ok) {
    const alive = await session.checkAlive(ctx)
    if (alive.ok) {
      const cookieFile = await session.exportCookies(ctx)
      logEvent('douyin', 'login.success', { ok: true, uid: alive.uid, name: alive.name, via: alive.via })
      try { fs.copyFileSync(QR_SHOT, path.join(ROOT, 'state', 'qr-douyin-last.png')) } catch { }
      return { loggedIn: true, who: alive, cookieFile }
    }
    return { loggedIn: false, why: `cookie 有了但接口不认：${alive.why}（可能卡在验证，看浏览器窗口）` }
  }
  const page = ctx.pages().find(p => p.url().includes('creator.douyin.com')) || ctx.pages()[0]
  const d = page ? await diagnose(page) : { why: '浏览器窗口关了 —— 重新点「开始登录」' }
  return { loggedIn: false, why: d.why }
}
