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
import { findAwaitingConfirm, onCancel } from '../core/jobs.mjs'
import * as session from './session.mjs'

export const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame'

// dry-run 停在发布前，页面留着等人点头（服务重启就没了 —— 那就重新 dry-run 一次）
const kept = new Map()   // jobId -> {page}

function closeKept(jobId) {
  const k = kept.get(jobId)
  if (!k) return
  kept.delete(jobId)
  Promise.resolve(k.page.close()).catch(() => { /* 页可能已经没了 */ })
}

/* 撤销时关掉活着的上传页 —— 和抖音那边同一个坑：persistent context 是全平台
 * 共用的，不关就会被下一条任务的 ctx.pages() 捡走。
 * 🔴 必须带上 platform：抖音那份也注册 kind='publish'，不带平台会互相覆盖。 */
onCancel('publish', 'bili', (job) => closeKept(job.id))

async function shot(page, dir, name) {
  const p = path.join(dir, name)
  try { await page.screenshot({ path: p, fullPage: false }) } catch { return '' }
  return p
}

/* ── 等上传真完成 ────────────────────────────────────────────────
 * 跟抖音那份同构（douyin/publish.mjs 的 waitUploadDone），坑也是同一个：
 *
 *   坑 1：拿「标题框出现」当信号 —— 那个框选文件前就在，一选完就往下走，
 *         视频还在传就把表单填了、把发布点了。
 *   坑 2：改成看进度文案后仍然提前返回 —— setInputFiles 一返回就读 DOM，
 *         此时页面还没渲染出上传状态，第一次判断就是"不忙"，直接当完成。
 *         所以必须先等状态**出现**，再等它**消失**。
 *
 * B站上传页的进度形态：百分比数字 / 「上传中」/ 「解析中」/ 「转码中」。
 * 秒传的话状态可能压根不出现 —— 那就放行（返回 started:false）。
 */
const UPLOADING_RE = /上传中|正在上传|解析中|转码中|\d{1,3}%/

async function waitUploadDone(page, timeoutMs = 900000) {
  const bodyText = () => page.evaluate(() => (document.body ? document.body.innerText : ''))
  const t0 = Date.now()

  /* ① 先等上传状态出现。等不到（秒传 / 页面没给状态）就放行 */
  let started = false
  while (Date.now() - t0 < 30000) {
    if (UPLOADING_RE.test(await bodyText().catch(() => ''))) { started = true; break }
    await page.waitForTimeout(1000)
  }
  if (!started) return { started: false, ms: Date.now() - t0 }

  /* ② 再等它消失。连续两次都读到"不忙"才算真的完 —— 单次可能是渲染空档 */
  let calm = 0
  let lastPct = ''
  while (Date.now() - t0 < timeoutMs) {
    const txt = await bodyText().catch(() => '')
    const busy = UPLOADING_RE.test(txt)
    if (busy) {
      calm = 0
      const m = txt.match(/(\d{1,3})%/)
      if (m && m[1] !== lastPct) lastPct = m[1]
    } else {
      calm++
      if (calm >= 2) return { started: true, ms: Date.now() - t0, lastPct }
    }
    await page.waitForTimeout(2000)
  }
  throw new Error(`上传 ${Math.round(timeoutMs / 1000)} 秒还没完成（最后进度 ${lastPct || '?'}%）`)
}

/* ── 分区选择 ────────────────────────────────────────────────────
 * B站投稿**必须**有分区，没选分区「发布」按钮是禁用的。
 * 新版页面常按标签自动推荐，但不能指望它 —— 没推荐就手动走一遍：
 * 点分区下拉 → 选一级分类 → 选二级分类。
 *
 * 默认线是「科技 → 计算机技术」，跟这个号的内容对得上。
 * 传 params.typeName 可以覆盖（一级/二级用 > 分隔，比如 "科技>计算机技术"）。 */
