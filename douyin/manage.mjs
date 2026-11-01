/* douyin/manage.mjs —— 抖音写操作：回复评论 / 打开编辑页
 * ═══════════════════════════════════════════════════════════════
 * 红线照旧：写操作两段式（dry-run → 人工确认）+ 熔断器 + 限速。
 *
 * 回复评论走真接口，参数是从创作者后台 SDK 源码里读出来的：
 *   POST /aweme/v1/creator/comment/reply/
 *   form: { comment_Id, item_id, text }   ← 注意 comment_Id 是大写 I，照抄别改
 *
 * 🔴 编辑**不裸调** /web/api/media/aweme/update_v2：那个接口的入参结构没找到
 *    调用点，猜错字段名可能把已发布作品的封面/可见性洗掉。所以编辑只负责
 *    「把真实后台的编辑页给你打开」，改动在官方页面上做。
 * ═══════════════════════════════════════════════════════════════ */
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'
import { launchPersistent, getLive, liveHeadless } from '../core/browser.mjs'
import { guardedWrite } from '../core/breaker.mjs'
import * as session from './session.mjs'
import * as insight from './insight.mjs'

const CREATOR = 'https://creator.douyin.com'

/** 回复一条评论。confirm=false 时只回显将要发什么，一个字节都不发。 */
export async function reply({ itemId, commentId, text, confirm }) {
  const body = String(text || '').trim()
  if (!body) throw new Error('回复内容不能为空')
  if (body.length > 100) throw new Error(`回复最多 100 字（现在 ${body.length} 字）`)
  if (!commentId) throw new Error('缺 commentId')
  if (!itemId) throw new Error('缺 itemId（作品 id）')

  const it = await insight._internal.resolveItem(itemId)
  if (!it.id) throw new Error(it.error || '作品 id 认不出来')

  const payload = { comment_Id: commentId, item_id: it.id, text: body }

  if (!confirm) {
    return {
      dryRun: true,
      will: payload,
      note: '还没发。点确认才真发；抖音写操作有 60 秒限速。',
    }
  }

  return guardedWrite('douyin', {
    checkAlive: async () => {
      const { ctx } = await launchPersistent('douyin', { headless: true })
      return session.checkAlive(ctx)
    },
    write: async () => {
      // 有 context 就复用（可能是用户正开着的编辑窗口），别再起一个把人家关了
      const ctx = getLive('douyin') || (await launchPersistent('douyin', { headless: true, pinned: true })).ctx
      const page = ctx.pages().find(x => x.url().includes('creator.douyin.com')) || await ctx.newPage()
      if (!page.url().includes('creator.douyin.com')) {
        await page.goto(`${CREATOR}/creator-micro/interactive/comment`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
        await page.waitForTimeout(1500)
      }
      const r = await page.evaluate(async (p) => {
        try {
          const res = await fetch('https://creator.douyin.com/aweme/v1/creator/comment/reply/', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(p).toString(),
          })
          const t = await res.text()
          let j = null; try { j = JSON.parse(t) } catch { }
          return { status: res.status, code: j && j.status_code, msg: (j && j.status_msg) || t.slice(0, 200) }
        } catch (e) { return { status: 0, msg: String(e).slice(0, 160) } }
      }, payload)
      logEvent('douyin', 'comment.reply', {
        ok: r.code === 0, commentId, itemId: it.plain || itemId, len: body.length, why: r.code === 0 ? '' : r.msg,
      })
      if (r.code !== 0) throw new Error(`回复没发出去：${r.msg || 'HTTP ' + r.status}（不重试）`)
      insight.clearCache()
      return { sent: true, text: body }
    },
    verify: async () => {
      const { ctx } = await launchPersistent('douyin', { headless: true })
      return session.checkAlive(ctx)
    },
  })
}

/** 打开某条作品的真实编辑页（有头浏览器）。改动在官方页面上做，不猜接口。 */
export async function openEditor({ itemId } = {}) {
  // 已经开着的**有头**窗口直接复用（用户可能正开着编辑页）；无头的不算，得换成有头
  const cur = getLive('douyin')
  const ctx = (cur && liveHeadless('douyin') === false)
    ? cur
    : (await launchPersistent('douyin', { headless: false })).ctx
  const page = ctx.pages().find(x => x.url().includes('creator.douyin.com')) || await ctx.newPage()
  const target = itemId
    ? `${CREATOR}/creator-micro/content/manage?from=zhibo-auto&focus=${encodeURIComponent(itemId)}`
    : `${CREATOR}/creator-micro/content/manage`
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => { })
  await page.waitForTimeout(2500)
  await page.bringToFront().catch(() => { })
  /* 🔴 截图别放 video/out —— 那儿是成片目录，混一张调试截图进去，
   *    成片库扫目录时看着乱。state/ 才是放这类留痕的地方。 */
  const shot = path.join(ROOT, 'state', 'edit-open.png')
  await page.screenshot({ path: shot }).catch(() => { })
  logEvent('douyin', 'edit.open', { ok: true, itemId: itemId || '' })
  return {
    ok: true,
    opened: true,
    url: page.url(),
    shot,        // 本地绝对路径，人自己去看；/media/ 只挂 video/out，发不出去
    note: '已弹出有头浏览器，在作品那一行点「编辑」。接口层的 update_v2 入参没验证过，不代发。',
  }
}
