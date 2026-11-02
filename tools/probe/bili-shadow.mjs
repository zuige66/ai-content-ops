/* 探 B站上传页的 micro-app / shadow DOM 结构 —— 上一轮发现常规选择器全是 0 */
import { launchPersistent } from '../../core/browser.mjs'
import * as session from '../../bili/session.mjs'

const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame'

const { ctx } = await launchPersistent('bili', { headless: true })
let page
try {
  const alive = await session.checkAlive(ctx)
  console.log('登录态:', JSON.stringify(alive))
  if (!alive.ok) process.exit(1)

  page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))

  await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(20000)

  const info = await page.evaluate(() => {
    const out = { microApps: [], shadowHosts: [], iframes: [], bodyText: '' }

    /* micro-app 自定义元素 */
    for (const el of document.querySelectorAll('micro-app, [name="video-up"], wujie-app')) {
      const sr = el.shadowRoot
      out.microApps.push({
        tag: el.tagName.toLowerCase(),
        name: el.getAttribute('name') || '',
        url: el.getAttribute('url') || '',
        hasShadow: Boolean(sr),
        shadowChildren: sr ? sr.children.length : 0,
        rect: (() => { const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}` })(),
      })
      if (sr) {
        /* 把 shadow 里所有带意义的标签统计一遍 */
        const tags = {}
        sr.querySelectorAll('*').forEach((n) => { tags[n.tagName.toLowerCase()] = (tags[n.tagName.toLowerCase()] || 0) + 1 })
        out.shadowHosts.push({ host: el.tagName.toLowerCase(), tags })
      }
    }

    /* 所有带 shadowRoot 的元素 */
    document.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot && !/^(MICRO-APP|WUJIE-APP)$/.test(el.tagName)) {
        out.shadowHosts.push({
          host: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
          tags: { count: el.shadowRoot.querySelectorAll('*').length },
        })
      }
    })

    out.iframes = [...document.querySelectorAll('iframe')].map((f) => ({
      src: String(f.src || '').slice(0, 100),
      cls: String(f.className || '').slice(0, 50),
    }))

    out.bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
    return out
  })

  console.log('\n=== micro-app 元素 ===')
  if (!info.microApps.length) console.log('  （无）')
  info.microApps.forEach((m) => console.log(`  <${m.tag}> name=${m.name} url=${m.url.slice(0, 70)} shadow=${m.hasShadow} 子元素=${m.shadowChildren} 尺寸=${m.rect}`))

  console.log('\n=== shadow host ===')
  if (!info.shadowHosts.length) console.log('  （无）')
  info.shadowHosts.slice(0, 8).forEach((s) => console.log(`  ${s.host}: ${JSON.stringify(s.tags).slice(0, 160)}`))

  console.log('\n=== iframe ===')
  if (!info.iframes.length) console.log('  （无）')
  info.iframes.forEach((f) => console.log(`  cls=${f.cls} src=${f.src}`))

  console.log('\n=== 可见文本 ===')
  console.log(' ', JSON.stringify(info.bodyText))

  console.log('\n=== pageerror ===')
  console.log(errs.length ? errs.slice(0, 6).join('\n  ') : '  无')

  /* 试着穿透 shadow 找控件 */
  const deep = await page.evaluate(() => {
    const found = { fileInputs: 0, titleInputs: 0, editables: 0, buttons: [] }
    const walk = (root, depth = 0) => {
      if (depth > 6 || !root) return
      try {
        found.fileInputs += root.querySelectorAll?.('input[type=file]').length || 0
        found.titleInputs += [...(root.querySelectorAll?.('input') || [])].filter((el) => /标题/.test(el.getAttribute('placeholder') || '')).length
        found.editables += root.querySelectorAll?.('[contenteditable="true"]').length || 0
        if (found.buttons.length < 25) {
          for (const b of root.querySelectorAll?.('button') || []) {
            const t = (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 20)
            if (t) found.buttons.push(t)
          }
        }
        for (const el of root.querySelectorAll?.('*') || []) {
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1)
        }
      } catch { /* 跨域等 */ }
    }
    walk(document)
    return found
  })
  console.log('\n=== 穿透 shadow 后 ===')
  console.log('  file input:', deep.fileInputs, '| 标题框:', deep.titleInputs, '| contenteditable:', deep.editables)
  console.log('  按钮:', deep.buttons.join(' / ').slice(0, 300))

  await page.screenshot({ path: '.run/trash/bili-deep.png', fullPage: true })
  console.log('\n截图: .run/trash/bili-deep.png')
} catch (e) {
  console.error('失败:', String(e && e.message || e).slice(0, 300))
} finally {
  if (page) await page.close().catch(() => { })
  await ctx.close().catch(() => { })
  process.exit(0)
}
