/* bili/publish.mjs —— B站投稿（member.bilibili.com 上传页 RPA）
 * ═══════════════════════════════════════════════════════════════
 * 两段式：
 *   第一段（dry-run）：选文件 → 等上传 → 填标题/简介/标签 → 全页截图 → awaitConfirm
 *   第二段（confirmed=true）：把kept-alive 的页面找回来 → 点「发布」→ 等投稿成功提示
 * 写操作全程过熔断器（breaker.guardedWrite）。每一步截图，失败时人能看到卡在哪。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'
import { launchPersistent } from '../core/browser.mjs'
import { guardedWrite } from '../core/breaker.mjs'
import * as session from './session.mjs'

export const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame'

// dry-run 停在发布前，页面留着等人点头（服务重启就没了 —— 那就重新 dry-run 一次）
const kept = new Map()   // jobId -> {ctx, page}

async function shot(page, dir, name) {
  const p = path.join(dir, name)
  try { await page.screenshot({ path: p, fullPage: false }) } catch { return '' }
  return p
}

export async function publish(job, { step, awaitConfirm }) {
  const p = job.params
  const dir = path.join(ROOT, 'video', 'out', 'publish', job.id)
  fs.mkdirSync(dir, { recursive: true })
  const video = p.video

  if (!p.confirmed) {
    /* ── 第一段：dry-run ── */
    if (!video || !fs.existsSync(video)) throw new Error(`视频文件不存在：${video}`)
    return guardedWrite('bili', {
      checkAlive: async () => {
        const { ctx } = await launchPersistent('bili', { headless: true })
        return session.checkAlive(ctx)
      },
      write: async () => {
        step('打开 B站投稿页（无头）')
        const { ctx } = await launchPersistent('bili', { headless: true })
        const page = ctx.pages().find(x => x.url().includes('member.bilibili.com'))
          || await ctx.newPage()
        await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(2500)
        // 没登录会被踢去 passport —— 直接把话说清楚，别在错误页面上瞎填表
        if (!/member\.bilibili\.com/.test(page.url())) {
          await shot(page, dir, 'not-logged-in.png')
          throw new Error('B站投稿页跳去了登录页 —— 登录态失效，先扫码登录')
        }
        await shot(page, dir, '01-open.png')

        step('选视频文件，等上传完成')
        const fileInput = page.locator('input[type=file]').first()
        await fileInput.setInputFiles(video)
        // 上传完成的信号：标题输入框可用了 / 页面出现「重新上传」
        await page.waitForSelector('input[placeholder*="标题"], textarea[placeholder*="标题"]', { timeout: 600000 })
        // 等到进度走完（宽松：出现「重新上传」或「上传完成」字样，或 10 秒内百分比不再变化）
        await page.waitForTimeout(3000)
        await shot(page, dir, '02-uploaded.png')

        step('填标题 / 简介 / 标签')
        const title = String(p.title || '').slice(0, 80)
        const titleBox = page.locator('input[placeholder*="标题"], textarea[placeholder*="标题"]').first()
        await titleBox.fill(title)
        // 简介是富文本编辑器（quill 的 contenteditable）
        if (p.desc) {
          try {
            const editor = page.locator('.ql-editor, [contenteditable="true"]').first()
            await editor.click()
            await editor.fill(String(p.desc).slice(0, 2000))
          } catch { step('简介编辑器没找到（不阻塞）') }
        }
        // 标签：输入后回车逐个加
        for (const t of (Array.isArray(p.tags) ? p.tags : []).slice(0, 10)) {
          try {
            const tagBox = page.locator('input[placeholder*="标签"], input[placeholder*="按回车"]').first()
            await tagBox.fill(String(t).slice(0, 20))
            await tagBox.press('Enter')
            await page.waitForTimeout(300)
          } catch { step(`标签「${t}」没加上（不阻塞）`) }
        }
        await page.waitForTimeout(1000)
        const shotPath = await shot(page, dir, '03-dry-run.png')
        kept.set(job.id, { ctx, page })
        logEvent('bili', 'publish.dryrun', { ok: true, jobId: job.id, title })
        awaitConfirm({
          platform: 'bili', kind: 'publish', title,
          screenshots: [shotPath], dir,
          note: '表单已填好、停在发布前。B站上传可能仍在后台继续，确认前别关服务。',
        })
        return { dryRun: true }
      },
    })
  }

  /* ── 第二段：确认后点发布 ── */
  return guardedWrite('bili', {
    checkAlive: async () => {
      const k = kept.get(job.id)
      if (!k) return { ok: false, why: 'dry-run 的页面丢了（服务重启过）—— 重新发起一次投稿' }
      return session.checkAlive(k.ctx)
    },
    write: async () => {
      const k = kept.get(job.id)
      const { page } = k
      step('已确认，点「发布」')
      await shot(page, dir, '04-before-publish.png')
      // 发布按钮：文本就是「发布」；定时发布在旁边，别点错
      const btn = page.locator('button:has-text("发布")').first()
      await btn.click()
      await page.waitForTimeout(6000)
      const shotPath = await shot(page, dir, '05-published.png')
      kept.delete(job.id)
      const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1500) : '')
      const ok = /投稿成功|审核|成功提交/.test(body)
      logEvent('bili', 'publish.done', { ok, jobId: job.id, title: job.params.title })
      if (!ok) throw new Error('点了发布但没看到成功提示 —— 看 05 截图确认，别重复点')
      return { published: true, screenshot: shotPath }
    },
  })
}
