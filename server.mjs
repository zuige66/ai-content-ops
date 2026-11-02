#!/usr/bin/env node
/**
 * server.mjs —— zhibo-auto 控制台（127.0.0.1:18090）
 * ============================================================================
 * 这个文件跟同目录 zhibo 的 server.mjs 是同一套骨架，只做三件事：
 *
 *   1. 发控制台页 —— 静态资源白名单，白名单外的一概不给
 *   2. 管业务接口 —— 视频 / 投稿 / 评论 / 任务 / 日志
 *   3. 报自己的健康状况 —— /ctl/*
 *
 * 为什么这边没有"控制台 + 桥"两个进程：zhibo 那边控制台要管 bridge 的启停，
 * 所以必须拆开、必须反向代理。这边的业务是同步 import 进来的模块，没有第二个
 * 进程可管，硬拆只会多一层代理和一次转发延迟。
 *
 * 目录分工（跟 zhibo 一致）：
 *   .run/server.log     控制台自己的输出，/ctl/log 读的就是它
 *   .run/server.pid     当前进程，端口被占时能说清是谁占着
 *   logs/<platform>/    业务留痕，NDJSON，按平台分开
 *   state/              任务队列落盘
 *
 * 🔴 红线：写操作（发布 / 评论）默认 dry-run + 人工确认 + 熔断器；单账号低频。
 * 🔴 静态只发白名单后缀，且只在这两个根里：web/ 和 video/out/。
 *    这个项目目录里躺着 config.json（指向 llm.json 的 key 路径）、
 *    sessions/（抖音登录态）、cookies —— 服务虽然只听 127.0.0.1，
 *    但浏览器里随手敲一下路径就能看到，等于把 key 摆在桌面上。
 * ============================================================================
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { logEvent } from './core/log.mjs'
import { readConfig, run } from './core/shell.mjs'
import { enqueue, register, listJobs, getJob, resolveConfirm, reconcilePublish } from './core/jobs.mjs'
import { makeVideo } from './video/make.mjs'
import { makeCover } from './video/cover.mjs'
import { generateScript } from './video/script.mjs'
import { runPipeline } from './video/pipeline.mjs'
import { listTypes, getType } from './video/types.mjs'
import { petPayload } from './video/pet-assets.mjs'
import { listLibrary } from './video/library.mjs'
import { listPlans, readPlan, setPlanStatus, planStock, checkPlanGate } from './video/plans.mjs'
import { findCandidates, draftPlan, nextEpisode } from './video/discover.mjs'
import { gc as videoGc } from './video/gc.mjs'
import { MANIFEST } from './core/agent-api.mjs'
import * as douyinSession from './douyin/session.mjs'
import * as douyinLogin from './douyin/login.mjs'
import * as douyinPublish from './douyin/publish.mjs'
import * as douyinComment from './douyin/comment.mjs'
import * as douyinInsight from './douyin/insight.mjs'
import * as douyinManage from './douyin/manage.mjs'
import * as biliSession from './bili/session.mjs'
import * as biliLogin from './bili/login.mjs'
import * as biliPublish from './bili/publish.mjs'
import * as biliComment from './bili/comment.mjs'
import { launchPersistent, getLive, isPinned } from './core/browser.mjs'

/* ══════════════════════════════════════════════════════════════════════
 * 常量
 * ══════════════════════════════════════════════════════════════════════ */

const DIR = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(DIR, 'web')
const OUT = path.join(DIR, 'video', 'out')
const RUN = path.join(DIR, '.run')
const LOG_FILE = path.join(RUN, 'server.log')
const PID_FILE = path.join(RUN, 'server.pid')
const LOG_MAX = 2 * 1024 * 1024

/** 业务配置是手写带注释的，读失败就退回空对象，别让一行注释写错拦住整个服务 */
const CFG = (() => {
  try { return readConfig() } catch { return {} }
})()
/** 每次现读一份 —— 改了 config.json 不用重启，/status 也不该显示旧值 */
const cfgNow = () => {
  try { return readConfig() } catch { return CFG }
}

const PORT = Number(process.env.AUTO_PORT || CFG.port || 18090)
const STARTED_AT = Date.now()

/* ══════════════════════════════════════════════════════════════════════
 * 运行时小工具
 * ══════════════════════════════════════════════════════════════════════ */

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** 原子写：先写 .tmp 再 rename。半截文件读起来会变成"整个状态丢了"，比写失败更难查。 */
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 控制台一行：终端 + .run/server.log。
 *  日志写不进去（磁盘满 / 权限）绝不能反过来把服务搞挂，所以整段吞异常。 */
