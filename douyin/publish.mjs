/* douyin/publish.mjs —— 抖音投稿（creator.douyin.com 创作者平台上传 RPA）
 * 与 bili/publish.mjs 同构的两段式。抖音风控更严：
 *   · 全程真实 UI 操作、串行、慢速（每步之间留时间）
 *   · 写操作过熔断器；失败立即停手，绝不重试轰炸
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'
import { launchPersistent, attachLive } from '../core/browser.mjs'
import { guardedWrite } from '../core/breaker.mjs'
import { findAwaitingConfirm, onCancel } from '../core/jobs.mjs'
import { readConfig } from '../core/shell.mjs'
import * as session from './session.mjs'

/* 挑浏览器。
 *
 * 🔴 默认走「真人浏览器接管」（attachLive）：自己 spawn 系统 Chrome + CDP 附着，
 *    不带 Playwright 的 automation 标记。Playwright 自带的无头实例在抖音眼里是
 *    「刚装好的空浏览器」，上传视频必弹短信验证码 —— 今天被这个卡了三次。
 *    想退回老路子就把 config.chrome.liveMode 设成 false。 */
async function pickBrowser(p) {
  const cfg = readConfig().chrome || {}
  if (cfg.liveMode !== false) return attachLive('douyin', { port: cfg.debugPort })
  return launchPersistent('douyin', { headless: !p.headed })
}

export const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'

/* 发布成功的**明确**短语。故意不含裸「审核」二字：
 * 上传页常驻「审核通过后…」这类提示，用 /审核/ 判会把"还没发"当成"发好了"，
 * 紧接着 page.close() —— 结果是假成功 + 重复投稿。 */
const PUBLISHED_RE = /发布成功|作品发布成功|已发布成功|提交成功|审核中|正在审核/

/** 这个页面所在窗口对人可见吗？
 *  liveMode（CDP 接管真人 Chrome）下永远是可见的，不管 p.headed 传了什么。
 *  真无头的话才返回 false。 */
async function isWindowVisible(page, p) {
  try {
    const cfg = readConfig().chrome || {}
    if (cfg.liveMode !== false) return true      // CDP 接管 = 真人浏览器，一定看得见
    return Boolean(p.headed)
  } catch {
    return Boolean(p.headed)
  }
}

/* dry-run 停在发布前，页面留着等人点头。
 * 🔴 只存「这一条任务自己 newPage 出来的页」，绝不能存 ctx 里翻出来的页 ——
 *    见下面 openUploadPage 的注释。 */
const kept = new Map()

function closeKept(jobId) {
  const k = kept.get(jobId)
  if (!k) return
  kept.delete(jobId)
  Promise.resolve(k.page.close()).catch(() => { /* 页可能已经没了 */ })
}

/* 撤销时把活着的上传页关掉。不关的话下一条任务会捡到它 —— 今天连着
 * 5 次 dry-run 有 2 次没看到「上传完成」，就是在上一条的半成品上接着填。
 * 🔴 必须带上 platform：B 站那份也注册 kind='publish'，不带平台会被它覆盖。 */
onCancel('publish', 'douyin', (job) => closeKept(job.id))

async function shot(page, dir, name) {
  const p = path.join(dir, name)
  try { await page.screenshot({ path: p, fullPage: false }) } catch { return '' }
  return p
}

/**
 * 开一张**属于这条任务**的上传页。
 *
 * 🔴 这里原来写的是 `ctx.pages().find(url.includes('creator.douyin.com'))`。
 *    persistent context 是整个平台共用的，上一条任务的页只要没关就还在
 *    ctx.pages() 里，于是第二条任务会在第一条填了一半的表单上继续填：
 *    日志全绿、截图看着也有内容，实际填的是别人的表。
 *    每次 newPage() 是唯一能保证"从零开始"的做法。
 */
async function openUploadPage(ctx) {
  /* 🔴 CDP 模式下这个浏览器是长期开着的，得先清场：
   *    · 残留的上传页可能停着上一轮的半成品表单，复用它就是串台（今天 5 次撤销的根因）
   *    · 标签页越攒越多，抖音上传页本来就重，最后直接导航超时
   *    所以先把同 URL 的旧页全关掉，再开一张干净的。 */
  for (const p of ctx.pages().filter(x => x.url().includes('content/upload'))) {
    await p.close().catch(() => { })
  }
  const page = await ctx.newPage()
  /* waitUntil 用 commit 不用 domcontentloaded：抖音这个 SPA 的 domcontentloaded
   * 要等一堆异步资源，实测经常 60 秒都到不了（2026-11-01 就在这里超时过一次）。
   * commit 只等响应头，后面靠固定等待 + 元素轮询兜。 */
  await page.goto(UPLOAD_URL, { waitUntil: 'commit', timeout: 90000 })
  await page.waitForTimeout(5000)
  return page
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

/**
 * 在整页里找「位置」入口。
 *
 * 抖音这个页面是分块懒渲染的：截图里只看到「基础信息」，下面还有「扩展信息」，
 * 不滚下去查不到 —— 第一次实现只在当前视口里找，直接报"没找到入口"。
 * 所以这里先滚到底再扫，并把所有含「位置/地点」的可见元素回报上去，
 * 真找不到的时候能从日志看出页面到底长什么样，不用瞎猜选择器。
 */
async function probeLocationEntry(page) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(1500)
  const hits = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('div,span,button,a,label,p,li')) {
      const t = (el.innerText || '').trim()
      if (!t || t.length > 14 || !/位置|地点/.test(t)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 6 || r.height < 6) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue
      out.push({ tag: el.tagName, text: t, y: Math.round(r.y) })
    }
    /* 去掉被父节点重复计数的：同样的文字留最靠内层的一个（innerText 短的） */
    const uniq = []
    for (const h of out.sort((a, b) => a.text.length - b.text.length)) {
      if (!uniq.some(u => u.text === h.text)) uniq.push(h)
    }
    return uniq.slice(0, 12)
  })
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(400)
  return hits
}

