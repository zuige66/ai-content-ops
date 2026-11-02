/* tools/probe/bili-selectors.mjs —— 探 B站投稿页的真实结构，校准选择器
 *
 * 为什么要探：bili/publish.mjs 里那批选择器是照抖音那份推的，从没在
 * 真实页面上验过（logs/bili/ 至今只有一行「未登录」）。这里只读不写：
 * 打开上传页，把关键控件的存在性、placeholder、class 全部打出来。
 *
 * 用法：node tools/probe/bili-selectors.mjs
 */
import { launchPersistent } from '../../core/browser.mjs'
import * as session from '../../bili/session.mjs'

const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame'

const { ctx } = await launchPersistent('bili', { headless: true })
let page

try {
  console.log('=== 登录态 ==="')
  const alive = await session.checkAlive(ctx)
  console.log('  ', JSON.stringify(alive))
  if (!alive.ok) {
    console.log('  未登录，先扫码再跑这个脚本')
    process.exit(1)
  }

  page = await ctx.newPage()
  /* B站创作中心是重 SPA，首屏骨架屏能挂十几秒。
   * 把页面报错和失败请求都收下来 —— 只看到骨架屏时，得知道是"还在加载"
   * 还是"JS 挂了"，两种情况的处理完全不一样。 */
  const pageErrs = []
  const failedReqs = []
  page.on('pageerror', (e) => pageErrs.push(String(e).slice(0, 180)))
  page.on('requestfailed', (r) => {
    const u = r.url()
    if (/\.(js|css|json)/.test(u)) failedReqs.push(`${r.failure()?.errorText || '?'} ${u.slice(0, 110)}`)
  })

  console.log('\n=== 打开上传页 ===')
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  console.log('  url  :', page.url())

  /* 等真正的控件出现，最多 45 秒；等到任何一个 file input 或标题框就停 */
  const t0 = Date.now()
  let ready = false
  while (Date.now() - t0 < 45000) {
    const n = await page.evaluate(() => {
      const fi = document.querySelectorAll('input[type=file]').length
      const ti = [...document.querySelectorAll('input')].filter((el) => /标题/.test(el.getAttribute('placeholder') || '')).length
      const ce = document.querySelectorAll('[contenteditable="true"]').length
      return fi + ti + ce
    }).catch(() => 0)
    if (n > 0) { ready = true; break }
    await page.waitForTimeout(1500)
  }
  console.log('  控件出现:', ready, `（等了 ${Math.round((Date.now() - t0) / 1000)} 秒）`)
  console.log('  title:', (await page.title()).slice(0, 60))

  if (!ready) {
    console.log('\n=== 页面还没渲染出控件，诊断信息 ===')
    console.log('  pageerror:', pageErrs.length ? pageErrs.slice(0, 5) : '无')
    console.log('  失败请求:', failedReqs.length ? failedReqs.slice(0, 8) : '无')
    const html = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 400) : '(空)')).catch(() => '')
    console.log('  可见文本:', JSON.stringify(html))
    await page.screenshot({ path: '.run/trash/bili-not-ready.png' })
    console.log('\n截图: .run/trash/bili-not-ready.png')
    if (page) await page.close().catch(() => { })
    await ctx.close().catch(() => { })
    process.exit(2)
  }
  await page.waitForTimeout(2500)

  const dump = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const pick = (sel, limit = 12) =>
      [...document.querySelectorAll(sel)].slice(0, limit).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        ph: el.getAttribute('placeholder') || '',
        cls: String(el.className || '').slice(0, 70),
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        visible: vis(el),
      }))

    return {
      fileInputs: pick('input[type=file]', 5),
      inputs: pick('input[type=text], input:not([type])', 15),
      textareas: pick('textarea', 8),
      editables: pick('[contenteditable="true"]', 8),
      buttons: [...document.querySelectorAll('button')].slice(0, 30).map((el) => ({
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        cls: String(el.className || '').slice(0, 50),
        disabled: el.disabled,
        visible: vis(el),
      })),
      /* 分区相关的线索 */
      categoryHints: [...document.querySelectorAll('[class*="select"], [class*="category"], [class*="分区"]')]
        .slice(0, 10)
        .map((el) => ({
          cls: String(el.className || '').slice(0, 70),
          text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 50),
        })),
      /* AI 声明相关 */
      aiHints: [...document.querySelectorAll('*')]
        .filter((el) => el.children.length === 0 && /AI|人工智能|创作声明/.test(el.textContent || ''))
        .slice(0, 10)
        .map((el) => ({
          tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 60),
          text: (el.textContent || '').trim().slice(0, 50),
        })),
      bodyLen: (document.body.innerText || '').length,
    }
  })

  const section = (name, rows, fmt) => {
    console.log(`\n=== ${name}（${rows.length}）===`)
    if (!rows.length) { console.log('  （无）'); return }
    rows.forEach((r) => console.log('  ' + fmt(r)))
  }

  section('file input', dump.fileInputs, (r) => `${r.tag}[${r.type}] visible=${r.visible} cls=${r.cls}`)
  section('文本输入框', dump.inputs, (r) => `ph="${r.ph}" visible=${r.visible} cls=${r.cls.slice(0, 45)}`)
  section('textarea', dump.textareas, (r) => `ph="${r.ph}" visible=${r.visible} cls=${r.cls.slice(0, 45)}`)
  section('contenteditable', dump.editables, (r) => `visible=${r.visible} cls=${r.cls.slice(0, 55)}`)
  section('按钮', dump.buttons, (r) => `"${r.text}" disabled=${r.disabled} visible=${r.visible} cls=${r.cls.slice(0, 40)}`)
  section('分区线索', dump.categoryHints, (r) => `cls=${r.cls.slice(0, 50)} | "${r.text}"`)
  section('AI/声明线索', dump.aiHints, (r) => `<${r.tag}> cls=${r.cls.slice(0, 40)} | "${r.text}"`)

  await page.screenshot({ path: '.run/trash/bili-upload-page.png', fullPage: false })
  console.log('\n截图: .run/trash/bili-upload-page.png')
} catch (e) {
  console.error('\n探测失败:', String(e && e.message || e).slice(0, 300))
  if (page) await page.screenshot({ path: '.run/trash/bili-upload-error.png' }).catch(() => { })
} finally {
  if (page) await page.close().catch(() => { })
  await ctx.close().catch(() => { })
  process.exit(0)
}
