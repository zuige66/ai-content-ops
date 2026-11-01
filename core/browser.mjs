/* core/browser.mjs —— Playwright 封装：系统 Chrome + 每平台持久 profile
 * ═══════════════════════════════════════════════════════════════
 * 用 playwright-core + channel:'chrome'（本机已装的 Chrome），不下载 Chromium。
 * profile 每平台一个目录：登录态落盘，之后 headless 干活免再扫码。
 * 这套思路来自 dsh-douyin-scroll 的实测：同一 user-data-dir 不能起第二个
 * Chrome 实例 —— 所以每个平台同一时刻只持有一个 context，用完复用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from './log.mjs'
import { readConfig } from './shell.mjs'

export function profileDir(platform) {
  const dir = path.join(ROOT, 'sessions', platform)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

let channelCache
async function pickChannel() {
  if (channelCache) return channelCache
  const wanted = readConfig().chrome?.channel || 'chrome'
  try {
    channelCache = wanted   // launchPersistentContext 找不到会 throw，到时降级
    return channelCache
  } finally { /* noop */ }
}

/** 起一个持久 context。同一平台同一时刻只允许一个 —— 但「无头」和「有头」
 *  不能互相当对方用：登录要的是有头窗口，/status 起的是无头的。
 *  模式对不上就把旧的关掉重开（🔴 之前就是这里：登录复用了无头实例，
 *  用户桌面上永远弹不出窗口，抖音还当成机器人甩滑块验证码）。 */
const live = new Map()   // platform -> {ctx, headless, pinned}

/* 🔴 同一平台并发 launch 会抢同一个 user-data-dir，Chrome 直接报
 *    "Target page, context or browser has been closed"。控制台首屏三个接口
 *    同时打过来就撞上了，所以启动必须串行 —— 每个平台一条 promise 链。 */
const chain = new Map()
function withLock(platform, fn) {
  const prev = chain.get(platform) || Promise.resolve()
  const next = prev.then(fn, fn)
  chain.set(platform, next.then(() => { }, () => { }))
  return next
}

/** 钉住：这个 context 是长期复用的（insight 的常驻页），/status 的临时工不许关它 */
export function pin(platform) {
  const cur = live.get(platform)
  if (cur) cur.pinned = true
}
export function isPinned(platform) {
  const cur = live.get(platform)
  return Boolean(cur && cur.pinned)
}

export async function launchPersistent(platform, { headless = true, viewport, recordVideo, pinned = false } = {}) {
  return withLock(platform, async () => {
    const cur = live.get(platform)
    if (cur) {
      if (cur.headless === headless) {
        if (pinned) cur.pinned = true
        return { ctx: cur.ctx, reused: true }
      }
      await cur.ctx.close().catch(() => { /* 旧的可能已经死了 */ })
      live.delete(platform)
    }
    const wanted = readConfig().chrome?.channel || 'chrome'
    const opts = {
      headless,
      viewport: viewport || { width: 1440, height: 900 },
      args: ['--no-first-run', '--no-default-browser-check', '--lang=zh-CN'],
    }
    let ctx
    try {
      ctx = await chromium.launchPersistentContext(profileDir(platform), { ...opts, channel: wanted })
    } catch (e) {
      // 没装 Chrome 就降级 Edge —— Windows 上总有 Edge
      ctx = await chromium.launchPersistentContext(profileDir(platform), { ...opts, channel: 'msedge' })
    }
    live.set(platform, { ctx, headless, pinned })
    ctx.on('close', () => live.delete(platform))
    return { ctx, reused: false }
  })
}

export function getLive(platform) {
  const cur = live.get(platform)
  return cur ? cur.ctx : null
}

/** 当前 context 是无头还是有头。null = 没有 context。
 *  给"要弹窗口"的动作判断用：已经是有头窗口就直接复用，别关人家。 */
export function liveHeadless(platform) {
  const cur = live.get(platform)
  return cur ? Boolean(cur.headless) : null
}

/** 从持久 context 里看 HttpOnly cookie —— 判登录唯一可信的来源。
 *  document.cookie 永远判负（sessionid 是 HttpOnly），这是踩过实坑的结论。 */
export async function hasCookie(ctx, domainPart, names) {
  const cookies = await ctx.cookies()
  return cookies.some(c =>
    c.domain.includes(domainPart) && names.includes(c.name) && c.value && c.value.length > 4)
}
