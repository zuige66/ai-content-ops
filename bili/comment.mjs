/* bili/comment.mjs —— B站评论（🔴 默认关闭，与 douyin/comment 同构的三重闸） */
import { readConfig } from '../core/shell.mjs'
import { launchPersistent } from '../core/browser.mjs'
import { guardedWrite } from '../core/breaker.mjs'
import * as session from './session.mjs'
import { logEvent } from '../core/log.mjs'

export function enabled() {
  const cfg = readConfig().comment || {}
  return cfg.enabledOn?.bili === true
}

export async function comment(job, { step, awaitConfirm }) {
  if (!enabled()) throw new Error('B站评论默认关闭 —— config.json 里 comment.enabledOn.bili 设 true 才放行')
  const p = job.params
  if (!p.confirmed) {
    awaitConfirm({
      platform: 'bili', kind: 'comment',
      target: p.oid, text: p.text,
      note: `将在 av${p.oid} 下发评论。确认前不会发。`,
    })
    return { dryRun: true }
  }
  if (!/^\d+$/.test(String(p.oid || ''))) throw new Error('白名单：oid 必须是自己视频的 av 号（人工填进参数）')
  return guardedWrite('bili', {
    checkAlive: async () => {
      const { ctx } = await launchPersistent('bili', { headless: true })
      return session.checkAlive(ctx)
    },
    write: async () => {
      step('页面上下文发评论')
      const { ctx } = await launchPersistent('bili', { headless: true })
      const page = ctx.pages().find(x => x.url().includes('bilibili.com')) || await ctx.newPage()
      await page.goto(`https://www.bilibili.com/video/av${p.oid}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
      const r = await page.evaluate(async ({ oid, text }) => {
        try {
          // B站评论走社区接口，页面上下文带 csrf；旧版接口形态，失败就如实报错不硬扛
          const csrf = (document.cookie.match(/bili_jct=([^;]+)/) || [])[1] || ''
          const fd = new URLSearchParams({ oid: String(oid), type: '1', message: text, csrf, plat: '1', web_location: '1315875' })
          const res = await fetch('https://api.bilibili.com/x/v2/reply/add', {
            method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: fd.toString(),
          })
          const j = await res.json().catch(() => null)
          return { ok: res.ok && j && j.code === 0, why: j && j.message || `HTTP ${res.status}` }
        } catch (e) { return { ok: false, why: String(e).slice(0, 120) } }
      }, { oid: p.oid, text: String(p.text).slice(0, 300) })
      logEvent('bili', 'comment.send', { ok: r.ok, jobId: job.id, oid: p.oid, why: r.why })
      if (!r.ok) throw new Error(`评论没发出去：${r.why}（不重试）`)
      return { sent: true }
    },
  })
}