const log = (...a) => {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${a.join(' ')}`
  console.log(line)
  try {
    fs.mkdirSync(RUN, { recursive: true })
    /* 超过 2MB 就清空重来。控制台日志只用来回答"什么时候重启过、上次为什么挂"，
     * 留几百 KB 足够，做滚动反而是给一个本地小工具加不必要的机制。 */
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) fs.writeFileSync(LOG_FILE, '')
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch { /* 见上 */ }
}

/** 读文件尾巴 —— 进程秒退时把真原因捞出来，别只回一句"起不来" */
const tailOf = (file, bytes = 8192) => {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const start = Math.max(0, size - bytes)
      const buf = Buffer.alloc(size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

const alive = (pid) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 从端口反查 pid —— 双击了两次启动脚本时，能说清是谁占着 */
const pidOnPort = (port) => {
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || ''
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes(`:${port}`) || !/LISTENING/i.test(line)) continue
      const cols = line.trim().split(/\s+/)
      const pid = Number(cols[cols.length - 1])
      if (pid > 0 && pid !== process.pid) return pid
    }
  } catch { /* netstat 不在就算了，不影响主流程 */ }
  return 0
}

const openBrowser = (url) => {
  try {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch { /* 打不开就让人手点，不值得报错 */ }
}

/* ══════════════════════════════════════════════════════════════════════
 * 任务处理器登记
 * ══════════════════════════════════════════════════════════════════════ */

register('video', makeVideo)
register('pipeline', runPipeline)
register('publish', (job, h) => job.platform === 'bili' ? biliPublish.publish(job, h) : douyinPublish.publish(job, h))
register('comment', (job, h) => job.platform === 'bili' ? biliComment.comment(job, h) : douyinComment.comment(job, h))

/* ══════════════════════════════════════════════════════════════════════
 * 登录态
 *
 * 带 30 秒缓存：/status 每 6 秒被轮询一次，每次都拉浏览器会把人机器拖死。
 * 已开着的登录浏览器直接用（别把人家的有头窗口关了）；
 * 没有才临时起一个无头，查完就关。
 * ══════════════════════════════════════════════════════════════════════ */

const loginCache = new Map()

async function loginState(platform) {
  const c = loginCache.get(platform)
  if (c && Date.now() - c.at < 30000) return c.state

  let state
  const mod = platform === 'bili' ? biliSession : douyinSession
  let ctx = getLive(platform)
  const borrowed = Boolean(ctx)
  try {
    if (!ctx) ctx = (await launchPersistent(platform, { headless: true })).ctx
    const quick = await mod.quickCheck(ctx)
    if (quick.ok) {
      /* 顺带把账号名捞出来 —— 控制台显示「zuige大肥鱼」比「已登录」有用得多，
       * 一眼能看出是不是登错号了。捞不到不影响 loggedIn 判定。 */
      const ok = await mod.checkAlive(ctx).catch(() => ({ ok: false }))
      state = ok.ok
        ? { loggedIn: true, who: { uid: ok.uid || '', name: ok.name || '' } }
        : { loggedIn: true, stale: true, why: ok.why || '接口没认出登录态' }
    } else {
      state = { loggedIn: false, why: quick.why }
    }
  } catch (e) {
    state = { loggedIn: false, why: String(e && e.message || e).slice(0, 160) }
  }
  /* 临时工用完就走，别占着 profile —— 但抖音数据页钉住的那个不许关
   * （关了下一次请求要重开浏览器） */
  if (!borrowed && ctx && !isPinned(platform)) await ctx.close().catch(() => { })
  loginCache.set(platform, { at: Date.now(), state })
  return state
}

/* ══════════════════════════════════════════════════════════════════════
 * HTTP 骨架
 * ══════════════════════════════════════════════════════════════════════ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

/** 允许直接发的后缀。
 *  🔴 故意**不含 .json / .txt / .py / .mjs / .bat / .md** ——
 *     这个目录里有 config.json（指向 llm.json 的 key）、
 *     server.mjs 自己。白名单挡掉比黑名单可靠。 */
const ALLOW_EXT = new Set([
  '.html', '.js', '.css', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico',
  '.mp4', '.webm', '.mp3', '.wav', '.woff2', '.woff',
])
/** 白名单之外的兜底：就算哪天误加了后缀，这几个名字也永远不给 */
const DENY_NAME = new Set(['config.json', 'llm.json', 'cookies.txt', 'server.mjs', '_script.json'])

/** 静态挂载点：前缀 → 根目录。前缀之外一律不发，等于把"能访问的目录"
 *  写死在代码里，不靠路径判断。 */
const STATIC_MOUNTS = [
  ['/app/', path.join(WEB, 'app')],
  ['/styles/', path.join(WEB, 'styles')],
  ['/vendor/', path.join(WEB, 'vendor')],
  ['/media/', OUT],
  /* 视频模板目录（2026-11-02）：预览页要把 templates/<类型>/index.html 装进 iframe，
   * 模板里的 pet.js / bg.png 都是相对路径，所以必须按目录原样挂，不能只发单个 html。 */
  ['/tpl/', path.join(DIR, 'video', 'templates')],
  /* 皮套素材（2026-11-02）：在 zhibo 项目里，不在本仓库。
   * http 预览页 load file:// 会被浏览器拦，所以开一条只读通道过去。 */
  ['/petasset/', path.join('D:\\Workplace\\zhibo', 'assets')],
]

/* 皮套 payload 的 http 版：把 file:///D:/... 换成 /petasset/...
 * 素材在 D:\Workplace\zhibo\assets 下，所以相对 assets 取路径即可。
 * 素材不在（换了机器）就原样返回，模板会退回静图，不至于整页挂掉。 */
const PET_ASSET_ROOT = 'D:\\Workplace\\zhibo\\assets'
function petPayloadForHttp(cfg) {
  const raw = petPayload(cfg)
  const toHttp = (v) => {
    if (typeof v !== 'string' || !v) return v
    /* fileUrl() 出来是 file:///D:/Workplace/zhibo/assets/xxx */
    const norm = v.replace(/^file:\/\/\//, '').replace(/\//g, '\\')
    const root = PET_ASSET_ROOT.toLowerCase()
    if (norm.toLowerCase().startsWith(root)) {
      return '/petasset/' + norm.slice(PET_ASSET_ROOT.length).replace(/\\/g, '/').replace(/^\/+/, '')
    }
    return v
  }
  const out = { ...raw }
  out.anim = toHttp(raw.anim)
  out.still = toHttp(raw.still)
  out.faces = {}
  for (const [k, v] of Object.entries(raw.faces || {})) out.faces[k] = toHttp(v)
  return out
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读请求体，直接给对象 —— 每个路由都写一遍 JSON.parse(...toString()) 纯噪音。
 *  解析失败给 {}，让路由自己用「缺字段」的错误话术回人话。
 *
 *  🔴 超限时不能只 req.destroy() —— 那样 'end' 永远不会触发，Promise 一直挂着，
 *     请求既没有响应也没有断开，客户端干等到自己的超时。所以先 resolve({})
 *     把话术交给路由（它会回 400 人话），再断开。 */
const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      raw += c
      if (raw.length > 2e6) {
        finish({})
        req.destroy()
      }
    })
    req.on('end', () => {
      try { finish(raw ? JSON.parse(raw) : {}) } catch { finish({}) }
    })
    req.on('error', () => finish({}))
    req.on('aborted', () => finish({}))
  })

/** 发一个文件。命中返回 true，其余（越界 / 后缀不在白名单 / 不存在）返回 false，
 *  由调用方决定 404 怎么说话。带 ETag，二次访问走 304。 */
function sendFile(req, res, base, rel, cache = 'no-cache') {
  let clean
  try { clean = decodeURIComponent(rel) } catch { return false }
  clean = clean.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!clean || clean.includes('\0')) return false

  const full = path.resolve(base, clean)
  /* 防目录穿越：解析完必须还在 base 里 */
  if (full !== base && !full.startsWith(base + path.sep)) return false
  /* 点开头的目录/文件（.run / .git / .workbuddy-ai）一律不给 */
  if (clean.split('/').some((s) => s.startsWith('.'))) return false
  if (!ALLOW_EXT.has(path.extname(full).toLowerCase())) return false
  if (DENY_NAME.has(path.basename(full).toLowerCase())) return false

  let st
  try { st = fs.statSync(full) } catch { return false }
  if (!st.isFile()) return false

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': cache })
    res.end()
    return true
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    'cache-control': cache,
    etag,
  })
  if (req.method === 'HEAD') { res.end(); return true }
  fs.createReadStream(full).pipe(res)
  return true
}

/** 控制台页 + 模块 + 样式 + 字体 + 成片。都不在挂载表里的返回 false。 */
function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(req, res, WEB, 'index.html')
  }
  /* web/ 根目录下的独立页面（2026-11-02 加 preview.html）。
   * 🔴 只放行白名单里的文件名，不能按 pathname 直发 web/ ——
   *    那样 web/ 下任何文件都能被访问到。 */
  const PAGE_WHITELIST = new Set(['preview.html'])
  const page = pathname.replace(/^\//, '')
  if (PAGE_WHITELIST.has(page)) {
    return sendFile(req, res, WEB, page)
  }
  const mount = STATIC_MOUNTS.find(([pre]) => pathname.startsWith(pre))
  if (!mount) return false
  /* vendor 里的文件名带版本、内容不变，可以长缓存；其余（自己的模块和样式）
   * 一律 no-cache —— 改完存盘刷新就得看见，不然调样式会疯。 */
  const cache = mount[0] === '/vendor/' ? 'public, max-age=86400' : 'no-cache'
  return sendFile(req, res, mount[1], pathname.slice(mount[0].length), cache)
}

/* ══════════════════════════════════════════════════════════════════════
 * 控制 API（/ctl/*）—— 回答"这个进程自己怎么样"，不碰业务
 * ══════════════════════════════════════════════════════════════════════ */

function ctlStatus() {
  const jobs = listJobs({ limit: 500 })
  const cfg = cfgNow()
  const recorded = readJson(PID_FILE, null)
  const count = (s) => jobs.filter((j) => j.status === s).length

  return {
    ok: true,
    dir: DIR,
    ctl: {
      pid: process.pid,
      port: PORT,
      upSec: Math.round(process.uptime()),
      startedAt: STARTED_AT,
      node: process.version,
      platform: process.platform,
    },
    cfg: {
      port: cfg.port ?? PORT,
      durSec: cfg.video?.durSec ?? null,
      chrome: cfg.chrome?.channel || '',
      comment: cfg.comment?.enabledOn || {},
      rateLimitSec: cfg.rateLimitSec || {},
    },
    queue: {
      total: jobs.length,
      running: count('running'),
      waiting: count('pending'),
      confirm: count('awaiting-confirm'),
      failed: count('failed'),
    },
    /* 浏览器实例是这套系统里唯一"进程之外还活着"的东西，
     * 页面显示不出来的时候先看这里：context 在 = Chrome 还开着。 */
    browser: {
      douyin: Boolean(getLive('douyin')),
      bili: Boolean(getLive('bili')),
    },
    files: {
      log: path.relative(DIR, LOG_FILE).replace(/\\/g, '/'),
      pid: recorded ? { pid: recorded.pid, alive: alive(recorded.pid) } : null,
    },
  }
}

async function doctorInfo() {
  const { default: ffmpegPath } = await import('ffmpeg-static')
  const ff = await run(ffmpegPath, ['-version'], { timeoutMs: 10000 })
  return {
    ok: true,
    ffmpeg: ff.code === 0 ? ff.stdout.split('\n')[0] : 'FAIL ' + ff.stderr.slice(0, 120),
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 路由
 * ══════════════════════════════════════════════════════════════════════ */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const p = u.pathname
  let m

  try {
    /* ── 静态：控制台页 + 模块 + 样式 + 字体 + 成片 ───────────────── */
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(req, res, p)) return
    }

    /* ── 控制 API ────────────────────────────────────────────────── */
    if (req.method === 'GET' && p === '/ctl/status') {
      return json(res, 200, ctlStatus())
    }
    if (req.method === 'GET' && p === '/ctl/log') {
      const n = Math.min(500, Math.max(20, Number(u.searchParams.get('n') || 200)))
      const lines = tailOf(LOG_FILE, 256 * 1024).split(/\r?\n/).filter(Boolean).slice(-n)
      return json(res, 200, { ok: true, file: '.run/server.log', lines })
    }
    if (req.method === 'GET' && (p === '/ctl/doctor' || p === '/doctor')) {
      return json(res, 200, await doctorInfo())
    }
    /* 页面结构探测：改版后想知道某个控件还在不在、选择器还准不准，打这个。
     * 例：/browser/probe?url=...upload&find=定时发布
     * 只读，不上传不发任何东西。 */
    if (req.method === 'GET' && p === '/browser/probe') {
      try {
        const { attachLive } = await import('./core/browser.mjs')
        const target = u.searchParams.get('url') || 'https://creator.douyin.com/creator-micro/content/upload'
        const find = u.searchParams.get('find') || '定时发布'
        const { ctx } = await attachLive('douyin')
        const page = ctx.pages()[0] || await ctx.newPage()
        if (page.url() !== target) {
          await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 })
          await page.waitForTimeout(5000)
        }
        const hits = await page.evaluate((needle) => {
          const out = []
          for (const el of document.querySelectorAll('*')) {
            if ((el.textContent || '').trim() !== needle || el.children.length) continue
            out.push({
              tag: el.tagName,
              cls: String(el.className || '').slice(0, 70),
              parentCls: String(el.parentElement && el.parentElement.className || '').slice(0, 70),
              grandCls: String(el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.className || '').slice(0, 70),
            })
            if (out.length >= 3) break
          }
          return out
        }, find)
        const radios = await page.locator(`[class^='radio']:has-text('${find}')`).count()
        const byText = await page.getByText(find, { exact: true }).count()
        const timeInput = await page.locator('.semi-input[placeholder="日期和时间"]').count()
        return json(res, 200, {
          ok: true, url: page.url(), find,
          textHits: hits, radioSelector: radios, exactText: byText, timeInput,
          note: 'radioSelector / timeInput 都 ≥1 才说明定时发布的选择器还准',
        })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 300) })
      }
    }
    /* 真人浏览器（CDP）体检：投稿前想知道「会不会弹验证码」，先打这个。
     * 关键看 webdriver —— false 才是真人环境，true 说明还在用 Playwright 自带实例。 */
    if (req.method === 'GET' && p === '/browser/live') {
      try {
        const { attachLive } = await import('./core/browser.mjs')
        const { ctx, reused } = await attachLive('douyin')
        const page = ctx.pages()[0] || await ctx.newPage()
        if (!/douyin\.com/.test(page.url())) {
          await page.goto('https://creator.douyin.com/creator-micro/home', { waitUntil: 'domcontentloaded', timeout: 60000 })
          await page.waitForTimeout(2500)
        }
        const probe = await page.evaluate(() => ({
          webdriver: navigator.webdriver,
          plugins: navigator.plugins.length,
          ua: navigator.userAgent.slice(0, 80),
        }))
        const alive = await douyinSession.checkAlive(ctx)
        return json(res, 200, {
          ok: true, reused, url: page.url(), ...probe,
          loggedIn: alive.ok, why: alive.why || '',
          note: 'webdriver=false 且 loggedIn=true 就是理想状态',
        })
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e && e.message || e).slice(0, 300) })
      }
    }
    /* AI 自描述：接上来的 agent 先打这个，就知道能干什么、要不要确认 */
    if (req.method === 'GET' && p === '/agent') {
      return json(res, 200, { ok: true, base: `http://127.0.0.1:${PORT}`, ...MANIFEST })
    }

    /* ── 状态 ── */
    if (req.method === 'GET' && p === '/status') {
      const [douyin, bili] = await Promise.all([loginState('douyin'), loginState('bili')])
      const jobs = listJobs({ limit: 20 }).map((j) => ({
        id: j.id, kind: j.kind, platform: j.platform, title: j.title,
        status: j.status, error: j.error,
        result: j.result && j.result.note ? { note: j.result.note } : null,
        updatedAt: j.updatedAt,
      }))
      return json(res, 200, { ok: true, douyin, bili, jobs, comment: cfgNow().comment || {} })
    }

    /* ── 登录 ── */
    if ((m = p.match(/^\/login\/(douyin|bili)\/start$/)) && req.method === 'POST') {
      const mod = m[1] === 'bili' ? biliLogin : douyinLogin
      loginCache.delete(m[1])
      return json(res, 200, { ok: true, ...(await mod.startLogin()) })
    }
    if ((m = p.match(/^\/login\/(douyin|bili)\/qr$/)) && req.method === 'GET') {
      /* 抖音：只要那张二维码原图（512×512 内联图，不掺浏览器窗口边框）
       * B站：还是截窗口 —— 它的情况不一样，得连滑块/提示一起给人看 */
      const f = path.join(DIR, 'state', `qr-${m[1]}.png`)
      try {
        if (m[1] === 'douyin') {
          await douyinLogin.qrShot()
        } else {
          const ctx = getLive(m[1])
          const page = ctx && ctx.pages().find((pg) => /douyin|bilibili|passport/.test(pg.url()))
          if (page) await page.screenshot({ path: f, timeout: 5000 })
        }
      } catch { /* 拿不到就给上一张 */ }
      if (!fs.existsSync(f)) return json(res, 404, { ok: false, error: '还没开始登录，没有二维码' })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      return fs.createReadStream(f).pipe(res)
    }
    if ((m = p.match(/^\/login\/(douyin|bili)\/check$/)) && req.method === 'GET') {
      const mod = m[1] === 'bili' ? biliLogin : douyinLogin
      const out = await mod.pollLogin()
      if (out.loggedIn) loginCache.delete(m[1])
      return json(res, 200, { ok: true, ...out })
    }

    /* ── 抖音账号数据（只读，全走页面上下文 fetch，不逆向签名） ── */
    if (req.method === 'GET' && p === '/douyin/profile') {
      const r = await douyinInsight.profile()
      return json(res, r.ok ? 200 : 502, r)
    }
    if (req.method === 'GET' && p === '/douyin/works') {
      const r = await douyinInsight.works({ limit: Number(u.searchParams.get('limit')) || 20 })
      return json(res, r.ok ? 200 : 502, r)
    }
    if (req.method === 'GET' && p === '/douyin/comments') {
      const item = u.searchParams.get('item')
      if (!item) return json(res, 400, { ok: false, error: '要给 ?item=<作品 id（明文或加密都行）>' })
      const r = await douyinInsight.comments(item, {
        count: Number(u.searchParams.get('count')) || 20,
        cursor: Number(u.searchParams.get('cursor')) || 0,
      })
      return json(res, r.ok ? 200 : 502, r)
    }
    if (req.method === 'GET' && p === '/douyin/live') {
      const r = await douyinInsight.live({
        days: Number(u.searchParams.get('days')) || 90,
        limit: Number(u.searchParams.get('limit')) || 50,
      })
      return json(res, r.ok ? 200 : 502, r)
    }
    /* ── 直播收入（音浪）。2026-11-02 新增。
     *  单位是音浪/抖币，不是人民币；20 音浪 = 1 元（主播到手价）。
     *  抖音侧「每天 12 点前更新昨日收益」，所以今天的数要看直播间实时。 */
    if (req.method === 'GET' && p === '/douyin/income') {
      const r = await douyinInsight.income({ force: u.searchParams.get('force') === '1' })
      return json(res, r.ok ? 200 : 502, r)
    }
    /* 某条评论下面已有的回复（含我回过的）。
     * 自动回复脚本靠它判断「这条我是不是已经回过」，比只看 replyCount 准 ——
     * replyCount>0 可能是别人回的，盲目跳过会漏回一堆。 */
    if (req.method === 'GET' && p === '/douyin/replies') {
      const cid = u.searchParams.get('comment')
      if (!cid) return json(res, 400, { ok: false, error: '要给 ?comment=<commentId>' })
      const r = await douyinInsight.replies(cid, { count: Number(u.searchParams.get('count')) || 20 })
      return json(res, r.ok ? 200 : 502, r)
    }
    /* ── 抖音数据全量刷新（唯一会真去打抖音的入口，除启动预热外） ──
     *  平时 GET 全是读本地 state/cache/douyin/，这个才是"去抓一遍"。 */
    if (req.method === 'POST' && p === '/douyin/refresh') {
      const r = await douyinInsight.refreshAll()
      return json(res, r.ok ? 200 : 502, r)
    }
    /* 缓存现状：哪几份数据、什么时候抓的 */
    if (req.method === 'GET' && p === '/douyin/cache') {
      return json(res, 200, { ok: true, at: douyinInsight.cacheInfo() })
    }
    /* 回复评论：不 confirm 就只回显将要发什么（一个字节都不发）
     * 🔴 commentId 可以是加密串，commentIdNum 是数字 id。数字 id 只有 www 域
     *    评论接口给，发给抖音时也只认数字 —— 两个都给最稳，只给加密串时会自己反查。 */
    if (req.method === 'POST' && p === '/douyin/reply') {
      const body = await readBody(req)
      const r = await douyinManage.reply({
        itemId: body.itemId, commentId: body.commentId, commentIdNum: body.commentIdNum,
        text: body.text, confirm: body.confirm === true,
      })
      return json(res, 200, { ok: true, ...r })
    }
    /* 编辑：弹出真实后台编辑页（update_v2 入参没验证，不代发） */
    if (req.method === 'POST' && p === '/douyin/edit/open') {
      const body = await readBody(req)
      return json(res, 200, await douyinManage.openEditor({ itemId: body.itemId }))
    }

    /* ── 本地成片库：video/out 里所有出过的片子（含"记录还在文件没了"的） ── */
    if (p === '/video/list' && req.method === 'GET') {
      return json(res, 200, listLibrary())
    }
    /* ── video/out 清理：默认只预览，apply:true 才真删 ── */
    if (p === '/video/gc') {
      if (req.method === 'GET') {
        return json(res, 200, videoGc({
          raw: u.searchParams.get('raw') === '1',
          publish: u.searchParams.get('publish') === '1',
        }))
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        return json(res, 200, videoGc({
          apply: body.apply === true,
          raw: body.raw === true,
          publish: body.publish === true,
        }))
      }
    }

    /* ── 视频版式清单（从后端给，前端不硬编码） ── */
    if (p === '/video/types' && req.method === 'GET') {
      return json(res, 200, { ok: true, types: listTypes() })
    }

    /* ── 预览页存脚本（2026-11-02）───────────────────────────────
     * 预览页改完文案直接落成 video/scripts/<name>.json，就能喂 make.mjs。
     * 🔴 只写 video/scripts/，文件名走 basename —— 预览页是浏览器页面，
     *    不能让它决定写到哪儿去。 */
    if (p === '/video/script/save' && req.method === 'POST') {
      const body = await readBody(req)
      const name = path.basename(String(body.name || '').trim())
      if (!name || !name.endsWith('.json')) {
        return json(res, 400, { ok: false, error: '文件名要以 .json 结尾' })
      }
      if (!body.script || !Array.isArray(body.script.segments)) {
        return json(res, 400, { ok: false, error: 'script.segments 必须是数组' })
      }
      const dir = path.join(DIR, 'video', 'scripts')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, name), JSON.stringify(body.script, null, 2), 'utf8')
      return json(res, 200, { ok: true, file: `video/scripts/${name}` })
    }

    /* ── 实时预览页的数据（2026-11-02）─────────────────────────────
     * 预览页 /preview.html 把 templates/<类型>/index.html 装进 iframe，
     * 编辑文案后实时重渲染。模板需要三样东西才画得对：
     *   1) 皮套 payload（petPayload）—— 不传就退回静图，动效全没了
     *   2) 画幅 —— 从 types.mjs 取，别在前端硬编码
     *   3) 默认脚本 —— 打开就有东西看，不用先手打一遍
     * 一次性全给，预览页只发一个请求。
     *
     * 🔴 皮套素材要**转成 http 地址**再给。
     *    模板页录屏时是 file:// 打开的，file:// 引 file:// 没问题；
     *    但预览页是 http://，http 页面去 load file:// 会被浏览器直接拦掉
     *    （Not allowed to load local resource），PET.mount 等图加载等到 8 秒
     *    超时才开表，表现就是「气泡要等八秒才出来」。
     *    所以这里把绝对路径换成 /petasset/ 下的 http 地址（见 STATIC_MOUNTS）。 */
    if (p === '/video/preview-kit' && req.method === 'GET') {
      const typeId = u.searchParams.get('type') || 'talk'
      const t = getType(typeId)
      let script = null
      const wantScript = u.searchParams.get('script')
      if (wantScript) {
        /* 只允许 video/scripts/ 下的文件名，防路径穿越 */
        const safe = path.basename(String(wantScript))
        const f = path.join(DIR, 'video', 'scripts', safe)
        try { script = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { script = null }
      }
      return json(res, 200, {
        ok: true,
        type: { id: t.id, name: t.name, width: t.width, height: t.height, segChars: t.segChars },
        pet: petPayloadForHttp(cfgNow()),
        script,
      })
    }

    /* ── 策划台 ─────────────────────────────────────────────────────
     * 策划 md 是「出片前的那道闸」，控制台必须看得见，否则闸形同虚设：
     * 人不知道有几期待批，就会绕过它直接去视频工坊点生成。
     * 三个端点都只碰 video/plans/ 下的 md，不碰别的目录。 */
    if (p === '/plans' && req.method === 'GET') {
      return json(res, 200, { ok: true, stock: planStock(), plans: listPlans() })
    }
    if ((m = p.match(/^\/plans\/([\w.-]+)$/)) && req.method === 'GET') {
      const plan = readPlan(m[1])
      if (!plan) return json(res, 404, { ok: false, error: `找不到策划 ${m[1]}` })
      return json(res, 200, { ok: true, plan })
    }
    if ((m = p.match(/^\/plans\/([\w.-]+)\/status$/)) && req.method === 'POST') {
      const body = await readBody(req)
      const r = setPlanStatus(m[1], String(body.status || ''))
      if (!r.ok) return json(res, 400, r)
      logEvent('core', 'plan.status', { slug: m[1], from: r.prev, to: r.status })
      return json(res, 200, r)
    }

    /* ── 选题源：从 GitHub 找候选，生成 draft 策划 ──────────────────
     * 这是「自动找选题」那一环。两条硬规矩：
     *   · 只产出 draft，**绝不自动 approved**（闸不能自己拆）
     *   · star/语言/许可这些数字只从 GitHub API 取，不许 LLM 编
     * 候选是同步返回（一次 API 调用，几百毫秒）；
     * 生成策划要调 LLM（十几秒），也同步返回 —— 不值得为它加一套队列。 */
    if (p === '/discover/candidates' && req.method === 'GET') {
      try {
        const r = await findCandidates({
          days: Number(u.searchParams.get('days')) || 30,
          minStars: Number(u.searchParams.get('minStars')) || 80,
          limit: Number(u.searchParams.get('limit')) || 12,
          language: u.searchParams.get('language') || '',
        })
        return json(res, 200, { ...r, nextEpisode: nextEpisode() })
      } catch (e) {
        return json(res, 502, { ok: false, error: String(e && e.message || e).slice(0, 200) })
      }
    }
    if (p === '/plans/new' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.repo) return json(res, 400, { ok: false, error: '要给 repo（owner/name）' })
      try {
        const r = await draftPlan({ repo: String(body.repo).trim(), episode: body.episode, template: body.template })
        if (!r.ok) return json(res, 400, r)
        return json(res, 200, { ...r, status: 'draft' })
      } catch (e) {
        return json(res, 502, { ok: false, error: String(e && e.message || e).slice(0, 240) })
      }
    }

    /* ── 写文案（同步返回，不排队 —— 只要几秒，改一版文案不用等 80 秒渲染） ── */
    if (p === '/video/script' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.topic) return json(res, 400, { ok: false, error: '要给 topic（一个主题就行）' })
      const t0 = Date.now()
      const script = await generateScript(body.topic, {
        durSec: Number(body.durSec) || CFG.video?.durSec || 90,
        day: body.day, journalTitle: body.journalTitle, extra: body.extra,
        type: getType(body.template),
      })
      return json(res, 200, { ok: true, ms: Date.now() - t0, script })
    }

    /* ── 出封面（同步，3-5 秒；不排队 —— 封面要反复试字，排队会等到疯） ── */
    if (p === '/video/cover' && req.method === 'POST') {
      const body = await readBody(req)
      const big = String(body.big || body.coverText || '').trim()
      if (!big) return json(res, 400, { ok: false, error: '要给 big（封面大字）' })
      const t0 = Date.now()
      const out = path.join(OUT, 'cover', `c${t0}.png`)
      const r = await makeCover({ big, sub: body.sub, day: body.day, out })
      return json(res, 200, {
        ok: true, ms: Date.now() - t0, ...r,
        url: mediaUrl(r.png),
      })
    }

    /* ── 一条龙：主题 → 文案 → 成片（排队跑，90 秒的片子约 2 分钟） ── */
    if (p === '/pipeline/run' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.topic) return json(res, 400, { ok: false, error: '要给 topic（一个主题就行）' })
      /* 策划闸：带了 plan 就校验它必须是 approved；strictPlans 打开后不带 plan 也拒绝。
       * 默认不拦（试片/调模板很常见），但闸从此有代码了，不再是 UI 摆设。 */
      const gate = checkPlanGate({ planSlug: body.plan, strict: body.strictPlans === true })
      if (!gate.ok) return json(res, 403, gate)
      const j = enqueue({
        kind: 'pipeline', platform: 'video',
        title: `一条龙：${String(body.topic).slice(0, 30)}`,
        params: {
          topic: body.topic, durSec: body.durSec, day: body.day,
          journalTitle: body.journalTitle, extra: body.extra,
          template: body.template || 'diary', petImage: body.petImage,
          plan: gate.plan ? gate.plan.slug : null,
        },
      })
      return json(res, 200, { ok: true, jobId: j.id, plan: gate.plan ? gate.plan.slug : null, note: '排队中：写文案 → 出片，进度看 /jobs/:id/steps' })
    }

    /* ── 做视频 ── */
    if (p === '/video/make' && req.method === 'POST') {
      const body = await readBody(req)
      if (!body.title && !(body.lines || []).length && !(body.segments || []).length) {
        return json(res, 400, { ok: false, error: '至少给个 title、lines 或 segments' })
      }
      /* 同一道策划闸（见 /pipeline/run） */
      const gate = checkPlanGate({ planSlug: body.plan, strict: body.strictPlans === true })
      if (!gate.ok) return json(res, 403, gate)
      const j = enqueue({
        kind: 'video', platform: 'video',
        title: `视频：${body.title || (body.lines || [])[0] || (body.segments || [])[0]?.text || ''}`.slice(0, 60),
        params: {
          template: body.template || 'card', title: body.title, lines: body.lines,
          narration: body.narration, tag: body.tag,
          /* diary 模板专用：Day 号、日记名、气泡/信息卡段落、皮套立绘 */
          day: body.day, journalTitle: body.journalTitle,
          segments: body.segments, petImage: body.petImage,
          plan: gate.plan ? gate.plan.slug : null,
        },
      })
      return json(res, 200, { ok: true, jobId: j.id, plan: gate.plan ? gate.plan.slug : null })
    }
    if ((m = p.match(/^\/video\/preview\/(j\d+)$/)) && req.method === 'GET') {
      const j = getJob(m[1])
      if (!j) return json(res, 404, { ok: false, error: '没有这个任务' })
      const kf = (j.result && j.result.keyframes) || []
      return json(res, 200, {
        ok: true, status: j.status,
        mp4: j.result && j.result.mp4 ? mediaUrl(j.result.mp4) : null,
        cover: j.result && j.result.cover ? mediaUrl(j.result.cover.png) : null,
        script: j.result && j.result.script || null,
        keyframes: kf.map(mediaUrl),
      })
    }

    /* ── 投稿 ── */
    if (p === '/publish' && req.method === 'POST') {
      const body = await readBody(req)
      if (!['douyin', 'bili'].includes(body.platform)) return json(res, 400, { ok: false, error: 'platform 要 douyin 或 bili' })
      /* video 可以是绝对路径，也可以直接给成片库里的 id（/video/list 返回的那个），
       * 后者对 AI 友好得多 —— 它拿到的是 /media/xxx 这种 URL，不该自己拼 Windows 路径 */
      let video = body.video
      if (!video && body.id) {
        const name = path.basename(String(body.id))
        video = path.join(OUT, name, 'video.mp4')
        if (!fs.existsSync(video)) {
          return json(res, 404, { ok: false, error: `video/out/${name}/video.mp4 不存在（用 /video/list 看哪些还在）` })
        }
      }
      if (!video) return json(res, 400, { ok: false, error: '要 video 绝对路径，或 id（成片目录名）' })
      if (!fs.existsSync(video)) return json(res, 404, { ok: false, error: `视频文件不存在：${video}` })
      /* 封面：显式给了就用给的；只给 id 就顺手找成片目录里的 cover.png
       * （from-script 出的片子会带，抖音默认只会抽帧） */
      let cover = body.cover
      if (!cover && body.id) {
        const c = path.join(OUT, path.basename(String(body.id)), 'cover.png')
        if (fs.existsSync(c)) cover = c
      }
      const j = enqueue({
        kind: 'publish', platform: body.platform,
        title: `投稿${body.platform === 'bili' ? 'B站' : '抖音'}：${body.title || ''}`.slice(0, 60),
        params: {
          video, title: body.title, desc: body.desc, tags: body.tags,
          location: body.location, cover, headed: body.headed === true,
          /* scheduleAt："2026-11-02 19:00"。给了就让抖音到点自己发 ——
           * 这是唯一能真正减少验证码打扰的办法：一次上传一次验证，管一天。 */
          scheduleAt: body.scheduleAt || body.schedule_at || '',
        },
      })
      return json(res, 200, {
        ok: true, jobId: j.id, video,
        scheduleAt: body.scheduleAt || null,
        note: body.scheduleAt
          ? `第一段只做 dry-run：填表+截图，定时 ${body.scheduleAt}，确认后由抖音到点发布`
          : '第一段只做 dry-run：填表+截图，停在发布前等你确认',
      })
    }

    /* ── 评论（默认关） ── */
    if (p === '/comment' && req.method === 'POST') {
      const body = await readBody(req)
      if (!['douyin', 'bili'].includes(body.platform)) return json(res, 400, { ok: false, error: 'platform 要 douyin 或 bili' })
      const enabled = body.platform === 'bili' ? biliComment.enabled() : douyinComment.enabled()
      if (!enabled) return json(res, 403, { ok: false, error: '评论默认关闭（config.json comment.enabledOn）——这是有意设计' })
      const j = enqueue({
        kind: 'comment', platform: body.platform,
        title: `评论：${String(body.text || '').slice(0, 24)}`,
        params: { oid: body.oid, awemeId: body.awemeId, text: body.text },
      })
      return json(res, 200, { ok: true, jobId: j.id })
    }

    /* ── 任务 ── */
    if (p === '/jobs' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        jobs: listJobs({
          platform: u.searchParams.get('platform') || undefined,
          limit: Number(u.searchParams.get('limit')) || 50,
        }),
      })
    }
    /* 事后对账：脚本判失败、人手动发成功的那几条，按作品列表翻成 done */
    if (p === '/jobs/reconcile' && req.method === 'POST') {
      let works = []
      try {
        const r = await douyinInsight.works({ limit: 20, force: true })
        works = (r && r.items) || []
      } catch (e) {
        log('对账取作品列表失败：' + String(e.message || e).slice(0, 120))
      }
      const fixed = reconcilePublish(works)
      return json(res, 200, { ok: true, scanned: works.length, fixed })
    }
    /* 🔴 确认闸只能**显式放行**：body.confirm 必须严格等于 true。
     *    以前写的是 `body.confirm !== false`，于是空 body / 非法 JSON /
     *    字段名写错 / 字符串 "false" 全都会被判成"确认"——
     *    一个字节不传的 curl 就能把视频发出去。这是全项目最重要的一道闸，
     *    默认值必须朝"不发"的方向倒。撤销走 confirm:false 或干脆不给。 */
    if ((m = p.match(/^\/jobs\/(j\d+)\/confirm$/)) && req.method === 'POST') {
      const body = await readBody(req)
      const j = resolveConfirm(m[1], body.confirm === true)
      if (!j) return json(res, 404, { ok: false, error: '没有这个任务，或它不在等确认' })
      return json(res, 200, { ok: true, status: j.status })
    }
    if ((m = p.match(/^\/jobs\/(j\d+)\/steps$/)) && req.method === 'GET') {
      const j = getJob(m[1])
      if (!j) return json(res, 404, { ok: false, error: '没有这个任务' })
      /* 截图/成片路径统一转成 /media/ URL，控制台页不用碰 Windows 路径 */
      const r = j.result && typeof j.result === 'object' ? j.result : null
      const result = r ? {
        ...r,
        dir: undefined,
        screenshots: r.screenshots ? r.screenshots.map(mediaUrl) : undefined,
        mp4: r.mp4 ? mediaUrl(r.mp4) : undefined,
        keyframes: r.keyframes ? r.keyframes.map(mediaUrl) : undefined,
      } : j.result
      return json(res, 200, { ok: true, job: { ...j, result } })
    }

    /* ── 日志（平台分开） ── */
    if ((m = p.match(/^\/logs\/(douyin|bili|video)$/)) && req.method === 'GET') {
      const { tailLog } = await import('./core/log.mjs')
      return json(res, 200, { ok: true, platform: m[1], rows: tailLog(m[1], 200) })
    }

    return json(res, 404, { ok: false, error: '不认识的接口：' + req.method + ' ' + p })
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 300)
    log('http.error', JSON.stringify({ path: p, error: msg.slice(0, 200) }))
    logEvent('core', 'http.error', { ok: false, path: p, error: msg.slice(0, 200) })
    return json(res, 500, { ok: false, error: msg })
  }
})