async function setCategory(page, dir, step, want) {
  const [wantL1, wantL2] = String(want || '科技>计算机技术').split(/[>＞]/).map((s) => s.trim())

  try {
    /* 已经有分区了（自动推荐过）就不再动 —— 别把人家的推荐覆盖掉 */
    const picked = await page.evaluate(() => {
      const el = document.querySelector('[class*="select-controller"], [class*="category"], .bcc-select')
      return el ? String(el.innerText || '').trim().slice(0, 40) : ''
    })
    if (picked && picked.length > 1) {
      step(`分区已自动带出：${picked}`)
      return { ok: true, picked, auto: true }
    }

    /* 找分区入口：B站投稿页上写着「分区」或「请选择分区」 */
    const entry = page.getByText(/请选择分区|^分区$|选择分区/).first()
    if (!(await entry.count())) {
      const shotPath = await shot(page, dir, '03f-category-noentry.png')
      step('⚠ 没找到分区入口 —— B站不选分区发不出去，确认前请手动选')
      return { ok: false, why: '没找到分区入口', shotPath }
    }
    await entry.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { })
    await entry.click({ timeout: 6000 })
    await page.waitForTimeout(1200)

    /* 一级分类 */
    const l1 = page.getByText(wantL1, { exact: true }).first()
    if (!(await l1.count())) {
      await page.keyboard.press('Escape').catch(() => { })
      const shotPath = await shot(page, dir, '03f-category-fail.png')
      step(`⚠ 分区里没找到「${wantL1}」—— 确认前请手动选`)
      return { ok: false, why: `没找到一级分类 ${wantL1}`, shotPath }
    }
    await l1.click({ timeout: 6000 })
    await page.waitForTimeout(1000)

    /* 二级分类 */
    const l2 = page.getByText(wantL2, { exact: true }).first()
    if (await l2.count()) {
      await l2.click({ timeout: 6000 })
      await page.waitForTimeout(1000)
    }
    await page.keyboard.press('Escape').catch(() => { })

    const shotPath = await shot(page, dir, '03f-category.png')
    const finalPick = await page.evaluate(() => {
      const el = document.querySelector('[class*="select-controller"], [class*="category"], .bcc-select')
      return el ? String(el.innerText || '').trim().slice(0, 40) : ''
    })
    const ok = Boolean(finalPick && finalPick.length > 1)
    step(ok ? `分区：${finalPick}` : '⚠ 分区好像没选上 —— 确认前请手动确认')
    return { ok, picked: finalPick, shotPath }
  } catch (e) {
    const why = String(e && e.message || e).slice(0, 120)
    step('⚠ 分区设置失败（确认前请手动选）：' + why)
    return { ok: false, why }
  }
}

/* ── AI 生成内容声明 ────────────────────────────────────────────
 * 同抖音那份：合规要求，尽力而为但必须留痕。B站在「创作声明」区块。 */
async function declareAiGenerated(page, dir, step) {
  try {
    const AI_RE = /内容由\s*AI\s*生成|AI\s*生成内容|人工智能生成|AI生成/
    let clicked = false
    for (const scope of [
      () => page.getByText(/创作声明/).first(),
      () => page.getByText(AI_RE).first(),
      () => page.getByRole('checkbox', { name: AI_RE }).first(),
    ]) {
      const el = scope()
      if (!(await el.count())) continue
      try {
        await el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => { })
        await el.click({ timeout: 5000 })
        await page.waitForTimeout(800)
        /* 点「创作声明」只是展开，还得再点一次真正的勾选项 */
        const box = page.getByText(AI_RE).first()
        if (await box.count()) {
          await box.click({ timeout: 5000 }).catch(() => { })
          await page.waitForTimeout(600)
        }
        clicked = true
        break
      } catch { /* 试下一种定位 */ }
    }
    const shotPath = await shot(page, dir, '03g-ai-declare.png')
    if (clicked) {
      step('已勾选「内容由 AI 生成」声明（合规要求）')
      return { ok: true, shotPath }
    }
    step('⚠ 没找到「内容由 AI 生成」声明入口 —— 点确认前请手动勾选（合规要求）')
    return { ok: false, why: '没找到 AI 声明入口', shotPath }
  } catch (e) {
    const why = String(e && e.message || e).slice(0, 120)
    step('⚠ AI 声明设置失败（点确认前请手动勾选）：' + why)
    return { ok: false, why }
  }
}

