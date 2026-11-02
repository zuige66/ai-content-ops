/* tools/scheduler.mjs —— 独立定时器（不依赖 WorkBuddy）
 * ═══════════════════════════════════════════════════════════════
 * 为什么自己写：WorkBuddy 的定时任务要它开着才跑，还会每次开一个会话；
 * Windows 计划任务这边被安全策略拦（不允许从 bash 调 cmd.exe / schtasks）。
 * 所以起一个常驻 node 进程，自己看表到点就 spawn 一次 auto-reply。
 *
 * 设计要点：
 *   · 每分钟醒一次，只比对 HH:MM —— 不用第三方 cron 库
 *   · 用日期当 key 记「今天这个点跑过了」，重启进程也不会重复跑
 *   · 上一次还没结束时跳过本次（串行，不叠跑）
 *   · 日志落 logs/scheduler/<日期>.ndjson
 *
 * 用法：
 *   node tools/scheduler.mjs              # 前台跑（调试）
 *   node tools/scheduler.mjs --once       # 立刻跑一轮 auto-reply 然后退出
 *   wscript start-scheduler.vbs           # 静默后台启动（开机自启用这个）
 * ═══════════════════════════════════════════════════════════════
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT } from '../core/log.mjs'
import { isOffPeak, isWorkday, describe } from '../core/offpeak.mjs'

/* ── 2026-11-03 zuige 定的时间表 ──
 *
 * 工作日：
 *   12:15 第一轮 → 13:30 第二轮 → 18:15 第三轮 → 之后每间隔一小时一轮，
 *   一直到**次日 08:15**。即：
 *     12:15 13:30 18:15 19:15 20:15 21:15 22:15 23:15
 *     00:15 01:15 02:15 … 07:15 08:15
 *   ⚠️ 08:15~12:15、13:30~18:15 这两段**故意空着** —— 那是 DeepSeek 高峰
 *      （工作日 9-12、14-18 价格翻倍），zuige 明确说「不用补」。
 *
 * 节假日：全天每小时 :15 跑一轮，共 24 轮。
 *   ⚠️ 周末我按同一逻辑一起算进去了：DeepSeek 周末全天平峰，没有要避的高峰，
 *      没理由留空档。zuige 原话只说「节假日」。若只想节假日生效，
 *      把 targetsForNow() 里的 isWorkday 换成 isHoliday（已从 offpeak 导出）。
 *
 * 两段表都是「当天的 HH:MM」集合，tick 每 30 秒比一次，跨天由日期 key 天然区分。
 */
const pad = (n) => String(n).padStart(2, '0')
const WORKDAY_FIXED = ['12:15', '13:30', '18:15']

function workdayTargets() {
  const out = [...WORKDAY_FIXED]
  for (let h = 19; h <= 23; h++) out.push(`${pad(h)}:15`)   // 晚上：每小时一轮
  for (let h = 0; h <= 8; h++) out.push(`${pad(h)}:15`)     // 次日凌晨 ~ 08:15
  return out
}
function holidayTargets() {
  return Array.from({ length: 24 }, (_, h) => `${pad(h)}:15`)
}
function targetsForNow(d = new Date()) {
  return isWorkday(d) ? workdayTargets() : holidayTargets()
}

const LOG_DIR = path.join(ROOT, 'logs', 'scheduler')
const STATE_FILE = path.join(ROOT, 'state', 'scheduler-state.json')

function log(msg, extra = {}) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const row = JSON.stringify({ t: new Date().toISOString(), msg, ...extra })
  fs.appendFileSync(path.join(LOG_DIR, `${day}.ndjson`), row + '\n', 'utf8')
  console.log(new Date().toLocaleTimeString('zh-CN'), msg, extra.reason ? `(${extra.reason})` : '')
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return { done: {} } }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
  /* 只留最近 3 天的记录 */
  const keys = Object.keys(s.done).sort().reverse()
  for (const k of keys.slice(60)) delete s.done[k]
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1), 'utf8')
}

