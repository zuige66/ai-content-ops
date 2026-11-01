/* douyin/publish.mjs —— 抖音投稿（creator.douyin.com 创作者平台上传 RPA）
 * 与 bili/publish.mjs 同构的两段式。抖音风控更严：
 *   · 全程真实 UI 操作、串行、慢速（每步之间留时间）
 *   · 写操作过熔断器；失败立即停手，绝不重试轰炸
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'
import { launchPersistent } from '../core/browser.mjs'
import { guardedWrite } from '../core/breaker.mjs'
import * as session from './session.mjs'

export const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'

const kept = new Map()

async function shot(page, dir, name) {
  const p = path.join(dir, name)
  try { await page.screenshot({ path: p, fullPage: false }) } catch { return '' }
  return p
}

/**
 * 等视频真的传完。
 *
 * 🔴 这里连踩两个坑，都记下来别重犯：
 *
 *   坑 1：原来等 `button:has-text("发布")`。左侧导航第一项叫「作品发布」，
 *         selector 立刻命中 —— 视频 0% 就往下填表截图，人看着表单填好了，
 *         其实片子还在传。
 *
 *   坑 2：改成看「上传过程中/剩余时间」文案后还是提前返回。原因是
 *         setInputFiles() 一返回就去读 DOM，此时页面还没渲染出上传状态，
 *         第一次判断就是"不忙" → 直接当完成。所以必须先等状态**出现**，
 *         再等它**消失**。
 *
 *   顺带实测：上传过程中「发布」按钮就已经是可点的（disabled=false），
 *   所以按钮状态也不能当信号，别想着用它偷懒。
 */
const UPLOADING_RE = /上传过程中|剩余时间|文件解析中/

