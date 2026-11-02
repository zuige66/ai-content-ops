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
import { launchPersistent, getLive } from '../core/browser.mjs'
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

/* ── 清掉浏览器里残留的未提交草稿 ────────────────────────────────
 * 🔴 实测（2026-11-02）会挡死上传：
 *    上传页顶部会弹「本地浏览器存在 N 个未提交的视频」，
 *    这时再 setInputFiles 是**没反应的**（上传压根不启动），
 *    而脚本看到的是"塞了文件但没上传"，很难联想到是这个横幅。
 *
 *    这条横幅是 B站把草稿存在浏览器本地（IndexedDB/localStorage）的产物，
 *    我们每跑一次 dry-run 就多攒一个。跑几次之后就再也传不上去了。
 *
 *    处理：点「不用了」把残留草稿丢掉。找不到横幅就直接过。 */
async function dismissLocalDrafts(page, dir, step) {
  try {
    const banner = page.getByText(/本地浏览器存在\s*\d+\s*个未提交的视频/).first()
    if (!(await banner.count())) return { ok: true, cleared: false }

    const text = await banner.innerText().catch(() => '')
    const drop = page.getByText('不用了', { exact: true }).first()
    if (await drop.count()) {
      await drop.click({ timeout: 6000 })
      await page.waitForTimeout(2000)
      /* 可能会二次确认 */
      for (const label of ['确定', '确认', '删除']) {
        const b = page.getByRole('button', { name: label, exact: true }).first()
        if (await b.count()) { await b.click({ timeout: 4000 }).catch(() => { }); await page.waitForTimeout(1200) }
      }
      await shot(page, dir, '00-cleared-drafts.png')
      step(`已清掉本地残留草稿（${String(text).replace(/\s+/g, ' ').slice(0, 40)}）`)
      return { ok: true, cleared: true, text }
    }
    step('⚠ 有本地残留草稿但没找到「不用了」按钮 —— 上传可能传不上去')
    return { ok: false, why: 'no-dismiss-button', text }
  } catch (e) {
    return { ok: false, why: String(e && e.message || e).slice(0, 100) }
  }
}

/* ── 等上传区渲染出来 ──────────────────────────────────────────
 * B站创作中心是 micro-app 微前端（<micro-app name="video-up">），
 * 实测首屏骨架屏要 15~20 秒才换成真控件。死等固定秒数会误判。 */
async function waitUploadZone(page, timeoutMs = 60000) {
  const t0 = Date.now()
  let lastErr = ''
  while (Date.now() - t0 < timeoutMs) {
    try {
      const n = await page.locator('input[type=file]').count()
      if (n > 0) {
        /* 再多给一点时间让上传区挂完，否则 setInputFiles 会打在还没绑事件的节点上 */
        await page.waitForTimeout(1200)
        return { ok: true, ms: Date.now() - t0 }
      }
      /* 登录页 / 错误页要早点报出来，别干等 60 秒 */
      const url = page.url()
      if (/passport|login/.test(url)) return { ok: false, ms: Date.now() - t0, why: '跳去了登录页' }
    } catch (e) { lastErr = String(e && e.message || e).slice(0, 80) }
    await page.waitForTimeout(1200)
  }
  return { ok: false, ms: Date.now() - t0, why: lastErr || '没等到 file input' }
}

/* ── 等上传真完成 ────────────────────────────────────────────────
 * 跟抖音那份同构，坑也是同一个：
 *   坑 1：拿「标题框出现」当信号 —— 选完文件就往下走，视频还在传。
 *   坑 2：改成看进度文案后仍然提前返回 —— setInputFiles 一返回就读 DOM，
 *         此时还没渲染出上传状态，第一次判断就是"不忙"，直接当完成。
 *         所以必须先等状态**出现**，再等它**消失**。
 *
 * 实测 B站上传中的文案：「上传中」「正在上传」「解析中」「转码中」+ 百分比。
 * 🔴 started:false 表示**上传压根没启动**（file input 选错了），
 *    调用方必须当失败处理，不能当成"秒传"放过去。 */
const UPLOADING_RE = /上传中|正在上传|解析中|转码中|\d{1,3}%/

