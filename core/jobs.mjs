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

/** 这个平台上有没有正在等确认的同种任务。
 *  为什么要问：dry-run 的浏览器页是活的，一个平台同时挂两条投稿，
 *  两条会共用同一个 context 抢同一张上传页 —— 填出来的表是谁的都不一定。
 *  所以宁可让第二条直接报错，让人先把第一条处理掉。 */
export function findAwaitingConfirm({ platform, kind } = {}) {
  return jobs.find(j => j.status === 'awaiting-confirm'
    && (!platform || j.platform === platform)
    && (!kind || j.kind === kind))
}

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
 *  这比把挂起的 promise 续上简单可靠：重启也不怕，大不了重新 dry-run。
 *
 *  🔴 这里原来还生成一个 confirmToken 但**从来没被校验过** —— 看着像一道闸，
 *     实际是死字段。真要做防重放得让前端也带上它，而现在的信任模型是
 *     「只监听 127.0.0.1 + 人工点确认」，token 不增加任何实际安全性，所以删掉。
 *     真正起作用的是 server.mjs 里 `body.confirm === true` 那道严格判定。 */
export function awaitConfirm(j, summary) {
  j.status = 'awaiting-confirm'
  j.result = summary        // 截图路径、填了什么 —— 人看的就是这个
  j.updatedAt = Date.now()
  save()
  logEvent(j.platform, 'job.awaitConfirm', { ok: true, jobId: j.id, title: j.title })
}

export function resolveConfirm(id, ok) {
  const j = getJob(id)
  if (!j || j.status !== 'awaiting-confirm') return null
  j.updatedAt = Date.now()
  if (!ok) {
    j.status = 'failed'
    j.error = '人工撤销'
    save()
    logEvent(j.platform, 'job.cancel', { ok: false, jobId: id })
    /* 让处理器收拾现场 —— 投稿那边 dry-run 留着一张活着的上传页，
     * 不关掉的话下一条任务会捡到它（ctx.pages().find 是全局的），
     * 在别人填了一半的表单上接着填。 */
    const h = pickCancelHandler(j)
    if (h) Promise.resolve().then(() => h(j)).catch(() => { /* 收尾失败不影响撤销 */ })
    return j
  }
  j.params = { ...j.params, confirmed: true }
  j.status = 'pending'
  save()
  logEvent(j.platform, 'job.confirm', { ok: true, jobId: id })
  pump()
  return j
}

/* ══════════════════════════════════════════════════════════════════════
 * 事后对账
 * ══════════════════════════════════════════════════════════════════════ */

/** 把「脚本判失败、其实人手动发成功了」的投稿任务翻成 done。
 *
 *  典型场景：抖音点发布后要短信验证码，脚本等 5 分钟超时判 failed，
 *  人在窗口里输完码照样发出去了 —— 任务中心和线上真实结果对不上。
 *  对账不靠猜：拿作品列表的 createTime 和任务的 createdAt 比，
 *  再把正文前 12 个字对一遍，两边都中才算数。 */
export function reconcilePublish(works = []) {
  const fixed = []
  for (const j of jobs) {
    if (j.kind !== 'publish' || j.status !== 'failed') continue
    /* 只对账「可能是人工接手」的那几种失败，别的（没登录、文件不存在）别乱翻 */
    if (!/验证码|没看到成功提示|5 分钟/.test(String(j.error || ''))) continue
    const want = String((j.params && (j.params.desc || j.params.title)) || '').slice(0, 12)
    if (!want) continue

    const hit = works.find((w) => {
      const t = Number(w.createTime) * 1000
      if (!t) return false
      /* 发布时间必须落在任务创建之后的一段窗口里 */
      if (t < j.createdAt - 120000 || t > j.createdAt + 40 * 60000) return false
      return String(w.title || w.desc || '').includes(want)
    })
    if (!hit) continue

    j.status = 'done'
    j.error = null
    j.result = { ...(j.result || {}), published: true, reconciled: true, itemId: hit.plainId || hit.id || '' }
    j.updatedAt = Date.now()
    logEvent(j.platform, 'job.reconciled', { ok: true, jobId: j.id, itemId: j.result.itemId })
    fixed.push({ id: j.id, itemId: j.result.itemId, title: j.title })
  }
  if (fixed.length) save()
  return fixed
}

/* 队列泵：一次只跑一个。awaiting-confirm **不占坑** —— 人可能隔半小时才点确认，
 * 让后面排的视频任务干等半小时不合理。写操作的互斥交给平台锁
 * （见 findAwaitingConfirm + 各 publish 入口的检查），不靠队列硬堵。 */
export function register(kind, fn) { handlers[kind] = fn }
const handlers = {}

/** 撤销/收尾钩子：处理器自己关浏览器页、清临时 Map。
 *
 *  🔴 必须按 **`kind:platform`** 存，不能只按 kind。
 *     抖音和 B 站的 publish 都在模块顶层注册 `onCancel('publish', ...)`，
 *     单槽会让后 import 的那个（server.mjs 里是 bili，L54 晚于 L48）
 *     静默覆盖前者 —— 撤销抖音投稿时它的 closeKept 永远不执行，
 *     那张填了一半的上传页就留在浏览器里给下一条任务捡，正是
 *     一串「人工撤销」的结构性根因。
 *     兼容：注册时不带 platform 的老写法仍然能命中（存成 `kind:*`）。 */
export function onCancel(kind, platformOrFn, maybeFn) {
  const hasPlatform = typeof platformOrFn === 'string'
  const platform = hasPlatform ? platformOrFn : '*'
  const fn = hasPlatform ? maybeFn : platformOrFn
  if (typeof fn !== 'function') return
  cancelHandlers[`${kind}:${platform}`] = fn
}
const cancelHandlers = {}

/** 取收尾钩子：先找精确匹配，再退回 kind:* */
function pickCancelHandler(job) {
  return cancelHandlers[`${job.kind}:${job.platform || 'core'}`] || cancelHandlers[`${job.kind}:*`]
}

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