async function waitUploadDone(page, timeoutMs = 900000) {
  const bodyText = () => page.evaluate(() => (document.body ? document.body.innerText : ''))
  const t0 = Date.now()

  /* ① 先等上传状态出现。等不到（秒传完 / 页面没给状态）就放行 */
  let started = false
  while (Date.now() - t0 < 30000) {
    if (UPLOADING_RE.test(await bodyText())) { started = true; break }
    await page.waitForTimeout(1000)
  }
  if (!started) return { started: false }

  /* ② 再等它消失 */
  let lastPct = ''
  while (Date.now() - t0 < timeoutMs) {
    const txt = await bodyText()
    if (!UPLOADING_RE.test(txt)) return { started: true, ms: Date.now() - t0 }
    lastPct = (txt.match(/\d{1,3}%/) || [lastPct])[0]
    await page.waitForTimeout(2000)
  }
  throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没传完（最后进度 ${lastPct || '未知'}）—— 别点发布`)
}

export async function publish(job, { step, awaitConfirm }) {
  const p = job.params
  const dir = path.join(ROOT, 'video', 'out', 'publish', job.id)
  fs.mkdirSync(dir, { recursive: true })
  const video = p.video

  if (!p.confirmed) {
    if (!video || !fs.existsSync(video)) throw new Error(`视频文件不存在：${video}`)
    return guardedWrite('douyin', {
      checkAlive: async () => {
        const { ctx } = await launchPersistent('douyin', { headless: true })
        return session.checkAlive(ctx)
      },
      write: async () => {
        step('打开抖音创作者上传页（无头）')
        const { ctx } = await launchPersistent('douyin', { headless: true })
        const page = ctx.pages().find(x => x.url().includes('creator.douyin.com'))
          || await ctx.newPage()
        await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(3000)
        if (!/creator\.douyin\.com/.test(page.url()) || /登录/.test(await page.title())) {
          await shot(page, dir, 'not-logged-in.png')
          throw new Error('抖音创作者页跳去了登录 —— 登录态失效，先扫码登录')
        }
        await shot(page, dir, '01-open.png')

        step('选视频文件，等上传完成')
        const fileInput = page.locator('input[type=file]').first()
        await fileInput.setInputFiles(video)
        /* 28MB 大概 20-60 秒；大文件更久。等真传完再动表单 */
        const up = await waitUploadDone(page)
        step(up.started ? `上传完成（${Math.round((up.ms || 0) / 1000)} 秒）` : '没看到上传进度条（可能秒传），继续')
        await page.waitForTimeout(2000)

        /* 首次进上传页会弹「视频预览功能」引导，正好盖住表单中间。
         * 点掉它；点不到也无所谓，别让它阻塞流程。 */
        await page.getByRole('button', { name: '我知道了' }).click({ timeout: 3000 }).catch(() => { })
        await page.waitForTimeout(500)
        await shot(page, dir, '02-uploaded.png')

        step('填标题 / 简介 / 标签')
        // 抖音：声明文案（正文）是一个 contenteditable；封面标题在高级设置里，v1 只填正文+话题
        const body = String(p.desc || p.title || '').slice(0, 1000)
        try {
          const editor = page.locator('[contenteditable="true"]').first()
          await editor.click()
          await editor.type(body, { delay: 30 })   // 慢速输入，模拟真人
        } catch { step('正文编辑器没找到（不阻塞）') }
        for (const t of (Array.isArray(p.tags) ? p.tags : []).slice(0, 5)) {
          const tag = String(t).slice(0, 20)
          /* 正文里已经带了 #这个话题就别再加一遍，否则发出去是 "#测试 #测试" */
          if (body.includes('#' + tag)) continue
          try {
            const editor = page.locator('[contenteditable="true"]').first()
            await editor.type(` #${tag}`, { delay: 20 })
          } catch { /* 不阻塞 */ }
        }
        /* 输入 # 会弹出话题联想，正好压在「设置封面」上。
         * Esc 不管用（焦点还在 contenteditable 里），得让它失焦才会收起；
         * 再点一下「基础信息」标题确保联想层收掉。 */
        await page.evaluate(() => { if (document.activeElement) document.activeElement.blur() })
        await page.getByText('基础信息', { exact: true }).click({ timeout: 3000 }).catch(() => { })
        await page.waitForTimeout(1200)

        /* 预检「发布」按钮：dry-run 阶段就把定位验掉，别等人点了确认才发现
         * 找不到按钮 / 匹配到一堆。只数不点，一个字节都不发。 */
        try {
          const n = await page.getByRole('button', { name: '发布', exact: true }).count()
          step(n === 1 ? '发布按钮定位正常（确认后即可点）' : `⚠ 发布按钮匹配到 ${n} 个（期望 1）—— 确认前先看一眼截图`)
        } catch (e) {
          step('⚠ 发布按钮没找到：' + String(e.message || e).slice(0, 80))
        }

        const shotPath = await shot(page, dir, '03-dry-run.png')
        kept.set(job.id, { ctx, page })
        logEvent('douyin', 'publish.dryrun', { ok: true, jobId: job.id, title: p.title })
        awaitConfirm({
          platform: 'douyin', kind: 'publish', title: p.title,
          screenshots: [shotPath], dir,
          note: '视频已传完、表单已填好，停在「发布」按钮前。确认前别关服务（那个页面还开着）。',
        })
        return { dryRun: true }
      },
    })
  }

  return guardedWrite('douyin', {
    checkAlive: async () => {
      const k = kept.get(job.id)
      if (!k) return { ok: false, why: 'dry-run 的页面丢了（服务重启过）—— 重新发起一次投稿' }
      return session.checkAlive(k.ctx)
    },
    write: async () => {
      const k = kept.get(job.id)
      const { page } = k
      step('已确认，检查状态后点「发布」')
      /* 从 dry-run 到人点确认之间可能隔了几分钟，再确认一次片子还在、没被关掉 */
      await waitUploadDone(page, 180000)
      await shot(page, dir, '04-before-publish.png')
      /* 🔴 必须 exact —— 左侧导航第一项是「作品发布」，非精确匹配会先命中它，
       *    点了就跳到作品列表页，人还以为发出去了。
       *    另外别用 isDisabled 判断：实测上传中这个按钮也是可点的。 */
      const btn = page.getByRole('button', { name: '发布', exact: true }).first()
      await btn.waitFor({ state: 'visible', timeout: 30000 })
      await btn.click()
      await page.waitForTimeout(8000)
      const shotPath = await shot(page, dir, '05-published.png')
      kept.delete(job.id)
      const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1500) : '')
      const ok = /发布成功|成功|审核/.test(body)
      logEvent('douyin', 'publish.done', { ok, jobId: job.id, title: job.params.title })
      if (!ok) throw new Error('点了发布但没看到成功提示 —— 看 05 截图确认，别重复点')
      return { published: true, screenshot: shotPath }
    },
  })
}