/** 绝对路径 → /media/ URL。video/out 之外的路径原样返回（调用方自己判断）。 */
function mediaUrl(f) {
  if (!f) return null
  const rel = path.relative(OUT, f).replace(/\\/g, '/')
  if (rel.startsWith('..')) return f
  return '/media/' + rel
}

/* ══════════════════════════════════════════════════════════════════════
 * 启动
 * ══════════════════════════════════════════════════════════════════════ */

server.listen(PORT, '127.0.0.1', () => {
  writeJson(PID_FILE, { pid: process.pid, port: PORT, startedAt: STARTED_AT })
  log(`控制台 http://127.0.0.1:${PORT}/  （项目目录 ${DIR}）`)
  log(`静态只发 web/ 与 video/out/ 的白名单后缀；业务日志在 logs/<平台>/，控制台日志在 .run/server.log`)
  log(`写操作默认 dry-run + 确认闸；评论默认关`)

  /* 启动预热：把抖音数据抓一遍落盘。
   * 这是「重启后台才重新获取」的那个时机 —— 之后前端怎么刷都是读本地。
   * 必须延后且不 await：抓一次要起 Chrome、十几秒，不能挡住端口监听。 */
  setTimeout(async () => {
    try {
      log('抖音数据预热中（账号/作品/直播）…')
      const r = await douyinInsight.refreshAll()
      const bad = Object.entries(r.parts).filter(([, x]) => !x.ok).map(([k, x]) => `${k}:${x.error || '失败'}`)
      log(bad.length
        ? `抖音预热部分失败（${bad.join(' / ')}）—— 控制台会显示上次缓存`
        : `抖音数据已落盘，用时 ${r.ms}ms`)
    } catch (e) {
      log('抖音预热跳过：' + String(e.message || e).slice(0, 160))
    }
  }, 1200)

  /* 启动脚本双击时要顺手把浏览器打开 —— 必须等 listen 之后，
   * 否则浏览器比服务先到，看到的是"无法连接"，主人以为没起来。 */
  if (process.argv.includes('--open')) openBrowser(`http://127.0.0.1:${PORT}/`)
})

/* 端口被占的时候 node 只会打一行 EADDRINUSE，很容易看漏 —— 说明白点 */
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    const holder = pidOnPort(PORT)
    log(`端口 ${PORT} 上已经有一个控制台在跑了${holder ? `（pid ${holder}）` : ''}`)
    /* 双击两次启动脚本是最常见的情况，别用报错吓人：
     * 直接把浏览器指到已经跑着的那个控制台，然后安静退出。 */
    if (process.argv.includes('--open')) {
      openBrowser(`http://127.0.0.1:${PORT}/`)
      log('已经帮你打开那一个了，这个窗口可以关掉')
      process.exit(0)
    }
    console.error(`换端口：set AUTO_PORT=18091 && node server.mjs\n`)
    process.exit(1)
  }
  log('控制台起不来：' + String(e && e.stack || e))
  process.exit(1)
})

/* 没接住的异常也要留痕 —— 不然服务静默退出，第二天只能看一个空端口 */
process.on('unhandledRejection', (e) => {
  log('unhandledRejection', JSON.stringify(String(e && e.stack || e).slice(0, 500)))
})
process.on('uncaughtException', (e) => {
  log('uncaughtException', JSON.stringify(String(e && e.stack || e).slice(0, 500)))
})
