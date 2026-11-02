/* tools/probe/preview-shot.mjs —— 验证预览页能真渲染（一次性探测）
 * 用 Playwright 打开 /preview.html，等 iframe 里的模板画出来，截图。
 * 只为回答一个问题：这个页面到底出不出画面。
 */
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ROOT } from '../../core/log.mjs'

const OUT = path.join(ROOT, '.run', 'trash')
const url = process.argv[2] || 'http://127.0.0.1:18090/preview.html?type=talk&script=_script_day0.json'

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } })
const errs = []
page.on('pageerror', e => errs.push('PAGEERROR ' + String(e).slice(0, 200)))
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)) })

await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => errs.push('GOTO ' + e.message))
await page.waitForTimeout(6000)

/* 看 iframe 里有没有气泡/信息卡 */
const fr = page.frames().find(f => f.url().includes('/tpl/'))
let info = { bubbles: 0, cards: 0, day: '', title: '' }
if (fr) {
  info = await fr.evaluate(() => ({
    bubbles: document.querySelectorAll('#flow .bub').length,
    cards: document.querySelectorAll('#flow .infocard').length,
    day: (document.querySelector('#dayBadge') || {}).textContent || '',
    title: (document.querySelector('#journalTitle') || {}).textContent || '',
  })).catch(e => ({ err: String(e).slice(0, 120) }))
}

const shot = path.join(OUT, 'preview-check.png')
await page.screenshot({ path: shot })
console.log('iframe:', fr ? fr.url().slice(0, 80) : 'NONE')
console.log('inside:', JSON.stringify(info))
console.log('errors:', errs.length ? errs.join(' | ') : 'none')
console.log('shot:', shot)
await browser.close()
