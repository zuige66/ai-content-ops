/* douyin/comment.mjs —— 抖音评论（🔴 默认关闭）
 * ═══════════════════════════════════════════════════════════════
 * 红线：评论区是风控最严的写操作。三重闸全开才放行：
 *   1. config.json 的 comment.enabledOn.douyin === true（默认 false）
 *   2. 任务必须带 confirm（走 /jobs/:id/confirm 的两段式）
 *   3. 熔断器（写前体检 + 60s 限速 + 写后复检）
 * 白名单：只允许回**自己**视频下的评论（视频 URL/ID 由人工填进 params）。
 * 实现走「页面上下文 fetch credentials:include」—— dsh 实测外部签名会 403。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'
import { readConfig } from '../core/shell.mjs'
import { launchPersistent } from '../core/browser.mjs'
import { guardedWrite } from '../core/breaker.mjs'
import * as session from './session.mjs'

export function enabled() {
  const cfg = readConfig().comment || {}
  return cfg.enabledOn?.douyin === true
}

export async function comment(job, { step, awaitConfirm }) {
  if (!enabled()) throw new Error('抖音评论默认关闭 —— config.json 里 comment.enabledOn.douyin 设 true 才放行')
  const p = job.params
  if (!p.confirmed) {
    awaitConfirm({
      platform: 'douyin', kind: 'comment',
      target: p.awemeId, text: p.text,
      note: `将在视频 ${p.awemeId} 下发评论。确认前不会发。`,
    })
    return { dryRun: true }
  }
  if (!/^\d+$/.test(String(p.awemeId || ''))) throw new Error('白名单：awemeId 必须是自己视频的数字 ID（人工填进参数）')
  return guardedWrite('douyin', {
    checkAlive: async () => {
      const { ctx } = await launchPersistent('douyin', { headless: true })
      return session.checkAlive(ctx)
    },
    write: async () => {
      step('页面上下文发评论')
      const { ctx } = await launchPersistent('douyin', { headless: true })
      const page = ctx.pages().find(x => x.url().includes('douyin.com')) || await ctx.newPage()
      await page.goto(`https://www.douyin.com/video/${p.awemeId}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
      const r = await page.evaluate(async ({ awemeId, text }) => {
        try {
          // 页面自己的签名 SDK 会给请求补 a_bogus —— 这条路实测 200 不弹验证
          const res = await fetch('https://www.douyin.com/aweme/v1/web/comment/publish/?device_platform=webapp&aid=6383', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ aweme_id: awemeId, text, comment_type: 0 }).toString(),
          })
          const j = await res.json().catch(() => null)
          return { ok: res.ok && j && j.status_code === 0, why: j && j.status_msg || `HTTP ${res.status}` }
        } catch (e) { return { ok: false, why: String(e).slice(0, 120) } }
      }, { awemeId: p.awemeId, text: String(p.text).slice(0, 100) })
      logEvent('douyin', 'comment.send', { ok: r.ok, jobId: job.id, awemeId: p.awemeId, why: r.why })
      if (!r.ok) throw new Error(`评论没发出去：${r.why}（不重试，风控面前退一步）`)
      return { sent: true }
    },
  })
}
