/* tools/github-assets.mjs —— 把仓库 README 里的图抓下来
 * ═══════════════════════════════════════════════════════════════
 * 为什么要这个脚本：每期都要给分镜配图，手点右键存图既慢又容易存错分辨率。
 * 而且这台机器上 `curl` 到 raw.githubusercontent.com 直接 SSL 失败（error 35），
 * 只有浏览器能出去 —— 所以走 Playwright 的 request 上下文下载，绕开 curl。
 *
 * 用法：
 *   node tools/probe/github-assets.mjs ccch1mneyyy/dsh-Go --slug dsh-go
 *   node tools/probe/github-assets.mjs owner/name --slug name --all   # 连小图也抓
 *
 * 产物：video/assets/<slug>/*.webp（原样，不转格式 —— Chrome 直接能显示 webp）
 * 同时写一份 index.json，记下每张图的原始 URL 和尺寸，策划里引用时对得上。
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../../core/log.mjs'

const args = process.argv.slice(2)
const repo = args.find(a => !a.startsWith('--') && a.includes('/'))
const get = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }
if (!repo) {
  console.error('用法：node tools/probe/github-assets.mjs owner/name --slug xxx')
  process.exit(1)
}
const slug = get('slug') || repo.split('/')[1]
const all = args.includes('--all')
const dir = path.join(ROOT, 'video', 'assets', slug)
fs.mkdirSync(dir, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
const page = await ctx.newPage()

/* GitHub 偶尔 reset 连接，重试两次；两次都不行就是网络问题，别死磕 */
let ok = false
for (let i = 1; i <= 3 && !ok; i++) {
  try {
    await page.goto(`https://github.com/${repo}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForTimeout(3500)
    ok = true
  } catch (e) {
    console.log(`第 ${i} 次打开失败：${String(e.message).slice(0, 80)}`)
  }
}
if (!ok) { await browser.close(); process.exit(1) }

/* README 的容器：新版是 <article>，老版是 .markdown-body。两个都试 */
const imgs = await page.evaluate((minW) => {
  const scope = document.querySelector('article') || document.querySelector('.markdown-body')
  if (!scope) return []
  return Array.from(scope.querySelectorAll('img'))
    .map(i => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight, alt: (i.alt || '').slice(0, 60) }))
    .filter(i => i.src && i.w >= minW)
}, all ? 100 : 600)

console.log(`找到 ${imgs.length} 张图`)

const index = []
let n = 0
for (const im of imgs) {
  /* 只认仓库自己的 docs/assets；头像、徽章、外链一律跳过 */
  if (!/githubusercontent|github\.com/.test(im.src)) continue
  if (/shields\.io|badge|avatar|emoji/i.test(im.src)) continue
  const ext = (im.src.match(/\.(webp|png|jpe?g|gif)(\?|$)/i) || [, 'png'])[1].toLowerCase()
  const base = (im.src.split('/').pop() || '').split('?')[0].replace(/\.[^.]+$/, '')
  const name = `${String(++n).padStart(2, '0')}-${(base || 'img').slice(0, 40)}.${ext}`
  try {
    const res = await ctx.request.get(im.src, { timeout: 30000 })
    if (!res.ok()) { console.log(`跳过 ${name}（HTTP ${res.status()}）`); continue }
    fs.writeFileSync(path.join(dir, name), await res.body())
    index.push({ file: name, w: im.w, h: im.h, alt: im.alt, src: im.src })
    console.log(`${name}  ${im.w}×${im.h}  ${im.alt}`)
  } catch (e) {
    console.log(`下载失败 ${name}：${String(e.message).slice(0, 60)}`)
  }
}

fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ repo, fetchedAt: new Date().toISOString(), images: index }, null, 2), 'utf8')
await browser.close()
console.log(`\n${index.length} 张 → ${dir}`)
console.log('挑图规矩：分镜优先用「能看出是界面」的那几张，纯 logo 和动图封面不要')