/**
 * 从下拉选项里挑出「广州大学城校区」那一条，挑不到返回 -1。
 *
 * 🔴 匹配必须严。第一次实现是「优先含校区，否则第一个含校名的」，
 *    结果搜「广东工业大学」的第一条是**广东工业大学建筑设计研究院(深圳分院)**，
 *    在深圳福田 —— 视频讲的是广州大学城，标到深圳就是硬伤。
 *    现在没有「大学城」或「广州/番禺 + 广东工业」就返回 -1，
 *    调用方据此**放弃标注**，而不是退而求其次选个错的。
 */
function pickCampusIdx(all, campus) {
  /* 必须校名 + 城市同时命中。只看「大学城校区」会选中深圳的
   * 「毛毛虫英语分级阅读中心·大学城校区」—— 名字里四个字全中，位置在深圳南山。 */
  for (let i = 0; i < all.length; i++) {
    const t = all[i] || ''
    if (/广东工业/.test(t) && /广州|番禺/.test(t)) return i
  }
  /* 退一步：名字里带「广东工业」且带「大学城」，也认（有些 POI 地址只写番禺） */
  for (let i = 0; i < all.length; i++) {
    const t = all[i] || ''
    if (/广东工业/.test(t) && /大学城/.test(t)) return i
  }
  return -1
}

/**
 * 添加位置（POI）。
 *
 * 这块选择器没有稳定 API，抖音改版就换文案，所以整段是**尽力而为**：
 * 任何一步失败都只记一条 ⚠ 日志，绝不把投稿卡死 —— 位置是加分项，
 * 不是发布的前置条件。真实结果看 03b-location.png 截图。
 *
 * @param want 期望的地点全名，如「广东工业大学（大学城校区）」
 */