async function waitUploadDone(page, timeoutMs = 900000) {
  const bodyText = () => page.evaluate(() => (document.body ? document.body.innerText : ''))
  const t0 = Date.now()

  /* ① 先等上传状态出现 */
  let started = false
  while (Date.now() - t0 < 45000) {
    if (UPLOADING_RE.test(await bodyText().catch(() => ''))) { started = true; break }
    await page.waitForTimeout(1000)
  }
  if (!started) return { started: false, ms: Date.now() - t0 }

  /* ② 再等它消失。连续两次都读到"不忙"才算真完 —— 单次可能是渲染空档 */
  let calm = 0
  let lastPct = ''
  while (Date.now() - t0 < timeoutMs) {
    const txt = await bodyText().catch(() => '')
    if (UPLOADING_RE.test(txt)) {
      calm = 0
      const m = txt.match(/(\d{1,3})%/)
      if (m && m[1] !== lastPct) lastPct = m[1]
    } else {
      calm++
      /* 不忙了还要确认表单真的出来了（标题框在），否则可能只是换了个骨架屏 */
      if (calm >= 2) {
        const hasTitle = await page.locator('input[placeholder="请输入稿件标题"]').count().catch(() => 0)
        if (hasTitle > 0 || calm >= 4) return { started: true, ms: Date.now() - t0, lastPct }
      }
    }
    await page.waitForTimeout(2000)
  }
  throw new Error(`上传 ${Math.round(timeoutMs / 1000)} 秒还没完成（最后进度 ${lastPct || '?'}%）`)
}

/* ── 分区选择 ────────────────────────────────────────────────────
 * B站投稿**必须**有分区，没选分区「发布」按钮是禁用的。
 *
 * 实测（2026-11-02）：分区默认已经带了「科技数码」（页面会按标签自动推荐），
 * 显示成 `.section-title-content-main` 旁边的一个 bcc-select 下拉。
 * 所以策略是：**先读当前值，已经有就不动**；空了才点开选一次。
 * 别把人家推荐好的分区覆盖掉。 */
