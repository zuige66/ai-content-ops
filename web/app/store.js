/* ═══════════════════════════════════════════════════════════════
 * store.js —— 全局状态
 *
 * 只有一份：当前视图、两个平台的登录态、任务队列、Toast。
 * 轮询失败静默 —— 6 秒一次的后台刷新，网络抖一下不该弹人一脸错误；
 * 只有人主动点的动作失败才报错。
 * ═══════════════════════════════════════════════════════════════ */

const { reactive } = Vue
import { api } from './core/api.js'

export const store = reactive({
  view: 'login',

  /** 策划台 → 视频工坊的交接位。
   *  为什么放 store：两个视图是独立模块、没有父子关系；用路由参数又要给
   *  这个无打包前端加一层路由，不值。这里只放一个 slug，工坊拿到后自己按
   *  /plans/<slug> 拉全文 —— 单一事实源仍然是那个 md，工坊只是**读**它，
   *  不复制、不改写。 */
  pendingPlan: null,

  /** 首屏是否已经拿到过一份数据（没有就先画骨架，别画"0"） */
  ready: false,
  /** 同步失败时的最后一次错误，标题行上用来提示"数据可能不新" */
  syncError: '',
  syncAt: 0,

  /** ffmpeg 自检结果（视频能不能出片，就靠它） */
  ffmpeg: '',

  /** 两个平台各自的登录态 */
  platforms: { douyin: {}, bili: {} },

  /** 任务队列（后端只给最近 20 条） */
  jobs: [],

  toasts: [],
})

/* ── Toast ──────────────────────────────────────────────────── */
let seq = 0
export function toast(msg, kind = 'info', ttl = 3600) {
  const id = ++seq
  store.toasts.push({ id, msg, kind })
  setTimeout(() => {
    const i = store.toasts.findIndex((t) => t.id === id)
    if (i >= 0) store.toasts.splice(i, 1)
  }, ttl)
}
export function dropToast(id) {
  const i = store.toasts.findIndex((t) => t.id === id)
  if (i >= 0) store.toasts.splice(i, 1)
}

/* ── 拉状态 ─────────────────────────────────────────────────── */
export async function refresh({ quiet = true } = {}) {
  try {
    const s = await api.status()
    store.platforms = { douyin: s.douyin || {}, bili: s.bili || {} }
    store.jobs = s.jobs || []
    store.syncAt = Date.now()
    store.syncError = ''
    store.ready = true
  } catch (e) {
    store.syncError = String(e.message || e)
    if (!quiet) toast(store.syncError, 'bad')
  }
}

/* ── 派生：等确认的条数（导航上的计数只给"要人动手"的队列） ── */
export function pendingCount() {
  return store.jobs.filter((j) => j.status === 'awaiting-confirm').length
}

/** 队列统计，KPI 条用它 */
export function jobStats() {
  const j = store.jobs
  return {
    total: j.length,
    running: j.filter((x) => x.status === 'running' || x.status === 'pending').length,
    pending: j.filter((x) => x.status === 'awaiting-confirm').length,
    failed: j.filter((x) => x.status === 'failed').length,
  }
}

/** 平台登录态的一句话结论，标题行副标题用它 */
export function platformLine() {
  const d = store.platforms.douyin || {}
  const b = store.platforms.bili || {}
  const one = (p, name) => (p.loggedIn ? `${name} ${p.who?.name || '已登录'}` : `${name} 未登录`)
  return `${one(d, '抖音')} · ${one(b, 'B站')}`
}
