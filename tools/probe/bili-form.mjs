/* 实测 B站上传全流程的表单结构 —— 真的选文件、等上传、然后 dump 表单
 *
 * 🔴 这是只读探测：只填到「能看见表单」为止，**不点发布、不填最终内容**。
 *    目的是把 bili/publish.mjs 里那批从没验过的选择器对准真实页面。
 */
import { launchPersistent } from '../../core/browser.mjs'
import * as session from '../../bili/session.mjs'

const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame'
const VIDEO = 'video/out/pick-1793551323277/video.mp4'

const { ctx } = await launchPersistent('bili', { headless: true })
let page
try {
  const alive = await session.checkAlive(ctx)
  console.log('登录态:', alive.ok, alive.name || '')
  if (!alive.ok) process.exit(1)

  page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))

  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })

  /* 等上传区出现 */
  const t0 = Date.now()
  while (Date.now() - t0 < 45000) {
    const n = await page.locator('input[type=file]').count().catch(() => 0)
    if (n > 0) break
    await page.waitForTimeout(1500)
  }
  const nFiles = await page.locator('input[type=file]').count()
  console.log('file input 数量:', nFiles)

  console.log('\n=== 选文件 ===')
  await page.locator('input[type=file]').first().setInputFiles(VIDEO)
  console.log('已塞入', VIDEO)

  /* 等表单出现：找「标题」相关输入框，最多 5 分钟 */
  console.log('\n=== 等表单（标题框出现）===')
  const t1 = Date.now()
  let formReady = false
  let lastText = ''
  while (Date.now() - t1 < 300000) {
    const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')
    lastText = txt
    const hasTitle = /标题/.test(txt)
    const uploading = /上传中|正在上传|解析中|转码中|\d{1,3}%/.test(txt)
    if (hasTitle && !uploading) { formReady = true; break }
    await page.waitForTimeout(2000)
  }
  console.log('表单就绪:', formReady, `（等了 ${Math.round((Date.now() - t1) / 1000)} 秒）`)

  const dump = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const attrs = (el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      ph: el.getAttribute('placeholder') || '',
      cls: String(el.className || '').slice(0, 80),
      text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 50),
      visible: vis(el),
    })
    return {
      inputs: [...document.querySelectorAll('input')].slice(0, 30).map(attrs),
      textareas: [...document.querySelectorAll('textarea')].slice(0, 10).map(attrs),
      editables: [...document.querySelectorAll('[contenteditable="true"]')].slice(0, 10).map(attrs),
      buttons: [...document.querySelectorAll('button')].slice(0, 40).map((el) => ({
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        cls: String(el.className || '').slice(0, 50),
        disabled: el.disabled,
        visible: vis(el),
      })),
      /* 分区：找含「分区」或 select 类的东西 */
      category: [...document.querySelectorAll('*')]
        .filter((el) => el.children.length === 0 && /分区|请选择/.test(el.textContent || ''))
        .slice(0, 12)
        .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), text: (el.textContent || '').trim().slice(0, 40) })),
      /* AI 声明：找含「AI」或「声明」的叶子节点 */
      ai: [...document.querySelectorAll('*')]
        .filter((el) => el.children.length === 0 && /AI|人工智能|创作声明|自制/.test(el.textContent || ''))
        .slice(0, 15)
        .map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 60), text: (el.textContent || '').trim().slice(0, 45) })),
      bodyLen: (document.body.innerText || '').length,
    }
  })

  const show = (name, rows, fmt) => {
    console.log(`\n=== ${name}（${rows.length}）===`)
    if (!rows.length) { console.log('  （无）'); return }
    rows.forEach((r) => console.log('  ' + fmt(r)))
  }
  show('input', dump.inputs, (r) => `[${r.type}] ph="${r.ph}" visible=${r.visible} cls=${r.cls.slice(0, 55)}`)
  show('textarea', dump.textareas, (r) => `ph="${r.ph}" visible=${r.visible} cls=${r.cls.slice(0, 55)}`)
  show('contenteditable', dump.editables, (r) => `visible=${r.visible} cls=${r.cls.slice(0, 60)}`)
  show('button', dump.buttons, (r) => `"${r.text}" disabled=${r.disabled} visible=${r.visible}`)
  show('分区线索', dump.category, (r) => `cls=${r.cls.slice(0, 45)} | "${r.text}"`)
  show('AI/声明线索', dump.ai, (r) => `<${r.tag}> cls=${r.cls.slice(0, 40)} | "${r.text}"`)

  console.log('\n=== pageerror ===')
  console.log(errs.length ? errs.slice(0, 5).join('\n  ') : '  无')

  await page.screenshot({ path: '.run/trash/bili-form.png', fullPage: true })
  console.log('\n截图: .run/trash/bili-form.png')
} catch (e) {
  console.error('失败:', String(e && e.message || e).slice(0, 300))
  if (page) await page.screenshot({ path: '.run/trash/bili-form-error.png' }).catch(() => { })
} finally {
  if (page) await page.close().catch(() => { })
  await ctx.close().catch(() => { })
  process.exit(0)
}