async function addLocation(page, dir, step, want) {
  if (!want) return { ok: false, skipped: true }
  const keyword = String(want).trim().slice(0, 30)
  /* 搜索框要的是校名主体，括号里的校区名反而会让联想词变少 */
  const search = keyword.replace(/[（(][^）)]*[）)]\s*$/, '').trim() || keyword

  try {
    const hits = await probeLocationEntry(page)
    await page.keyboard.press('Escape').catch(() => { })   // 关掉可能已经展开的浮层

    /* 🔴 实测（2026-11-01，截图见 03b-location-nobox.png）：
     *    这一行是「添加标签 [类型下拉▼] [输入地理位置]」。
     *    左边的下拉框当前值恰好就显示「位置」，点它会展开一个选项列表
     *    （位置 / 影视演艺 / 小程序 / 游戏手柄 / 标记万物），把右边的输入框挡死。
     *    所以**绝不能点那个下拉**，要直接找 placeholder 含「地理」的输入框。 */
    /* 🔴 实测结构（完整 dump 在 state/loc-probe.json）：
     *    「输入地理位置」不是 input，是 semi-design 的 Select：
     *      .semi-select-selection > .semi-select-content-wrapper
     *        > span.semi-select-selection-placeholder   ← 显示「输入地理位置」
     *        > .semi-input-wrapper > input.semi-input   ← 真输入框，placeholder 是空串
     *    所以 input[placeholder*="地理"] 永远匹配不到 —— 那个 input 根本没有 placeholder。
     *    另外左边「添加标签」的类型下拉当前值也显示「位置」，点它会展开
     *    （位置/影视演艺/小程序/游戏手柄/标记万物）把输入框挡死 —— 别碰它。 */
    /* 🔴 封面弹窗关掉后，DOM 里会残留一份**隐藏的**同名 semi-select。
     *    直接 .first() 很容易摸到那个隐藏的，于是"位置输入框没找到"。
     *    所以先用 evaluate 挑**可见**的占位符，取它旁边的 input 打标记，
     *    后面一律按标记取 —— 隐藏的那份永远不会被选中。 */
    let box = page.locator('input[data-wb-locbox="1"]').first()
    if (!(await box.count())) {
      const marked = await page.evaluate(() => {
        const sp = [...document.querySelectorAll('.semi-select-selection-placeholder')]
          .find(e => /输入地理位置/.test(e.textContent || '') && e.offsetParent !== null)
        const inp = sp && sp.parentElement && sp.parentElement.querySelector('input.semi-input')
        if (!inp) return false
        inp.setAttribute('data-wb-locbox', '1')
        return true
      })
      if (marked) box = page.locator('input[data-wb-locbox="1"]').first()
    }
    if (!(await box.count())) {
      box = page.locator('.semi-select').filter({ hasText: '输入地理位置' })
        .locator('input.semi-input').first()
    }

    if (!(await box.count())) {
      /* 占位符还在 = 选择器没展开，点一下让它把 input 露出来 */
      const ph = page.locator('.semi-select-selection-placeholder').filter({ hasText: '输入地理位置' }).first()
      if (await ph.count()) {
        await ph.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { })
        await ph.click({ timeout: 5000 }).catch(() => { })
        await page.waitForTimeout(1200)
        box = page.locator('.semi-select input.semi-input').first()
      }
    }

    if (!(await box.count())) {
      /* 把页面上所有输入框的 placeholder 打出来，再把「输入地理位置」这个
       * 元素的真实结构落盘 —— 下次改版能直接照着改，不用再猜一轮 */
      const inputs = await page.evaluate(() => [...document.querySelectorAll('input,textarea')]
        .map(i => ({ ph: (i.placeholder || '').slice(0, 20), type: i.type || '' })).slice(0, 8))
      const probe = await page.evaluate(() => {
        const el = [...document.querySelectorAll('*')]
          .find(e => (e.textContent || '').trim() === '输入地理位置' && e.children.length === 0)
        if (!el) return { found: false }
        const p = el.parentElement
        const g = p && p.parentElement
        return {
          found: true,
          tag: el.tagName, cls: String(el.className).slice(0, 80),
          role: el.getAttribute('role'), contentEditable: el.isContentEditable,
          parent: p ? { tag: p.tagName, cls: String(p.className).slice(0, 80), html: p.outerHTML.slice(0, 500) } : null,
          grand: g ? { tag: g.tagName, cls: String(g.className).slice(0, 80), html: g.outerHTML.slice(0, 500) } : null,
        }
      })
      try { fs.writeFileSync(path.join(ROOT, 'state', 'loc-probe.json'), JSON.stringify({ inputs, probe }, null, 1)) } catch { /* 落不了盘不影响主流程 */ }
      step(`⚠ 位置输入框没找到（结构已存 state/loc-probe.json）；候选文本：`
        + `${hits.slice(0, 3).map(h => h.text.replace(/\n/g, '/')).join(' · ')}`)
      await shot(page, dir, '03b-location-nobox.png')
      return { ok: false, why: 'no-search-box' }
    }

    await box.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { })
    await box.click({ timeout: 6000 })
    await page.waitForTimeout(900)

    /* 🔴 面板顶部有「深圳 | 广州」城市 tab，默认跟着网络定位走（这台机器在深圳），
     *    不切城市就永远只返回深圳的 POI —— 搜「广东工业大学」出来的全是深圳分院，
     *    甚至「大学城校区」会命中深圳的毛毛虫英语（见 state/loc-options.json）。
     *    先切到广州，再搜。 */
    try {
      const cityTab = page.getByText('广州', { exact: true }).first()
      if (await cityTab.count()) {
        await cityTab.click({ timeout: 4000 })
        await page.waitForTimeout(1400)
        step('位置面板已切到「广州」')
      }
    } catch { /* 切不了就按原样搜，反正后面严格匹配兜底 */ }

    /* ③ 搜索 + 选结果。
     * 🔴 抖音的 POI 搜索按**当前网络位置**排：在这台机器上搜「广东工业大学」，
     *    返回的全是深圳的分院/研究院，一条广州的都没有（见 state/loc-options.json）。
     *    所以不能只搜一次 —— 搜不到就换带城市/校区的词再试。 */
    const campus = (keyword.match(/[（(]([^）)]+)[）)]/) || [])[1] || ''
    const terms = [...new Set([search, `${search}${campus}`, `广州 ${search}`, campus || '大学城',
      '广州市番禺区大学城外环西路100号'].filter(Boolean))].slice(0, 5)

    let hitOpts = null
    let hitIdx = -1
    let picked = ''
    const tried = []

    for (const term of terms) {
      await box.fill('').catch(() => { })
      await box.fill(term).catch(async () => { await page.keyboard.type(term, { delay: 50 }) })
      await page.waitForTimeout(2600)

      const opts = page.locator('.semi-select-option, [role="option"]')
      const n = Math.min(await opts.count(), 20)
      if (!n) { tried.push({ term, all: [] }); continue }

      const all = []
      for (let i = 0; i < n; i++) all.push((await opts.nth(i).innerText().catch(() => '')).trim())
      tried.push({ term, all })

      const idx = pickCampusIdx(all, campus)
      if (idx >= 0) { hitOpts = opts; hitIdx = idx; picked = all[idx]; break }
    }

    try {
      fs.writeFileSync(path.join(ROOT, 'state', 'loc-options.json'), JSON.stringify(tried, null, 1))
    } catch { /* 排查用，落不了盘不影响主流程 */ }

    if (hitIdx < 0) {
      const brief = (tried[0]?.all || []).slice(0, 3)
        .map(x => x.replace(/\n/g, ' ').slice(0, 26)).join(' | ')
      step(`⚠ 试了 ${terms.length} 个关键词都没搜到广州大学城校区（首词前几条：${brief || '无结果'}）`
        + '—— 不标位置，免得标到别的城市')
      await shot(page, dir, '03b-location-wrong.png')
      return { ok: false, why: 'no-match', options: tried.map(t => ({ term: t.term, n: t.all.length })) }
    }

    await hitOpts.nth(hitIdx).click({ timeout: 6000 })
    await page.waitForTimeout(1800)

    /* 截图前把位置这一块滚进视口 —— 它在页面底部，不滚的话截到的还是封面区，
     * 人对着图看不出位置到底选上没有。 */
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('input')].find(i => /位置/.test(i.placeholder || ''))
      if (el) el.scrollIntoView({ block: 'center' })
    }).catch(() => { })
    await page.waitForTimeout(800)

    const shotPath = await shot(page, dir, '03b-location.png')
    step(`位置已选：${String(picked).trim().slice(0, 40) || keyword}`)
    return { ok: true, picked: String(picked).trim().slice(0, 60), shotPath }
  } catch (e) {
    step('⚠ 位置没加上（不阻塞投稿）：' + String(e && e.message || e).slice(0, 100))
    await shot(page, dir, '03b-location-fail.png')
    return { ok: false, why: String(e && e.message || e).slice(0, 120) }
  }
}

