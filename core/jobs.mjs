/* core/jobs.mjs —— 串行任务队列 + 确认闸
 * ═══════════════════════════════════════════════════════════════
 * 为什么串行：单账号、低频是红线，批量并发是找死。视频合成也吃 CPU，
 * 一次跑一个，后来者排队。
 * 状态机：pending → running → done | failed
 *         running ─(写操作 dry-run 走完)→ awaiting-confirm ─(人工 /jobs/:id/confirm)→ running 续跑
 * 任务记录落 state/jobs.json，重启不丢历史；跑着的那条重启标记 failed。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from './log.mjs'

const STORE = path.join(ROOT, 'state', 'jobs.json')

let jobs = load()
let running = null
let seq = Date.now()

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(STORE, 'utf8'))
    // 上次进程退出时还在跑的，如实标记：进程死了就是失败，别假装还活着
    for (const j of list) {
      if (j.status === 'running' || j.status === 'pending') {
        j.status = 'failed'
        j.error = '服务重启，任务中断'
      }
    }
    return list
  } catch { return [] }
}

function save() {
  fs.mkdirSync(path.dirname(STORE), { recursive: true })
  fs.writeFileSync(STORE, JSON.stringify(jobs.slice(-500), null, 1), 'utf8')
}

export function listJobs({ platform, limit = 50 } = {}) {
  let out = jobs
  if (platform) out = out.filter(j => j.platform === platform)
  return out.slice(-limit).reverse()
}

export function getJob(id) { return jobs.find(j => j.id === id) }

export function step(id, msg, extra = {}) {
  const j = getJob(id)
  if (!j) return
  j.steps.push({ t: new Date().toISOString(), msg, ...extra })
  j.updatedAt = Date.now()
  save()
  logEvent(j.platform || 'core', `job.${j.kind}`, { ok: true, jobId: id, msg, ...extra })
}

export function enqueue({ kind, platform, title, params }) {
  const j = {
    id: `j${++seq}`,
    kind, platform: platform || 'core', title,
    params,
    status: 'pending',
    steps: [],
    result: null,
    error: null,
    confirmToken: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  jobs.push(j)
  save()
  pump()
  return j
}

/** awaitConfirm：写操作 dry-run 走完，停在发布前，等人点头。
 *  确认后任务**重新入队**（params.confirmed=true），处理器自己走第二段 ——
 *  这比把挂起的 promise 续上简单可靠：重启也不怕，大不了重新 dry-run。 */
export function awaitConfirm(j, summary) {
  j.status = 'awaiting-confirm'
  j.confirmToken = `c${++seq}`
  j.result = summary        // 截图路径、填了什么 —— 人看的就是这个
  j.updatedAt = Date.now()
  save()
  logEvent(j.platform, 'job.awaitConfirm', { ok: true, jobId: j.id, title: j.title })
}

export function resolveConfirm(id, ok) {
  const j = getJob(id)
  if (!j || j.status !== 'awaiting-confirm') return null
  j.confirmToken = null
  j.updatedAt = Date.now()
  if (!ok) {
    j.status = 'failed'
    j.error = '人工撤销'
    save()
    logEvent(j.platform, 'job.cancel', { ok: false, jobId: id })
    return j
  }
  j.params = { ...j.params, confirmed: true }
  j.status = 'pending'
  save()
  logEvent(j.platform, 'job.confirm', { ok: true, jobId: id })
  pump()
  return j
}

/* 队列泵：一次只跑一个。awaiting-confirm 的任务占着坑等确认 ——
   写操作本来就该全神贯注，队列里排后面的自然等着。 */
const queue = []
export function register(kind, fn) { handlers[kind] = fn }
const handlers = {}

function pump() {
  if (running) return
  const next = jobs.find(j => j.status === 'pending')
  if (!next) return
  running = next
  next.status = 'running'
  next.updatedAt = Date.now()
  save()
  const h = handlers[next.kind]
  if (!h) {
    next.status = 'failed'; next.error = `没有 ${next.kind} 的处理器`; running = null; save(); pump(); return
  }
  Promise.resolve()
    .then(() => h(next, {
      step: (msg, extra) => step(next.id, msg, extra),
      awaitConfirm: (summary) => awaitConfirm(next, summary),
    }))
    .then(result => {
      if (getJob(next.id).status !== 'awaiting-confirm') {
        next.status = 'done'
        next.result = result ?? next.result
        next.updatedAt = Date.now()
      }
      running = null
      save()
      pump()
    })
    .catch(e => {
      next.status = 'failed'
      next.error = String(e && e.message || e).slice(0, 500)
      next.updatedAt = Date.now()
      logEvent(next.platform, 'job.failed', { ok: false, jobId: next.id, error: next.error })
      running = null
      save()
      pump()
    })
}
