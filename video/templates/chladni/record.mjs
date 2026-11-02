/* 录一段模板页的预览片 —— 只为看效果，不走 TTS、不做封面。
 * 用法：node video/templates/chladni/record.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import ffmpegPath from 'ffmpeg-static'
import { run } from '../../../core/shell.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../../..')
const OUT = path.join(ROOT, 'video', 'out', 'chladni-demo')
fs.mkdirSync(OUT, { recursive: true })

const W = 1920, H = 1080

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: OUT, size: { width: W, height: H } },
})
const page = await ctx.newPage()
await page.goto('file://' + path.join(HERE, 'index.html'), { waitUntil: 'load' })
console.log('页面已加载，开始录制 13 秒…')
await page.waitForFunction(() => window.__DONE__ === true, { timeout: 60000 })
await page.waitForTimeout(400)
const video = page.video()
await ctx.close()
await browser.close()

const webm = await video.path()
const mp4 = path.join(OUT, 'preview.mp4')
const r = await run(ffmpegPath, ['-y', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-crf', '18', '-movflags', '+faststart', mp4], { timeoutMs: 180000 })
console.log(r.code === 0 ? 'MP4 已生成：' + mp4 : 'ffmpeg 失败：' + r.stderr.slice(-300))
