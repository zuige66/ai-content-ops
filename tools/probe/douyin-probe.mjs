/* tools/probe/douyin-probe.mjs —— 只读探测：抖音账号能拿到哪些数据
 * ═══════════════════════════════════════════════════════════════
 * 不猜接口。做法是开着登录态逛一遍创作者后台的页面，把页面自己发的
 * XHR/fetch 全抓下来（URL / 状态码 / 顶层字段），顺带抽 DOM 里的头像、
 * 昵称、简介、背景图，最后落 state/probe-douyin.json + 每页截图。
 *
 * 🔴 全程只 GET 页面和接口，不点任何按钮、不发任何写请求。
 * 用法：node tools/probe/douyin-probe.mjs [--headed]
 */
import fs from 'node:fs'
import path from 'node:path'
import { launchPersistent } from '../../core/browser.mjs'
import { ROOT, logEvent } from '../../core/log.mjs'

const HEADED = process.argv.includes('--headed')

const PAGES = [
  ['home', 'https://creator.douyin.com/creator-micro/home', 6000],
  ['works', 'https://creator.douyin.com/creator-micro/content/manage', 6000],
  ['comments', 'https://creator.douyin.com/creator-micro/interactive/comment', 6000],
  ['data', 'https://creator.douyin.com/creator-micro/data-center/content', 6000],
  ['setting', 'https://creator.douyin.com/creator-micro/setting/account', 5000],
  ['selfpage', 'https://www.douyin.com/user/self', 6000],
]

const hits = []
let phase = 'boot'

function clip(s, n = 1200) {
  s = String(s || '').replace(/\s+/g, ' ')
  return s.length > n ? s.slice(0, n) + '…' : s
}

function keysOf(obj, depth = 0) {
  if (!obj || typeof obj !== 'object') return typeof obj
  if (Array.isArray(obj)) return `[${obj.length}] ` + (obj[0] ? keysOf(obj[0], depth + 1) : '')
  if (depth > 1) return '{…}'
  return '{' + Object.keys(obj).slice(0, 14).join(',') + (Object.keys(obj).length > 14 ? ',…' : '') + '}'
}

const { ctx } = await launchPersistent('douyin', { headless: !HEADED })

/* 抓所有 JSON 响应（页面自己发的，带签名，不用我们造） */
ctx.on('response', async (res) => {
  try {
    const req = res.request()
    const rt = req.resourceType()
    if (rt !== 'xhr' && rt !== 'fetch') return
    const url = res.url()
    if (!/douyin|bytedance|snssdk|amemv/i.test(url)) return
    const ct = res.headers()['content-type'] || ''
    if (!/json|text\/plain/i.test(ct)) return
    const item = { phase, status: res.status(), method: req.method(), url: url.slice(0, 400) }
    // 只对可能带数据的接口读 body，避免把整页埋点都读进来
    if (/list|post|comment|user|profile|statistic|data|live|aweme|item|account|info|work|fans|overview/i.test(url)) {
      try {
        const txt = await res.text()
        if (txt && txt.length < 800000) {
          item.len = txt.length
          let j = null
          try { j = JSON.parse(txt) } catch { /* 不是纯 JSON */ }
          item.shape = j ? keysOf(j) : 'non-json'
          item.sample = clip(txt, 900)
        }
      } catch { item.bodyErr = 1 }
    }
    hits.push(item)
  } catch { /* 响应体拿不到就算了，不影响主流程 */ }
})

const dom = {}
const shots = []

for (const [name, url, waitMs] of PAGES) {
  phase = name
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(waitMs)
    const info = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')]
        .map(i => ({ src: (i.currentSrc || i.src || '').slice(0, 240), w: i.naturalWidth, h: i.naturalHeight, cls: (i.className || '').slice(0, 40) }))
        .filter(i => i.src.startsWith('http') || i.src.startsWith('data:'))
        .slice(0, 40)
      return {
        url: location.href,
        title: document.title,
        text: (document.body ? document.body.innerText : '').slice(0, 2500),
        imgs,
      }
    })
    dom[name] = info
    const p = path.join(ROOT, 'state', `probe-${name}.png`)
    await page.screenshot({ path: p, fullPage: false }).catch(() => { })
    shots.push(p)
    console.log(`[${name}] ${info.url}  |  ${clip(info.text, 120)}`)
  } catch (e) {
    dom[name] = { error: String(e && e.message || e).slice(0, 200) }
    console.log(`[${name}] 失败：${dom[name].error}`)
  } finally {
    await page.close().catch(() => { })
  }
}

/* 页面内直连两个最关键的接口，验证「能不能主动取」而不只是「页面自己会取」 */
phase = 'direct'
const direct = {}
const page = await ctx.newPage()
try {
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(2000)
  direct.self = await page.evaluate(async () => {
    try {
      const r = await fetch('https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', { credentials: 'include' })
      const j = await r.json()
      return { status: r.status, uid: j?.user?.uid, nickname: j?.user?.nickname, keys: Object.keys(j || {}) }
    } catch (e) { return { error: String(e).slice(0, 160) } }
  })
  // 作品列表：web 端要 a_bogus 签名，页面内直接取一般会 403/空 —— 这里就是要测出真相
  direct.postList = await page.evaluate(async () => {
    try {
      const me = await (await fetch('https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', { credentials: 'include' })).json()
      const sec = me?.user?.sec_uid
      if (!sec) return { error: '拿不到 sec_uid' }
      const u = `https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383&sec_user_id=${sec}&max_cursor=0&count=18`
      const r = await fetch(u, { credentials: 'include' })
      const txt = await r.text()
      let j = null; try { j = JSON.parse(txt) } catch { }
      return { status: r.status, len: txt.length, shape: j ? keysOf(j) : 'non-json', sample: txt.replace(/\s+/g, ' ').slice(0, 400) }
    } catch (e) { return { error: String(e).slice(0, 160) } }
  })
} catch (e) {
  direct.error = String(e && e.message || e).slice(0, 200)
} finally {
  await page.close().catch(() => { })
}

const report = {
  at: new Date().toISOString(),
  headless: !HEADED,
  direct,
  dom,
  apis: hits,
  shots,
}
const out = path.join(ROOT, 'state', 'probe-douyin.json')
fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
console.log(`\n接口命中 ${hits.length} 条 → ${path.relative(ROOT, out)}`)
console.log('直连：', JSON.stringify(direct).slice(0, 400))
logEvent('douyin', 'probe.readonly', { ok: true, apis: hits.length, out })
await ctx.close()