async function setCategory(page, dir, step, want) {
  const [wantL1, wantL2] = String(want || '科技数码').split(/[>＞]/).map((s) => s.trim())

  try {
    /* 读当前分区：找「分区」标题所在区块里的 select */
    const current = await page.evaluate(() => {
      const titles = [...document.querySelectorAll('.section-title-content-main')]
      const t = titles.find((el) => (el.textContent || '').trim() === '分区')
      if (!t) return ''
      /* 分区控件在标题的兄弟/父级区块里 */
      let box = t.closest('.section-title') || t.parentElement
      for (let i = 0; i < 4 && box; i++) {
        const sel = box.querySelector('.bcc-select, [class*="select"]')
        if (sel) {
          const v = String(sel.innerText || sel.textContent || '').replace(/\s+/g, ' ').trim()
          if (v && v.length > 1) return v.slice(0, 40)
        }
        box = box.parentElement
      }
      return ''
    })

    if (current && current.length > 1 && !/请选择/.test(current)) {
      /* 🔴 「自动带出」不等于「带对了」。实测两次同一份内容，
       *    一次推荐「科技数码」、一次推荐「娱乐」—— 因为标签里有「AI」，
       *    有时会命中娱乐区的推荐规则。分区错了 B站会限流，必须核对。
       *    期望值从 params.typeName 给（默认「科技数码」），对不上就重新选。 */
      if (!wantL1 || current.includes(wantL1)) {
        step(`分区已自动带出：${current}`)
        return { ok: true, picked: current, auto: true }
      }
      step(`⚠ 自动推荐的分区是「${current}」，与期望的「${wantL1}」不符 —— 重新选`)
      /* 落下去走下面的手动选择流程 */
    }

    /* 空了才手动选 */
    const entry = page.getByText(/请选择|选择分区/).first()
    if (!(await entry.count())) {
      const shotPath = await shot(page, dir, '03f-category-noentry.png')
      step('⚠ 分区是空的且没找到入口 —— B站不选分区发不出去，确认前请手动选')
      return { ok: false, why: '没找到分区入口', shotPath }
    }
    await entry.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { })
    await entry.click({ timeout: 6000 })
    await page.waitForTimeout(1200)

    const l1 = page.getByText(wantL1, { exact: true }).first()
    if (await l1.count()) {
      await l1.click({ timeout: 6000 })
      await page.waitForTimeout(900)
      const l2 = page.getByText(wantL2, { exact: true }).first()
      if (wantL2 && (await l2.count())) { await l2.click({ timeout: 6000 }); await page.waitForTimeout(900) }
    }
    await page.keyboard.press('Escape').catch(() => { })

    const shotPath = await shot(page, dir, '03f-category.png')
    const finalPick = await page.evaluate(() => {
      const titles = [...document.querySelectorAll('.section-title-content-main')]
      const t = titles.find((el) => (el.textContent || '').trim() === '分区')
      let box = t && (t.closest('.section-title') || t.parentElement)
      for (let i = 0; i < 4 && box; i++) {
        const sel = box.querySelector('.bcc-select, [class*="select"]')
        if (sel) return String(sel.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40)
        box = box.parentElement
      }
      return ''
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
 * 实测（2026-11-02）B站真实结构：
 *   「创作声明」是个 bcc-select 下拉，placeholder 是
 *     input[placeholder="请选择符合您视频内容的创作声明"]
 *   选项里有一条是「含AI生成内容」。
 *   （页面上还有「AI生成」是封面生成按钮，别点错）
 *
 * 合规硬要求，勾不上必须喊出来。 */
async function declareAiGenerated(page, dir, step) {
  try {
    const box = page.locator('input[placeholder="请选择符合您视频内容的创作声明"]').first()
    if (!(await box.count())) {
      const shotPath = await shot(page, dir, '03g-ai-noentry.png')
      step('⚠ 没找到「创作声明」下拉 —— 点确认前请手动选「含AI生成内容」（合规要求）')
      return { ok: false, why: '没找到创作声明下拉', shotPath }
    }

    await box.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { })
    await box.click({ timeout: 6000 })
    await page.waitForTimeout(1200)

    /* 选项里找「含AI生成内容」。用 option-text 类精确一点 */
    let opt = page.locator('.option-text').filter({ hasText: /AI/ }).first()
    if (!(await opt.count())) opt = page.getByText(/含AI生成内容/).first()
    if (!(await opt.count())) {
      await page.keyboard.press('Escape').catch(() => { })
      const shotPath = await shot(page, dir, '03g-ai-nooption.png')
      step('⚠ 创作声明里没找到「含AI生成内容」选项 —— 确认前请手动选（合规要求）')
      return { ok: false, why: '没找到含AI生成内容选项', shotPath }
    }
    await opt.click({ timeout: 6000 })
    await page.waitForTimeout(1200)

    const shotPath = await shot(page, dir, '03g-ai-declare.png')
    /* 回读：下拉里应该变成「含AI生成内容」 */
    const picked = await box.inputValue().catch(() => '')
    const ok = /AI/i.test(picked)
    step(ok
      ? `已选创作声明：${picked}（合规要求）`
      : '⚠ 创作声明好像没选上 —— 确认前请手动确认（合规要求）')
    return { ok, picked, shotPath }
  } catch (e) {
    const why = String(e && e.message || e).slice(0, 120)
    step('⚠ 创作声明设置失败（确认前请手动选）：' + why)
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
        /* 🔴 别在这里 launchPersistent —— 它会走 browser.mjs 的"模式不匹配就关旧的"
         *    逻辑，把正在跑的上传页所在 context 关掉。实测（2026-11-02）就是
         *    这样把 ctx 关没了，紧接着 write() 里 page.evaluate 抛
         *    `Target page, context or browser has been closed`。
         *    有活着的就用活的，没有才起一个。 */
        const live = getLive('bili')
        const ctx = live || (await launchPersistent('bili', { headless: true })).ctx
        return session.checkAlive(ctx)
      },
      write: async () => {
        step('打开 B站投稿页')
        const live = getLive('bili')
        const ctx = live || (await launchPersistent('bili', { headless: true })).ctx
        /* 🔴 每次 newPage，不要 ctx.pages().find() —— 会捡到上一条任务没关的
         *    上传页，在别人填了一半的表单上接着填。 */
        const page = await ctx.newPage()
        try {
          /* 🔴 goto 不能直接 await 硬失败：B站创作中心是 SPA，
           *    打开 /upload/video/frame 后前端会自己重定向一次，
           *    Playwright 偶尔报 `net::ERR_ABORTED`（页面其实已经正常打开了）。
           *    探测脚本里也复现过同样的现象 —— 所以这里容忍导航错误，
           *    真正的判据是「上传区有没有渲染出来」（下一句 waitUploadZone）。 */
          await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 90000 })
            .catch((e) => {
              const msg = String(e && e.message || e)
              if (!/ERR_ABORTED|net::ERR_ABORTED/i.test(msg)) throw e
              step('页面重定向了一次（ERR_ABORTED，正常现象），继续等上传区')
            })
          /* B站创作中心是 micro-app 微前端，首屏骨架屏实测要 15~20 秒才换成真控件。
           * 死等固定秒数会误判，改成等 file input 真的出现。 */
          const got = await waitUploadZone(page)
          if (!got.ok) {
            await shot(page, dir, 'not-ready.png')
            throw new Error(`B站上传页 ${Math.round(got.ms / 1000)} 秒还没渲染出上传区：${got.why}`)
          }
          // 没登录会被踢去 passport —— 直接把话说清楚，别在错误页面上瞎填表
          if (!/member\.bilibili\.com/.test(page.url())) {
            await shot(page, dir, 'not-logged-in.png')
            throw new Error('B站投稿页跳去了登录页 —— 登录态失效，先扫码登录')
          }
          step(`上传页就绪（${Math.round(got.ms / 1000)} 秒）`)
          /* 🔴 必须在 setInputFiles 之前清草稿 —— 有残留横幅时上传根本不启动 */
          await dismissLocalDrafts(page, dir, step)
          await shot(page, dir, '01-open.png')

          step('选视频文件，等上传完成')
          /* 🔴 页面上有 3 个 file input，**只有第 0 个是上传入口**：
           *      [0] 藏在 div.bcc-upload-wrapper 里（display:none），真上传口
           *      [1] 尺寸 303x30，同 accept，但不是入口 —— 塞进去没反应
           *      [2] accept=".txt"，是字幕上传
           *    实测（2026-11-02）：塞 .first() 有效，塞 nth(1) 完全无反应。
           *    所以这里用 `.first()` 并**验证上传真的启动了**，别静默失败。 */
          await page.locator('input[type=file]').first().setInputFiles(video)
          const up = await waitUploadDone(page)
          if (!up.started) {
            await shot(page, dir, 'upload-not-started.png')
            throw new Error('塞了文件但上传没启动 —— file input 可能选错了，看 upload-not-started.png')
          }
          step(`上传完成（${Math.round((up.ms || 0) / 1000)} 秒）`)
          await shot(page, dir, '02-uploaded.png')

          step('填标题 / 简介 / 标签')
          /* 🔴 实测真实 placeholder（2026-11-02 探得）：
           *      标题     input[placeholder="请输入稿件标题"]        cls=input-val
           *      创作声明 input[placeholder="请选择符合您视频内容的创作声明"] cls=bcc-select-input-inner
           *      标签     input[placeholder="按回车键Enter创建标签"]
           *      简介     .ql-editor（quill 富文本）
           *    以前那批 placeholder*="标题" 能命中标题，但其余几个全靠猜。 */
          const title = String(p.title || '').slice(0, 80)
          const titleBox = page.locator('input[placeholder="请输入稿件标题"]').first()
          if (await titleBox.count()) {
            await titleBox.fill(title)
            step(`标题已填：${title}`)
          } else {
            /* 兜底：任何带「标题」的输入框 */
            const fallback = page.locator('input[placeholder*="标题"]').first()
            if (await fallback.count()) { await fallback.fill(title); step(`标题已填（兜底选择器）`) }
            else step('⚠ 没找到标题输入框 —— 确认前请手动填')
          }

          /* 简介：quill 编辑器。用 visible 的那个，别命中 ql-clipboard */
          if (p.desc) {
            try {
              const editor = page.locator('.ql-editor').filter({ visible: true }).first()
              const target = (await editor.count()) ? editor : page.locator('[contenteditable="true"]').filter({ visible: true }).first()
              await target.click()
              await target.fill(String(p.desc).slice(0, 2000))
              step('简介已填')
            } catch (e) { step('简介编辑器没找到（不阻塞）：' + String(e.message || e).slice(0, 60)) }
          }

          /* 标签：placeholder 是「按回车键Enter创建标签」，输入后回车逐个加 */
          const tagInput = page.locator('input[placeholder*="按回车"]').filter({ visible: true }).first()
          if (await tagInput.count()) {
            for (const t of (Array.isArray(p.tags) ? p.tags : []).slice(0, 10)) {
              try {
                await tagInput.fill(String(t).slice(0, 20))
                await tagInput.press('Enter')
                await page.waitForTimeout(350)
              } catch { step(`标签「${t}」没加上（不阻塞）`) }
            }
            step(`标签已加 ${(p.tags || []).length} 个`)
          } else {
            step('⚠ 没找到标签输入框（不阻塞）')
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

          /* 预检投稿按钮。
           * 🔴 实测（2026-11-02）真实结构 —— 这几点跟抖音完全不同：
           *    · 主按钮**不叫「发布」**，叫「立即投稿」
           *    · 它**不是 <button>**，是 `<span class="submit-button-anchor">立即投稿</span>`
           *      → getByRole('button') 永远数到 0，第二段必然点不出去
           *    · 外层容器 .submit-container / .submit-actions，兄弟是「存草稿」
           *    · 在页面最底部，且 window.scrollTo 在这个 micro-app 里无效
           *      （滚动容器是内层 div），只能用 scrollIntoViewIfNeeded */
          try {
            const submit = page.locator('.submit-button-anchor, .submit-add').filter({ hasText: '立即投稿' }).first()
            const nSubmit = await submit.count()
            let visible = false
            if (nSubmit > 0) {
              await submit.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => { })
              await page.waitForTimeout(500)
              visible = await submit.isVisible().catch(() => false)
            }
            const nDraft = await page.locator('.submit-draft').filter({ hasText: '存草稿' }).count()
            step(nSubmit >= 1 && visible
              ? `投稿按钮定位正常（「立即投稿」可见，存草稿 ${nDraft} 个）`
              : `⚠ 「立即投稿」按钮：存在 ${nSubmit} 个 / 可见 ${visible} —— 确认前先看一眼截图`)
            /* 截完图再滚回顶部，让人看主图时从封面开始 */
            await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { })
          } catch (e) {
            step('⚠ 投稿按钮没找到：' + String(e.message || e).slice(0, 80))
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

  /* ── 第二段：确认后点投稿 ── */
  return guardedWrite('bili', {
    checkAlive: async () => {
      const k = kept.get(job.id)
      /* 🔴 必须带 soft:true —— 页面丢了不该熔断当天所有写操作（同抖音那边） */
      if (!k) return { ok: false, soft: true, why: 'dry-run 的页面丢了（服务重启过）—— 重新发起一次投稿' }
      /* 用 kept 页自己的 context 做体检，别再起浏览器 —— 起了会把这张页关掉 */
      try {
        return await session.checkAlive(k.page.context())
      } catch (e) {
        const why = String(e && e.message || e).slice(0, 160)
        /* 页面/浏览器没了是环境问题，不是掉号 */
        return { ok: false, soft: true, why: `上传页已失效：${why}` }
      }
    },
    write: async () => {
      const k = kept.get(job.id)
      const { page } = k
      try {
        step('已确认，点「立即投稿」')
        await shot(page, dir, '04-before-publish.png')
        /* 🔴 真实结构（实测 2026-11-02）：
         *    主按钮是 `<span class="submit-button-anchor">立即投稿</span>`，
         *    **不是 <button>** —— 用 getByRole('button') 永远点不到，
         *    这就是 B站投稿 0 次成功的直接原因。
         *    兄弟按钮「存草稿」在 .submit-draft，别点错。
         *    另外从 dry-run 到人点确认可能隔几分钟，上传可能还没收尾，先再等一次。 */
        await waitUploadDone(page, 180000).catch(() => { })
        const btn = page.locator('.submit-button-anchor, .submit-add').filter({ hasText: '立即投稿' }).first()
        await btn.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => { })
        await page.waitForTimeout(600)
        await btn.click({ timeout: 30000 })
        await page.waitForTimeout(8000)
        const shotPath = await shot(page, dir, '05-published.png')
        const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '')
        const url = page.url()
        /* 🔴 成功判定别用裸 /审核/ —— 投稿页本身就常驻「审核」字样
         *    （「审核通过后…」），误判成功会让人以为发出去了。
         *    只认明确短语或跳转到稿件管理页。 */
        const ok = /投稿成功|稿件投递成功|已提交|投递成功|稿件已提交|等待审核/.test(body)
          || /platform\/upload\/text|archive|content\/manage/.test(url)
        logEvent('bili', 'publish.done', { ok, jobId: job.id, title: job.params.title, url })
        if (!ok) throw new Error('点了「立即投稿」但没看到成功提示 —— 看 05 截图确认，别重复点')
        return { published: true, screenshot: shotPath, url }
      } finally {
        closeKept(job.id)
        await page.close().catch(() => { })
      }
    },
  })
}