export async function publish(job, { step, awaitConfirm }) {
  const p = job.params
  const dir = path.join(ROOT, 'video', 'out', 'publish', job.id)
  fs.mkdirSync(dir, { recursive: true })
  const video = p.video

  if (!p.confirmed) {
    /* ── 第一段：dry-run ── */
    if (!video || !fs.existsSync(video)) throw new Error(`视频文件不存在：${video}`)

    /* 一个平台同时只允许一条投稿在等确认 —— 两条会抢同一个 context 和上传页 */
    const busy = findAwaitingConfirm({ platform: 'bili', kind: 'publish' })
    if (busy && busy.id !== job.id) {
      throw new Error(`B站已经有一条投稿在等确认（${busy.id}「${String(busy.title).slice(0, 24)}」）—— 先确认或撤销它`)
    }

    return guardedWrite('bili', {
      checkAlive: async () => {
        const { ctx } = await launchPersistent('bili', { headless: true })
        return session.checkAlive(ctx)
      },
      write: async () => {
        step('打开 B站投稿页（无头）')
        const { ctx } = await launchPersistent('bili', { headless: true })
        /* 🔴 每次 newPage，不要 ctx.pages().find() —— 会捡到上一条任务没关的
         *    上传页，在别人填了一半的表单上接着填。 */
        const page = await ctx.newPage()
        try {
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
          /* 🔴 上传完成的信号必须专门等，不能靠「标题框出现」。
           *    标题框在选文件之前就已经在页面上了 —— 拿它当信号等于
           *    选完文件立刻往下填表，然后在上传还没完成时点发布。
           *    抖音那边为这个坑写了 waitUploadDone（先等状态出现、再等它消失），
           *    这里做一份同构实现，只是选择器换成 B站的。 */
          const up = await waitUploadDone(page)
          step(up.started
            ? `上传完成（${Math.round((up.ms || 0) / 1000)} 秒）`
            : '没看到上传进度（可能秒传），继续')
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

          /* 分区：B站投稿必须选分区，不选发布按钮点不动。
           * 新版投稿页通常按标签自动推荐，但没推荐时要显式选一次。
           * 分区名从 params.typeName 给，没给就试「科技→计算机技术」这条默认线。 */
          const cat = await setCategory(page, dir, step, p.typeName || p.category)

          /* AI 生成内容声明 —— 合规硬要求。
           * 《人工智能生成合成内容标识办法》2025-09-01 起强制施行，B站在
           * 「创作声明」里。勾不上必须喊出来，不能静默跳过。 */
          const aiDecl = await declareAiGenerated(page, dir, step)

          /* 预检发布按钮 —— 抖音那边踩过的坑：非精确匹配会先命中导航里的
           * 「作品发布」，点了就跳到作品列表页，人还以为发出去了。B站同构，
           * 这里也在 dry-run 阶段就把定位验掉，只数不点。 */
          try {
            const n = await page.getByRole('button', { name: '发布', exact: true }).count()
            step(n === 1 ? '发布按钮定位正常（确认后即可点）' : `⚠ 发布按钮匹配到 ${n} 个（期望 1）—— 确认前先看一眼截图`)
          } catch (e) {
            step('⚠ 发布按钮没找到：' + String(e.message || e).slice(0, 80))
          }

          const shotPath = await shot(page, dir, '03-dry-run.png')
          kept.set(job.id, { page })
          logEvent('bili', 'publish.dryrun', {
            ok: true, jobId: job.id, title,
            category: cat && cat.ok ? cat.picked : '',
            aiDeclared: aiDecl && aiDecl.ok === true,
          })
          awaitConfirm({
            platform: 'bili', kind: 'publish', title,
            screenshots: [shotPath,
              ...(cat && cat.shotPath ? [cat.shotPath] : []),
              ...(aiDecl && aiDecl.shotPath ? [aiDecl.shotPath] : [])],
            dir,
            category: cat && cat.ok ? cat.picked : null,
            aiDeclared: aiDecl && aiDecl.ok === true,
            warnings: [
              ...(aiDecl && aiDecl.ok !== true ? ['「内容由 AI 生成」声明没勾上 —— 点确认前请手动勾选（合规要求）'] : []),
              ...(cat && cat.ok === false ? ['分区没选上 —— B站不选分区发布按钮点不动，确认前请手动选'] : []),
            ],
            note: '表单已填好、停在发布前。B站上传可能仍在后台继续，确认前别关服务。',
          })
          return { dryRun: true, category: cat, aiDeclare: aiDecl }
        } catch (e) {
          closeKept(job.id)
          await page.close().catch(() => { })
          throw e
        }
      },
    })
  }

  /* ── 第二段：确认后点发布 ── */
  return guardedWrite('bili', {
    checkAlive: async () => {
      const k = kept.get(job.id)
      /* 🔴 必须带 soft:true —— 页面丢了不该熔断当天所有写操作（同抖音那边） */
      if (!k) return { ok: false, soft: true, why: 'dry-run 的页面丢了（服务重启过）—— 重新发起一次投稿' }
      return session.checkAlive(k.page.context())
    },
    write: async () => {
      const k = kept.get(job.id)
      const { page } = k
      try {
        step('已确认，点「发布」')
        await shot(page, dir, '04-before-publish.png')
        /* 🔴 必须 exact：B站页面里带「发布」字样的按钮/导航不止一个
         *    （「发布」主按钮、「定时发布」、「发布设置」），非精确匹配会先命中
         *    顺序靠前的那个。抖音那边已经因为这个跳错过页。 */
        const btn = page.getByRole('button', { name: '发布', exact: true }).first()
        await btn.waitFor({ state: 'visible', timeout: 30000 })
        await btn.click()
        await page.waitForTimeout(6000)
        const shotPath = await shot(page, dir, '05-published.png')
        const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1500) : '')
        const ok = /投稿成功|审核|成功提交/.test(body)
        logEvent('bili', 'publish.done', { ok, jobId: job.id, title: job.params.title })
        if (!ok) throw new Error('点了发布但没看到成功提示 —— 看 05 截图确认，别重复点')
        return { published: true, screenshot: shotPath }
      } finally {
        closeKept(job.id)
        await page.close().catch(() => { })
      }
    },
  })
}
