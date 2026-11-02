/* douyin/manage.mjs —— 抖音写操作：回复评论 / 打开编辑页
 * ═══════════════════════════════════════════════════════════════
 * 红线照旧：写操作两段式（dry-run → 人工确认）+ 熔断器 + 限速。
 *
 * 🔴 回复接口（2026-11-02 实测抓包重写，旧的那套已经废了）：
 *   旧：POST /aweme/v1/creator/comment/reply/  form{comment_Id,item_id,text}
 *       → 服务端一律回「参数不合法」，字段名早就变了，别再抄回去
 *   新：POST /aweme/janus/creator/comment/aweme/v1/web/comment/multi_publish/
 *       query: aweme_id=<明文数字>&text=<文本>&reply_to_comment_ids=<数字>&channel_id=618&aid=2906&device_platform=webapp
 *       body : {"aweme_id":"…","text":"…","reply_to_comment_ids":"…","channel_id":618}
 *       ⚠️ reply_to_comment_ids 要**数字** id（7703207823286764338 这种），
 *          不是 creator 评论列表里的加密串（@ivRu…==）。数字 id 只能从
 *          www 域 /aweme/v1/web/comment/list/ 拿 —— 见 insight.commentsWeb。
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
const PUBLISH_API = `${CREATOR}/aweme/janus/creator/comment/aweme/v1/web/comment/multi_publish/`

/** 把「加密 comment id」换成「数字 id」。发回复只认数字。 */
async function toNumCommentId(plainAwemeId, { commentId, commentIdNum }) {
  const direct = String(commentIdNum || '')
  if (/^\d+$/.test(direct)) return direct
  if (!commentId) return ''
  const list = await insight.comments(plainAwemeId, { count: 20, force: true })
  if (!list.ok) throw new Error(`拉评论失败，拿不到数字 id：${list.error}`)
  const hit = (list.comments || []).find(c => c.id === commentId)
  return (hit && hit.numId) || ''
}

/** 回复一条评论。confirm=false 时只回显将要发什么，一个字节都不发。 */
export async function reply({ itemId, commentId, commentIdNum, text, confirm }) {
  const body = String(text || '').trim()
  if (!body) throw new Error('回复内容不能为空')
  if (body.length > 100) throw new Error(`回复最多 100 字（现在 ${body.length} 字）`)
  if (!commentId && !commentIdNum) throw new Error('缺 commentId（加密串或数字 id 都行）')
  if (!itemId) throw new Error('缺 itemId（作品 id）')

  const it = await insight._internal.resolveItem(itemId)
  if (!it.id) throw new Error(it.error || '作品 id 认不出来')
  const awemeId = String(it.plain || itemId)
  if (!/^\d+$/.test(awemeId)) throw new Error('白名单：aweme_id 必须是自己作品的数字 id')

  const numId = await toNumCommentId(awemeId, { commentId, commentIdNum })
  if (!/^\d+$/.test(numId)) {
    throw new Error('拿不到这条评论的**数字** id —— creator 列表只给加密串，要 www 域评论接口配合；换个能配上的评论，或者直接用数字 id 调')
  }

  const payload = { aweme_id: awemeId, text: body, reply_to_comment_ids: numId, channel_id: 618 }

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
      const r = await page.evaluate(async ({ api, p }) => {
        try {
          /* 参数同时放 query 和 JSON body —— 抓包里就是这样，少一边可能被判参数不合法 */
          const qs = new URLSearchParams({
            aweme_id: p.aweme_id, text: p.text, reply_to_comment_ids: p.reply_to_comment_ids,
            channel_id: String(p.channel_id), aid: '2906', device_platform: 'webapp',
          }).toString()
          const res = await fetch(`${api}?${qs}`, {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(p),
          })
          const t = await res.text()
          let j = null; try { j = JSON.parse(t) } catch { }
          return { status: res.status, code: j && j.status_code, msg: (j && j.status_msg) || t.slice(0, 200) }
        } catch (e) { return { status: 0, msg: String(e).slice(0, 160) } }
      }, { api: PUBLISH_API, p: payload })
      logEvent('douyin', 'comment.reply', {
        ok: r.code === 0, commentId: numId, awemeId, len: body.length, why: r.code === 0 ? '' : r.msg,
      })
      if (r.code !== 0) throw new Error(`回复没发出去：${r.msg || 'HTTP ' + r.status}（不重试）`)
      insight.clearCache()
      return { sent: true, text: body, replyTo: numId }
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