/**
 * 上传自定义封面。
 *
 * 抖音默认从视频里抽一帧当封面，但成片目录里已经有做好的 cover.png
 * （带 DAY 号、大标题、皮套），比抽帧好看得多。
 * 流程：点「设置封面」→ 弹窗里上传 → 裁剪确认。同样尽力而为，失败不阻塞发布。
 */
async function setCover(page, dir, step, coverPath) {
  if (!coverPath || !fs.existsSync(coverPath)) return { ok: false, skipped: true }
  try {
    /* 🔴 入口不是「设置封面」那四个字（那是区块标题，点了没反应），
     *    是下面两个占位方块里的「选择封面」—— 横屏视频用第一个（横封面 4:3）。 */
    let entry = page.getByText(/^选择封面$/).first()
    if (!(await entry.count())) entry = page.getByText(/^设置封面$/).first()
    if (!(await entry.count())) {
      step('⚠ 没找到「选择封面」入口，封面保持抖音自动抽帧')
      return { ok: false, why: 'no-entry' }
    }
    await entry.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { })
    await entry.click({ timeout: 6000 })
    await page.waitForTimeout(2400)

    /* 🔴 用 accept 认封面输入框：视频上传那个是 accept="video/*"，封面是 image/*。
     *    按「弹窗里找」或「取 last()」都可能摸到视频上传口 ——
     *    一旦塞错就是整条视频重新传一遍。 */
    let fi = page.locator('input[type=file][accept*="image"]').last()
    if (!(await fi.count())) {
      const btn = page.getByText(/上传封面|本地上传|上传图片/).first()
      if (await btn.count()) {
        await btn.click({ timeout: 5000 }).catch(() => { })
        await page.waitForTimeout(1500)
        fi = page.locator('input[type=file][accept*="image"]').last()
      }
    }
    if (!(await fi.count())) {
      const dialog = page.locator('.semi-modal, [role="dialog"]').last()
      const txt = await dialog.innerText().catch(() => '')
      step('⚠ 封面弹窗里没找到上传入口：' + String(txt).replace(/\s+/g, ' ').slice(0, 100))
      await shot(page, dir, '03c-cover-noentry.png')
      return { ok: false, why: 'no-file-input' }
    }

    await fi.setInputFiles(coverPath)
    await page.waitForTimeout(3500)
    await shot(page, dir, '03c-cover-crop.png')

    /* 裁剪界面确认。文案各版本不一，挨个试 */
    for (const name of ['确定', '完成', '确认', '保存']) {
      const b = page.getByRole('button', { name, exact: true }).last()
      if (await b.count()) { await b.click({ timeout: 5000 }).catch(() => { }); break }
    }
    await page.waitForTimeout(2200)
    const shotPath = await shot(page, dir, '03c-cover.png')
    step('封面已上传（自定义）')
    return { ok: true, shotPath }
  } catch (e) {
    step('⚠ 封面上传失败（不阻塞）：' + String(e && e.message || e).slice(0, 100))
    await shot(page, dir, '03c-cover-fail.png')
    return { ok: false, why: String(e && e.message || e).slice(0, 120) }
  }
}

