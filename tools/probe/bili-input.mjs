/* 找出哪个 file input 才是上传入口 —— 上一轮 setInputFiles 到 .first() 没反应
 *
 * 思路：逐个 input 试，每次塞完等 15 秒看页面上有没有出现「上传中/百分比」。
 * 只读，不填表单、不点发布。
 */
import { launchPersistent } from '../../core/browser.mjs'
import * as session from '../../bili/session.mjs'

const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame'
const VIDEO = 'video/out/pick-1793551323277/video.mp4'

const { ctx } = await launchPersistent('bili', { headless: true })
let page
try {
  const alive = await session.checkAlive(ctx)
  if (!alive.ok) { console.log('未登录'); process.exit(1) }

  page = await ctx.newPage()
  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })

  const t0 = Date.now()
  while (Date.now() - t0 < 45000) {
    if (await page.locator('input[type=file]').count() > 0) break
    await page.waitForTimeout(1500)
  }

  /* 把所有 file input 的属性全打出来 */
  const infos = await page.evaluate(() => [...document.querySelectorAll('input[type=file]')].map((el, i) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    const chain = []
    let p = el.parentElement
    for (let k = 0; k < 4 && p; k++) { chain.push(p.tagName.toLowerCase() + (p.className ? '.' + String(p.className).split(' ')[0] : '')); p = p.parentElement }
    return {
      i,
      accept: el.getAttribute('accept') || '',
      multiple: el.multiple,
      id: el.id || '',
      name: el.getAttribute('name') || '',
      cls: String(el.className || ''),
      rect: `${Math.round(r.width)}x${Math.round(r.height)}`,
      display: s.display,
      visibility: s.visibility,
      opacity: s.opacity,
      parentChain: chain.join(' < '),
    }
  }))
  console.log('=== 所有 file input ===')
  infos.forEach((x) => console.log(`  [${x.i}] accept="${x.accept}" multiple=${x.multiple} id=${x.id} 尺寸=${x.rect} display=${x.display} opacity=${x.opacity}\n      父链: ${x.parentChain}`))

  /* 监听网络：选文件后应该会有上传请求 */
  const uploadReqs = []
  page.on('request', (r) => {
    const u = r.url()
    if (/upload|upos|bda2|videoup/i.test(u) && r.method() !== 'OPTIONS') {
      uploadReqs.push(`${r.method()} ${u.slice(0, 100)}`)
    }
  })

  /* 逐个试 */
  for (let i = 0; i < infos.length; i++) {
    console.log(`\n=== 试 input[${i}] ===`)
    const before = uploadReqs.length
    try {
      await page.locator('input[type=file]').nth(i).setInputFiles(VIDEO)
      console.log('  setInputFiles 成功')
    } catch (e) {
      console.log('  setInputFiles 失败:', String(e.message || e).slice(0, 100))
      continue
    }
    await page.waitForTimeout(15000)

    const txt = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')
    const uploading = /上传中|正在上传|解析中|转码中|\d{1,3}%|重新上传|上传完成/.test(txt)
    const hasTitle = /标题/.test(txt)
    console.log('  出现上传状态:', uploading, '| 出现标题框:', hasTitle, '| 新增上传请求:', uploadReqs.length - before)

    if (uploading || hasTitle) {
      console.log('\n  ✅ 这个是上传入口')
      await page.screenshot({ path: '.run/trash/bili-upload-found.png', fullPage: true })
      /* 继续等表单，最多 3 分钟 */
      const t1 = Date.now()
      while (Date.now() - t1 < 180000) {
        const t = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')
        const busy = /上传中|正在上传|解析中|转码中|\d{1,3}%/.test(t)
        if (!busy && /标题/.test(t)) break
        await page.waitForTimeout(3000)
      }
      console.log('  表单等待结束')

      /* dump 表单 */
      const dump = await page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
        const a = (el) => ({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', ph: el.getAttribute('placeholder') || '', cls: String(el.className || '').slice(0, 70), text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 45), visible: vis(el) })
        return {
          inputs: [...document.querySelectorAll('input')].filter((e) => e.type !== 'file').slice(0, 25).map(a),
          textareas: [...document.querySelectorAll('textarea')].slice(0, 8).map(a),
          editables: [...document.querySelectorAll('[contenteditable="true"]')].slice(0, 8).map(a),
          buttons: [...document.querySelectorAll('button')].slice(0, 40).map((el) => ({ text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 22), disabled: el.disabled, visible: vis(el) })),
          category: [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && /分区|请选择/.test(el.textContent || '')).slice(0, 12).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 55), text: (el.textContent || '').trim().slice(0, 40) })),
          ai: [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && /AI生成|人工智能生成|创作声明|内容声明|自制/.test(el.textContent || '')).slice(0, 12).map((el) => ({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 55), text: (el.textContent || '').trim().slice(0, 45) })),
        }
      })
      const show = (n, rows, f) => { console.log(`\n--- ${n}（${rows.length}）---`); rows.length ? rows.forEach((r) => console.log('   ' + f(r))) : console.log('   （无）') }
      show('input', dump.inputs, (r) => `[${r.type}] ph="${r.ph}" vis=${r.visible} cls=${r.cls.slice(0, 50)}`)
      show('textarea', dump.textareas, (r) => `ph="${r.ph}" vis=${r.visible} cls=${r.cls.slice(0, 50)}`)
      show('contenteditable', dump.editables, (r) => `vis=${r.visible} cls=${r.cls.slice(0, 55)}`)
      show('button', dump.buttons, (r) => `"${r.text}" disabled=${r.disabled} vis=${r.visible}`)
      show('分区', dump.category, (r) => `cls=${r.cls.slice(0, 40)} | "${r.text}"`)
      show('AI/声明', dump.ai, (r) => `<${r.tag}> cls=${r.cls.slice(0, 38)} | "${r.text}"`)

      await page.screenshot({ path: '.run/trash/bili-form-ready.png', fullPage: true })
      console.log('\n截图: .run/trash/bili-form-ready.png')
      break
    }
  }
} catch (e) {
  console.error('失败:', String(e && e.message || e).slice(0, 300))
} finally {
  if (page) await page.close().catch(() => { })
  await ctx.close().catch(() => { })
  process.exit(0)
}
