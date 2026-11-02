/* core/browser.mjs —— Playwright 封装：系统 Chrome + 每平台持久 profile
 * ═══════════════════════════════════════════════════════════════
 * 用 playwright-core + channel:'chrome'（本机已装的 Chrome），不下载 Chromium。
 * profile 每平台一个目录：登录态落盘，之后 headless 干活免再扫码。
 * 这套思路来自 dsh-douyin-scroll 的实测：同一 user-data-dir 不能起第二个
 * Chrome 实例 —— 所以每个平台同一时刻只持有一个 context，用完复用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
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

/** 取当前平台活着的 context。
 *
 *  🔴 必须**连 CDP 那一路也算进来**。以前只查 `live`（launchPersistent 用的
 *     Map），而 attachLive 只写 `liveBrowsers`，于是 liveMode 下 getLive()
 *     恒为 null：insight 每次另起一个 headless Chrome、/ctl/status 永远显示
 *     「没有浏览器」、manage 的「复用用户窗口」全部落空。
 *     CDP 那个 context 不能进 `live` —— launchPersistent 会在模式不匹配时
 *     把它 close() 掉，等于把用户的浏览器窗口关了。 */
export function getLive(platform) {
  const cur = live.get(platform)
  if (cur) return cur.ctx
  const b = liveBrowsers.get(platform)
  if (b && b.isConnected()) {
    try { return b.contexts()[0] || null } catch { return null }
  }
  return null
}

/** 当前 context 是无头还是有头。null = 没有 context。
 *  给"要弹窗口"的动作判断用：已经是有头窗口就直接复用，别关人家。 */
export function liveHeadless(platform) {
  const cur = live.get(platform)
  if (cur) return Boolean(cur.headless)
  /* CDP 接管的永远是真人浏览器，有头 */
  const b = liveBrowsers.get(platform)
  return b && b.isConnected() ? false : null
}

/** 从持久 context 里看 HttpOnly cookie —— 判登录唯一可信的来源。
 *  document.cookie 永远判负（sessionid 是 HttpOnly），这是踩过实坑的结论。 */
export async function hasCookie(ctx, domainPart, names) {
  const cookies = await ctx.cookies()
  return cookies.some(c =>
    c.domain.includes(domainPart) && names.includes(c.name) && c.value && c.value.length > 4)
}

/* ═══════════════════════════════════════════════════════════════
 * 真人浏览器接管（CDP）—— 专治「每次投稿都要短信验证码」
 * ═══════════════════════════════════════════════════════════════
 *
 * 🔴 为什么 launchPersistent 一定会被风控：
 *    Playwright 起的 Chrome 带 --enable-automation，navigator.webdriver 是 true，
 *    没有任何浏览历史、没有插件、没有本地存储的站点数据，每次都是一个「刚装好的
 *    空浏览器」。抖音的风控模型对这种环境判定极严 —— 上传视频这种高价值写操作
 *    必然要短信二次验证，今天连发十几次更是直接拉满。
 *
 * 这里的做法反过来：**我们自己 spawn 系统 Chrome**（不带 automation 标记），
 * 开调试端口，Playwright 事后用 connectOverCDP 附上去。浏览器就是用户日常在用的
 * 那个 —— 真实指纹、真实历史、真实插件，抖音看到的和你手动点浏览器没区别。
 *
 * 代价：首次要在这个 profile 里手动扫码登录一次（之后一直有效）。
 * 注意：这个 context 不能 close()，close 会把用户的浏览器窗口关掉。
 */
const liveBrowsers = new Map()   // platform -> Browser（CDP 连接）

function chromeExeCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  return [
    path.join(pf, 'Google/Chrome/Application/chrome.exe'),
    path.join(pf86, 'Google/Chrome/Application/chrome.exe'),
    local ? path.join(local, 'Google/Chrome/Application/chrome.exe') : '',
    path.join(pf, 'Microsoft/Edge/Application/msedge.exe'),
    path.join(pf86, 'Microsoft/Edge/Application/msedge.exe'),
  ].filter(p => p && fs.existsSync(p))
}

async function cdpAlive(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch { return false }
}

/** 真人模式专用的 profile 目录。跟 sessions/<platform> 分开：
 *  同一 user-data-dir 不能同时被 Playwright 和真人 Chrome 打开。 */
export function liveProfileDir(platform) {
  const dir = path.join(ROOT, 'sessions', platform + '-live')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 保证调试端口上有 Chrome 在跑；没有就拉一个起来（独立进程，活过本服务重启）。 */
export async function ensureLiveChrome(platform, { port } = {}) {
  const cfg = readConfig().chrome || {}
  const p = Number(port || cfg.debugPort || 9222)
  if (await cdpAlive(p)) return { port: p, spawned: false }

  const exe = chromeExeCandidates()[0]
  if (!exe) throw new Error('找不到 Chrome / Edge 可执行文件 —— 装一个 Chrome 再来')
  const dir = liveProfileDir(platform)
  const child = spawn(exe, [
    `--remote-debugging-port=${p}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--lang=zh-CN',
    '--disable-features=Translate,ChromeWhatsNewUI',
    'about:blank',
  ], { detached: true, stdio: 'ignore' })
  child.unref()

  for (let i = 0; i < 60; i++) {
    if (await cdpAlive(p)) return { port: p, spawned: true, pid: child.pid }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`Chrome 调试端口 ${p} 15 秒内没起来 —— 看看是不是有别的 Chrome 占着这个 profile`)
}

/** 附到真人 Chrome 上，拿它的 context。返回形状跟 launchPersistent 一致（{ctx}），
 *  调用方可以无痛替换。 */
export async function attachLive(platform, { port } = {}) {
  return withLock(platform, async () => {
    const { port: p, spawned } = await ensureLiveChrome(platform, { port })
    let browser = liveBrowsers.get(platform)
    if (!browser || !browser.isConnected()) {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`)
      liveBrowsers.set(platform, browser)
      browser.on('disconnected', () => liveBrowsers.delete(platform))
    }
    const ctx = browser.contexts()[0] || await browser.newContext()
    return { ctx, reused: !spawned, live: true }
  })
}

/** 关掉调试端口上的 Chrome（收工用，或者 profile 被占住了要重开）。
 *  只在这个服务自己起的实例上调用 —— 别去关用户手动开的浏览器。 */
export async function closeLive(platform) {
  const b = liveBrowsers.get(platform)
  if (b) {
    liveBrowsers.delete(platform)
    await b.close().catch(() => { })
  }
}