/** 定时发布：把「立即发布」切成「定时发布」并填好时间。
 *
 *  这是**减少验证码打扰的关键**：一次上传、一次验证，抖音自己在指定时间发出去，
 *  不用到点再跑一遍浏览器（跑一次就可能弹一次码）。业界最大的开源项目
 *  social-auto-upload 也是这么做的，选择器直接照抄它的（同一套 semi-design 组件）。
 *
 *  抖音的限制：最早 2 小时后，最晚 14 天内 —— 超范围它会自己把时间改掉或者报错，
 *  所以这里先挡一道，别让一个非法时间静默变成「立即发布」。
 *
 *  @param when "2026-11-02 19:00"；空值 = 立即发布，直接跳过
 */
async function setSchedule(page, dir, step, when) {
  if (!when) return { ok: false, skipped: true }

  const m = String(when).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/)
  if (!m) {
    step(`⚠ 定时时间格式不对（要 "YYYY-MM-DD HH:mm"），这次按立即发布走：${when}`)
    return { ok: false, why: 'bad-format' }
  }
  const [, Y, Mo, D, H, Mi] = m
  const at = new Date(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Mi), 0, 0)
  if (Number.isNaN(at.getTime())) {
    step('⚠ 定时时间解析失败，按立即发布走')
    return { ok: false, why: 'bad-date' }
  }

  const diffMin = (at.getTime() - Date.now()) / 60000
  if (diffMin < 115) {
    step(`⚠ 定时时间只差 ${Math.round(diffMin)} 分钟 —— 抖音要求至少 2 小时后，按立即发布走`)
    return { ok: false, why: 'too-soon' }
  }
  if (diffMin > 14 * 24 * 60) {
    step('⚠ 定时时间超过 14 天 —— 抖音不接受，按立即发布走')
    return { ok: false, why: 'too-far' }
  }

  const stamp = `${Y}-${String(Mo).padStart(2, '0')}-${String(D).padStart(2, '0')} ${String(H).padStart(2, '0')}:${Mi}`

  try {
    /* ① 切到「定时发布」。radio 的 class 以 radio 开头，用 has-text 命中整行 */
    let radio = page.locator("[class^='radio']:has-text('定时发布')").first()
    if (!(await radio.count())) {
      radio = page.getByText('定时发布', { exact: true }).first()
    }
    if (!(await radio.count())) {
      step('⚠ 没找到「定时发布」选项（页面可能改版），按立即发布走')
      await shot(page, dir, '03d-schedule-noentry.png')
      return { ok: false, why: 'no-radio' }
    }
    await radio.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { })
    await radio.click({ timeout: 6000 })
    await page.waitForTimeout(1200)

    /* ② 填时间。semi 的日期选择器是 input + 弹层，先全选再输入，最后回车收面板 */
    let box = page.locator('.semi-input[placeholder="日期和时间"]').first()
    if (!(await box.count())) box = page.locator('input[placeholder*="日期"]').first()
    if (!(await box.count())) {
      step('⚠ 定时时间输入框没找到，按立即发布走')
      await shot(page, dir, '03d-schedule-nobox.png')
      return { ok: false, why: 'no-time-input' }
    }
    await box.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => { })
    await box.click({ timeout: 6000 })
    await page.keyboard.press('Control+KeyA').catch(() => { })
    await box.fill(stamp).catch(async () => { await page.keyboard.type(stamp, { delay: 30 }) })
    await page.waitForTimeout(800)
    await page.keyboard.press('Enter').catch(() => { })
    await page.waitForTimeout(1500)
    /* 🔴 日历弹层填完不会自己收（实测截图里还悬在页面中间），它会盖住底部的
     *    「发布」按钮。按 Escape 收掉再回读，不然确认那步点不动。 */
    await page.keyboard.press('Escape').catch(() => { })
    await page.waitForTimeout(700)

    /* ③ 回读校验 —— 输入被弹层吞掉是常事，读到的不对就当失败，别让「定时」变「立即」 */
    const shown = await box.inputValue().catch(() => '')
    const shotPath = await shot(page, dir, '03d-schedule.png')
    if (!/\d{4}-\d{2}-\d{2}/.test(shown)) {
      step(`⚠ 定时时间没填进去（读回来是「${shown}」）—— 这条会按立即发布`)
      return { ok: false, why: 'not-applied', shown }
    }
    step(`定时发布已设置：${shown}`)
    return { ok: true, at: shown, shotPath }
  } catch (e) {
    step('⚠ 定时发布设置失败（不阻塞，按立即发布）：' + String(e && e.message || e).slice(0, 100))
    await shot(page, dir, '03d-schedule-fail.png')
    return { ok: false, why: String(e && e.message || e).slice(0, 120) }
  }
}

