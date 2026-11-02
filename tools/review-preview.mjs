/* tools/review-preview.mjs —— review 模板的静态预览
 * ═══════════════════════════════════════════════════════════════
 * 录一条 30 秒的片子要跑 TTS + 录屏 + 合成，两分钟起步；
 * 而「版式对不对」「转场顺不顺」这件事，看几张关键帧就够了。
 *
 * 用法：
 *   node tools/review-preview.mjs                     # 用最新的脚本 JSON
 *   node tools/review-preview.mjs --script video/scripts/_script_dsh-go.json
 *   node tools/review-preview.mjs --intro             # 只截封面 + 转场三帧
 *
 * 产物：video/out/preview/<slug>/f*.png
 *   i0 = 封面站住（0.05s）
 *   i1 = 转场中段（0.62s）
 *   i2 = 落地瞬间（1.15s）
 *   f1..fN = 每镜中间一帧
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../core/log.mjs'
import { readConfig } from '../core/shell.mjs'

const args = process.argv.slice(2)
const get = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }
const flag = (k) => args.includes('--' + k)

const OUT = path.join(ROOT, 'video', 'out', 'preview')
const TPL = path.join(ROOT, 'video', 'templates', 'review', 'index.html')  // 横屏 1920×1080
const ROOT_URL = 'file:///' + ROOT.replace(/\\/g, '/') + '/'

/* 脚本 JSON 里的图片是相对仓库根的（video/assets/...），
 * 而模板页是 file:// 打开的 —— 直接喂相对路径会解析到
 * templates/review/video/assets/ 下面，截出来是一片空。
 * 这里统一转成绝对 file://。 */
const abs = (p) => {
  if (!p) return ''
  const s = String(p)
  if (/^(file:|https?:|data:)/.test(s)) return s
  /* config 里的大肥鱼是 Windows 绝对路径（D:/Workplace/zhibo/assets/...），
     不认出来就会被拼成 repo 根下的相对路径，图直接 404 ——
     画面上只是"少了一只鱼"，不报错，很容易漏过去。 */
  if (/^[A-Za-z]:[\\/]/.test(s)) return 'file:///' + s.replace(/\\/g, '/')
  return ROOT_URL + s.replace(/^[.\\/]+/, '').replace(/\\/g, '/')
}

const SAMPLE = {
  slug: 'dsh-go',
  episode: 1,
  series: 'GITHUB 项目推荐',
  repo: 'github.com/ccch1mneyyy/dsh-Go',
  dur: 30,
  starts: [0, 4, 10, 18, 25],
  shots: [
    { img: 'video/assets/dsh-go/repo.png', pos: '50% 0%', kicker: 'STAR', big: '4.4k', small: '一周',
      key: '', text: '安卓手机能跑 Ubuntu，一周四千四百星。' },
    { img: 'video/assets/dsh-go/repo.png', pos: '50% 6%', key: 'dsh-Go · Dart · AGPL',
      text: '以前想在手机上调代码，得装 Termux，还得 root。' },
    { img: 'video/assets/dsh-go/repo.png', pos: '0% 42%', key: '免 root · 内置 Ubuntu',
      text: '它把 Ubuntu 和 Node 直接塞进手机，不用 root，装上就能跑。' },
    { img: 'video/assets/dsh-go/repo.png', pos: '100% 62%', key: 'SSH 接管同一段对话',
      text: '也能 SSH 连回电脑，接着同一段对话写。' },
    { win: { kind: 'url', lines: ['github.com/', 'ccch1mneyyy/dsh-Go'], note: 'AGPL-3.0 · 目前仅 Android',
             bg: 'video/assets/dsh-go/repo.png' }, key: '',
      text: 'GitHub 搜 dsh-Go，AGPL 开源。缺点：只有安卓。' },
  ],
}

/* 传 --script 就从脚本 JSON 里取，字段对不上就退回样例 */
function fromScript(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(s.shots) || !s.shots.length) return null
    return { ...SAMPLE, ...s }
  } catch { return null }
}

const DEFAULT_SCRIPT = path.join(ROOT, 'video', 'scripts', '_script_dsh-go.json')
const data = (get('script') && fromScript(get('script')))
  || fromScript(DEFAULT_SCRIPT)
  || SAMPLE