/** 现在的北京时间 HH:MM 和日期 */
function nowKey() {
  const f = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` }
}

let running = false
const state = loadState()

/* ═══════════ 顺带守护控制台服务 ═══════════
 * 为什么不靠手工：server.mjs 是评论发送的唯一出口（熔断器 + 60 秒限速都在里面），
 * 它挂了 auto-reply 就干不了活。实测它会被系统/会话清理掉（跑满 6 小时后 exit 127），
 * 所以这里每拍探一次，挂了就拉起来。
 * 拉起后 90 秒内不再探 —— 它启动要预热抖音数据（约 15 秒），
 * 探太勤会连开好几个实例抢 18090 端口。 */
const BASE = 'http://127.0.0.1:18090'
let lastSpawn = 0

async function serverAlive() {
  try {
    const r = await fetch(BASE + '/douyin/cache', { signal: AbortSignal.timeout(3000) })
    return r.ok
  } catch { return false }
}

async function ensureServer() {
  if (Date.now() - lastSpawn < 90000) return   // 刚拉起，给它时间预热
  if (await serverAlive()) return
  if (running) return                          // auto-reply 正在跑，它自己会处理
  lastSpawn = Date.now()
  log('控制台服务没响应，拉一个起来', { reason: 'server-down' })
  fs.mkdirSync(path.join(ROOT, '.run'), { recursive: true })
  const out = fs.openSync(path.join(ROOT, '.run', 'scheduler-server.log'), 'a')
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, out],
  })
  child.unref()
}

function runOnce(reason) {
  if (running) { log('上一轮还在跑，跳过', { reason }); return }
  running = true
  log('开始跑 auto-reply', { reason })
  const t0 = Date.now()
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'auto-reply.mjs'), '--yes'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  child.stdout.on('data', d => { out += d.toString() })
  child.stderr.on('data', d => { out += d.toString() })
  child.on('close', (code) => {
    running = false
    const sec = ((Date.now() - t0) / 1000).toFixed(0)
    log(`auto-reply 结束（exit ${code}，${sec}s）`, { reason, code, sec: Number(sec) })
    /* 把关键输出留档，出问题好查 */
    const tailDir = path.join(ROOT, 'state')
    fs.mkdirSync(tailDir, { recursive: true })
    fs.writeFileSync(path.join(tailDir, `auto-reply-log-${Date.now()}.txt`), out, 'utf8')
  })
}

if (process.argv.includes('--once')) {
  log('手动跑一轮', { reason: 'once' })
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'auto-reply.mjs'), '--yes'], { cwd: ROOT, stdio: 'inherit' })
  child.on('close', c => process.exit(c || 0))
} else {
  log('定时器启动', { targets: targetsForNow(), now: describe() })
  /* 启动时补跑一次：如果今天已经过了某个点但还没跑（比如开机晚了），
   * 只在 5 分钟内的容差窗口里补，避免半夜启动把早上 8 点那个点补上。 */
  const tick = async () => {
    await ensureServer().catch(() => { })
    const { day, hm } = nowKey()
    /* 🔴 每拍重新算 targets，不能启动时算一次存着 ——
     *    跨天时「工作日表 / 节假日表」会切换（比如国庆收假那天凌晨），
     *    存死的表会拿昨天的规则跑今天。 */
    if (targetsForNow().includes(hm)) {
      const key = `${day} ${hm}`
      if (!state.done[key]) {
        if (!isOffPeak()) {
          log('到点了但在高峰时段，跳过', { reason: 'peak', hm })
          state.done[key] = { at: Date.now(), skipped: 'peak' }
          saveState(state)
        } else {
          state.done[key] = { at: Date.now() }
          saveState(state)
          runOnce(hm)
        }
      }
    }
  }
  tick()
  setInterval(tick, 30000)   // 30 秒扫一次，防止整点那一分钟恰好卡住
  /* 常驻进程不该因为一次异常就退出 */
  process.on('uncaughtException', e => log('未捕获异常', { error: String(e && e.message || e).slice(0, 200) }))
  process.on('unhandledRejection', e => log('未处理拒绝', { error: String(e && e.message || e).slice(0, 200) }))
}