/* ── AI 生成内容声明 ────────────────────────────────────────────
 * 《人工智能生成合成内容标识办法》2025-09-01 起强制施行：
 * 平台侧要勾选"内容由 AI 生成"的声明，否则可能限流/下架。
 * 抖音入口在「高级设置 → 作品声明 → 内容由 AI 生成」。
 *
 * 这是**尽力而为但必须留痕**的一步：勾不上不能悄悄放过，
 * 要在 dry-run 的步骤里喊出来，让人在点确认前手动补。 */
async function declareAiGenerated(page, dir, step) {
  try {
    /* 先找「高级设置」把折叠区展开 */
    const adv = page.getByText('高级设置', { exact: true }).first()
    if (await adv.count()) {
      await adv.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => { })
      await adv.click({ timeout: 4000 }).catch(() => { })
      await page.waitForTimeout(1200)
    }

    /* 「作品声明」区块里的「内容由 AI 生成」勾选项 */
    const AI_RE = /内容由\s*AI\s*生成|AI\s*生成内容|人工智能生成/
    let clicked = false
    for (const scope of [
      () => page.getByText(AI_RE).first(),
      () => page.getByRole('checkbox', { name: AI_RE }).first(),
      () => page.locator(`label:has-text("AI")`).first(),
    ]) {
      const el = scope()
      if (!(await el.count())) continue
      try {
        await el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => { })
        await el.click({ timeout: 5000 })
        await page.waitForTimeout(800)
        clicked = true
        break
      } catch { /* 试下一种定位 */ }
    }

    const shotPath = await shot(page, dir, '03e-ai-declare.png')
    if (clicked) {
      step('已勾选「内容由 AI 生成」声明（合规要求）')
      return { ok: true, shotPath }
    }
    /* 找不到就明确喊出来 —— 合规项不能静默跳过 */
    step('⚠ 没找到「内容由 AI 生成」声明入口 —— 点确认前请在页面上手动勾选（合规要求）')
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
    if (!video || !fs.existsSync(video)) throw new Error(`视频文件不存在：${video}`)

    /* 一个平台同时只允许一条投稿在等确认 —— 两条会抢同一个 context 和上传页 */
    const busy = findAwaitingConfirm({ platform: 'douyin', kind: 'publish' })
    if (busy && busy.id !== job.id) {
      throw new Error(`抖音已经有一条投稿在等确认（${busy.id}「${String(busy.title).slice(0, 24)}」）—— 先确认或撤销它，别同时开两条`)
    }

    return guardedWrite('douyin', {
      checkAlive: async () => {
        const { ctx } = await pickBrowser(p)
        return session.checkAlive(ctx)
      },
      write: async () => {
        step(p.headed ? '打开抖音创作者上传页（有头窗口）' : '打开抖音创作者上传页（真人浏览器接管）')
        const { ctx } = await pickBrowser(p)
        /* 🔴 newPage 必须在本函数自己的 try 里兜底关掉。
         *    以前 openUploadPage 在 try 之外，goto 一超时（j1793539312903 就是）
         *    那张页就泄漏了，和「标签页越攒越多最后直接导航超时」形成正反馈。 */
        let page
        try {
          page = await openUploadPage(ctx)
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
          /* 🔴 抖音上传页是「作品标题」独立输入框 + 正文 contenteditable 两个控件。
           *    以前只填正文，标题 20+ 次投稿全白传 —— p.title 被塞进正文当第一行，
           *    发出去标题栏是空的。先填标题框，填不到再退回老办法（并留痕）。 */
          const titleText = String(p.title || '').trim().slice(0, 30)
          let titleFilled = false
          if (titleText) {
            const titleSel = [
              'input[placeholder*="标题"]',
              'input[placeholder*="填写标题"]',
              '.semi-input[placeholder*="标题"]',
            ]
            for (const sel of titleSel) {
              const box = page.locator(sel).first()
              if (!(await box.count())) continue
              try {
                await box.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => { })
                await box.click({ timeout: 5000 })
                await box.fill(titleText)
                await page.waitForTimeout(400)
                titleFilled = true
                break
              } catch { /* 试下一个选择器 */ }
            }
            if (!titleFilled) {
              /* 兜底：页面里所有可见 input 里找最像标题的那个 */
              try {
                titleFilled = await page.evaluate((t) => {
                  const ins = [...document.querySelectorAll('input[type=text],input:not([type])')]
                  for (const el of ins) {
                    const ph = String(el.getAttribute('placeholder') || '')
                    if (!/标题|主题/.test(ph)) continue
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
                    setter.call(el, t)
                    el.dispatchEvent(new Event('input', { bubbles: true }))
                    return true
                  }
                  return false
                }, titleText)
              } catch { /* 放弃，走老路 */ }
            }
            step(titleFilled ? `标题已填：${titleText}` : '⚠ 没找到标题输入框，标题只能进正文（发出去标题栏会是空的）')
          }

          // 抖音：声明文案（正文）是一个 contenteditable
          /* 地点先写进正文 —— POI 那一步是尽力而为（抖音按网络位置过滤 POI，
           * 跨城市经常搜不到，实测见 state/loc-options.json），正文这句才是保底，
           * 保证「标注地点」这件事一定成立。 */
          const locLine = p.location ? `\n\n📍${String(p.location).slice(0, 40)}` : ''
          /* 标题已经单独填过，正文就别再把 title 当第一行重复一遍 */
          const body = (String(p.desc || (titleFilled ? '' : p.title) || '') + locLine).slice(0, 1000)
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

          /* 封面：用成片目录里的 cover.png，比抖音自动抽帧好看 */
          const cov = await setCover(page, dir, step, p.cover)

          /* 地点：尽力而为，失败不阻塞 */
          const loc = await addLocation(page, dir, step, p.location)

          /* 定时发布：一次上传管一天的关键。设不上就退回立即发布，不阻塞 */
          const sch = await setSchedule(page, dir, step, p.scheduleAt)

          /* AI 生成内容声明 —— 合规硬要求，不是可选项。
           * 《人工智能生成合成内容标识办法》2025-09-01 起强制施行：
           * 显式标识 + 元数据隐式标识。不勾选可能被限流甚至下架。
           * 抖音入口在「高级设置 → 作品声明」里，做成尽力而为 + 明确留痕：
           * 勾不上就在 dry-run 步骤里喊出来，让人在确认前手动补。 */
          const aiDecl = await declareAiGenerated(page, dir, step)

          /* addLocation 会把页面停在底部的位置区，回顶部再截主图 */
          await page.evaluate(() => window.scrollTo(0, 0)).catch(() => { })
          await page.waitForTimeout(600)

          /* 预检「发布」按钮：dry-run 阶段就把定位验掉，别等人点了确认才发现
           * 找不到按钮 / 匹配到一堆。只数不点，一个字节都不发。
           * 🔴 设了定时发布之后，主按钮文字会变成「定时发布」，两个都数一遍。 */
          try {
            const nNow = await page.getByRole('button', { name: '发布', exact: true }).count()
            const nSch = await page.getByRole('button', { name: '定时发布', exact: true }).count()
            const n = Math.max(nNow, nSch)
            step(n === 1
              ? `发布按钮定位正常（确认后即可点${sch && sch.ok ? '，定时发布' : ''}）`
              : `⚠ 发布按钮匹配到 ${n} 个（期望 1）—— 确认前先看一眼截图`)
          } catch (e) {
            step('⚠ 发布按钮没找到：' + String(e.message || e).slice(0, 80))
          }

          const shotPath = await shot(page, dir, '03-dry-run.png')
          kept.set(job.id, { page })
          logEvent('douyin', 'publish.dryrun', {
            ok: true, jobId: job.id, title: p.title,
            location: loc && loc.ok ? loc.picked : '',
            scheduleAt: sch && sch.ok ? sch.at : '',
            aiDeclared: aiDecl && aiDecl.ok === true,
            titleFilled,
          })
          awaitConfirm({
            platform: 'douyin', kind: 'publish', title: p.title,
            screenshots: [shotPath, ...(loc && loc.shotPath ? [loc.shotPath] : []),
              ...(cov && cov.shotPath ? [cov.shotPath] : []),
              ...(sch && sch.shotPath ? [sch.shotPath] : []),
              ...(aiDecl && aiDecl.shotPath ? [aiDecl.shotPath] : [])],
            dir,
            location: loc && loc.ok ? loc.picked : null,
            cover: cov && cov.ok ? 'custom' : 'auto',
            scheduleAt: sch && sch.ok ? sch.at : null,
            titleFilled,
            aiDeclared: aiDecl && aiDecl.ok === true,
            /* 合规项没做成必须在人眼前明说，不能混在一堆 step 里 */
            warnings: [
              ...(aiDecl && aiDecl.ok !== true ? ['「内容由 AI 生成」声明没勾上 —— 点确认前请手动勾选（合规要求）'] : []),
              ...(titleFilled ? [] : ['没找到标题输入框，标题栏可能是空的']),
            ],
            note: sch && sch.ok
              ? `视频已传完、表单已填好，定时 ${sch.at} 自动发布。确认后点一下按钮就收工，到点抖音自己发。`
              : '视频已传完、表单已填好，停在「发布」按钮前。确认前别关服务（那个页面还开着）。',
          })
          return { dryRun: true, location: loc, cover: cov, schedule: sch, aiDeclare: aiDecl, titleFilled }
        } catch (e) {
          /* 出错就把这张页关掉，别留给下一条任务去捡 */
          closeKept(job.id)
          if (page) await page.close().catch(() => { })
          throw e
        }
      },
    })
  }

  return guardedWrite('douyin', {
    checkAlive: async () => {
      const k = kept.get(job.id)
      /* 🔴 必须带 soft:true。页面丢了是"这一轮做不了"，不是"账号掉线"——
       *    不带 soft 的话 breaker.mjs 会直接 trip() 熔断到当天 23:59，
       *    于是「dry-run 之后重启了一次服务，再点确认」= 当天所有写操作全废。 */
      if (!k) return { ok: false, soft: true, why: 'dry-run 的页面丢了（服务重启过）—— 重新发起一次投稿' }
      return session.checkAlive(k.page.context())
    },
    write: async () => {
      const k = kept.get(job.id)
      const { page } = k
      try {
        step('已确认，检查状态后点「发布」')
        /* dry-run 结束时位置面板可能是展开的，先收掉再点，免得挡住按钮 */
        await page.keyboard.press('Escape').catch(() => { })
        await page.waitForTimeout(500)
        /* 从 dry-run 到人点确认之间可能隔了几分钟，再确认一次片子还在、没被关掉 */
        await waitUploadDone(page, 180000)
        await shot(page, dir, '04-before-publish.png')
        /* 🔴 必须 exact —— 左侧导航第一项是「作品发布」，非精确匹配会先命中它，
         *    点了就跳到作品列表页，人还以为发出去了。
         *    另外别用 isDisabled 判断：实测上传中这个按钮也是可点的。
         *    设了定时发布之后主按钮文字变成「定时发布」，先认它，别点成立即发。 */
        let btn = page.getByRole('button', { name: '定时发布', exact: true }).first()
        if (!(await btn.count())) btn = page.getByRole('button', { name: '发布', exact: true }).first()
        await btn.waitFor({ state: 'visible', timeout: 30000 })
        await btn.click()
        await page.waitForTimeout(4000)

        const pageText = () => page.evaluate(() => document.body ? document.body.innerText.slice(0, 3000) : '')
        const SMS_RE = /短信验证码|请输入验证码|安全验证|身份验证/

        /* 🔴 抖音点「发布」后会弹「接收短信验证码」—— 这是风控，不是失败。
         *    实测（2026-11-01 第一次真发）就卡在这里：脚本等 8 秒没看到成功提示
         *    就判失败、关掉页面，其实视频压根没发出去。
         *    这一步只能账号主人自己输验证码，所以：
         *      · 有头模式：把窗口留给用户，最多等 5 分钟
         *      · 真无头：直接说清楚，别让人以为失败了又去点一次
         *
         *    🔴 别用 p.headed 判断 —— liveMode 下 pickBrowser 走 attachLive，
         *       headed 参数被完全忽略，窗口其实是可见的。以前按 p.headed 判，
         *       默认参数（headed 未传）遇验证码必然误判成"无头，放弃"。
         *       要看真实窗口状态：问浏览器自己。 */
        if (SMS_RE.test(await pageText())) {
          await shot(page, dir, '05-need-sms.png')
          const windowVisible = await isWindowVisible(page, p)
          if (!windowVisible) {
            throw new Error('抖音要求短信验证码，但这次是无头模式（看不到窗口）—— 用 headed:true 或开 chrome.liveMode 重新发起')
          }
          step('⚠ 抖音要求短信验证码 —— 请在弹出的浏览器窗口里输入手机收到的验证码（最多等 5 分钟）')

          let passed = false
          for (let i = 0; i < 60; i++) {
            await page.waitForTimeout(5000)
            const t = await pageText().catch(() => '')
            const url = page.url()
            if (PUBLISHED_RE.test(t) || /content\/manage/.test(url)) { passed = true; break }
            if (!t) break   // 页面没了
          }
          if (!passed) {
            await shot(page, dir, '05-sms-timeout.png')
            throw new Error('等了 5 分钟没等到验证码通过 —— 页面还开着，可以在窗口里手动点「验证」再发布')
          }
          step('验证码已通过')
          await page.waitForTimeout(4000)
        }

        await page.waitForTimeout(3000)
        const shotPath = await shot(page, dir, '05-published.png')
        const body = await pageText()
        /* 🔴 成功判定不能用裸 /审核/ —— 上传页本身就常驻「审核」字样
         *    （「审核通过后…」的提示语），误判成功后立刻 page.close()，
         *    结果是假成功 + 重复投稿。只认明确的成功短语或跳转到内容管理页。 */
        const ok = PUBLISHED_RE.test(body) || /content\/manage/.test(page.url())
        logEvent('douyin', 'publish.done', { ok, jobId: job.id, title: job.params.title, url: page.url() })
        if (!ok) throw new Error('点了发布但没看到成功提示 —— 看 05 截图确认，别重复点')
        /* 成功才关页面。失败（尤其是卡在验证码）时页面要留着 ——
         * 用户还得在那个窗口里继续操作，关掉就前功尽弃。 */
        closeKept(job.id)
        await page.close().catch(() => { })
        return { published: true, screenshot: shotPath }
      } catch (e) {
        /* 故意不在这里关页面：失败最可能是卡在短信验证码上，
         * 用户还要在那个窗口里继续操作。关掉就前功尽弃。 */
        throw e
      }
    },
  })
}