/* ── 路径绝对化 + 封面数据 ──────────────────────────────────────
 * 封面四要素在 make.mjs 里是从分镜和 config 拼出来的，这里照同样
 * 的口径拼一份，否则预览看不到 intro，等于没验。 */
const cfg = readConfig()
const pet = abs(cfg.video?.petFaces?.happy || cfg.video?.petImage || '')
data.shots = data.shots.map(s => ({
  ...s,
  img: abs(s.img),
  win: s.win ? { ...s.win, bg: abs(s.win.bg) } : s.win,
  duo: s.duo ? { ...s.duo, a: abs(s.duo.a), b: abs(s.duo.b) } : s.duo,
  core: s.core ? { ...s.core, img: abs(s.core.img || s.img) } : s.core,
  fin: s.fin ? { ...s.fin, thumbs: (s.fin.thumbs || []).map(abs) } : s.fin,
}))
data.pet = pet
{
  const [big, sub] = String(data.coverText || '').split('|')
  const seen = new Set()
  const wall = []
  for (const s of data.shots) {
    for (const u of [s.img, s.win && s.win.bg]) {
      if (!u || seen.has(u)) continue
      seen.add(u)
      wall.push(u)
    }
  }
  data.cover = String(big || '').trim()
    ? { big: big.trim(), sub: (sub || '').trim(), brand: 'GITHUB 项目推荐',
        shot: data.shots[0]?.img || '', wall: wall.slice(0, 6), pet }
    : null
}

const dir = path.join(OUT, data.slug || 'review')
fs.mkdirSync(dir, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.log('页面报错：' + e.message))

await page.goto('file:///' + TPL.replace(/\\/g, '/'))
await page.evaluate((d) => window.__REVIEW__(d), data)
await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 15000 })

/* 每镜中间取一帧：镜头刚开始的那 0.3 秒还在入场，截出来是半透明的。
   🔴 starts 长度必须和镜数一致。脚本 JSON 一般不带 starts（那是出片时
   由 TTS 实际时长算出来的），拿样例的 5 个去 map 6 个镜会少截一帧，
   而且 f5 会截到第 5 镜 —— 看图的人不会发现，只是"最后一镜没验"。 */
const starts = (Array.isArray(data.starts) && data.starts.length === data.shots.length)
  ? data.starts
  : data.shots.map((_, i) => i * (Number(data.dur) || 32) / data.shots.length)
const shotAt = starts.map((t, i) => {
  const next = starts[i + 1] ?? (Number(data.dur) || 32)
  /* 第一镜是报幕镜的话，前面还压着 0.85s 封面 hold + 0.7s 转场，
     它的字要到 2.3s 才全部到位 —— 按 2.0s 截会截到"只有两行字"的
     半成品，看着像版式缺了一块，其实是截早了。 */
  const floor = (data.shots[i] && data.shots[i].open) ? 2.6 : 2.0
  return Math.max(floor, t + Math.min(1.6, (next - t) * 0.45))
})
/* 转场三帧：封面站住 / 拆到一半 / 刚落地 */
const introAt = data.cover ? [0.06, 1.12, 1.72] : []
const at = flag('intro') ? introAt : [...introAt, ...shotAt]

let n = 0
for (const t of at) {
  /* 等到「正片开始后第 t 秒」。用页面自己的时钟（__READY_AT__ 是
     performance.now() 的读数），别在 node 侧 sleep —— 两边时钟不同步，
     慢一点就会截到下一镜。 */
  await page.waitForFunction(
    (target) => (performance.now() - (window.__READY_AT__ || 0)) >= target * 1000,
    t, { timeout: 40000, polling: 40 },
  )
  n++
  const name = introAt.includes(t) ? `i${introAt.indexOf(t)}` : `f${n - introAt.length}`
  await page.screenshot({ path: path.join(dir, name + '.png') })
}
await browser.close()

console.log(`预览 ${n} 帧 → ${dir}`)
console.log('看构图对不对：画框有没有吃满、数据卡有没有压到内容、字幕有没有超出两行')
console.log('看转场顺不顺：i0 四要素齐不齐、i1 有没有两层图打架、i2 落地有没有跳')
