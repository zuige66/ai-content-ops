/* core/breaker.mjs —— 写操作熔断器（模式抄 dsh-douyin-scroll 的 session-guard，教训是真的）
 * ═══════════════════════════════════════════════════════════════
 * 写前体检 → 单发限速 → 写后复检 → 掉号熔断当天。
 * 熔断状态落盘 state/breaker-<platform>.json，重启不遗忘。
 * 那次真实事故：签名不对的写请求直接把整个 web 会话写注销 —— 写操作必须先确认还登着。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from './log.mjs'
import { readConfig } from './shell.mjs'

function stateFile(platform) { return path.join(ROOT, 'state', `breaker-${platform}.json`) }

function loadState(platform) {
  try { return JSON.parse(fs.readFileSync(stateFile(platform), 'utf8')) } catch { return {} }
}

export function isBroken(platform) {
  const s = loadState(platform)
  return Boolean(s.brokenUntil && Date.now() < s.brokenUntil)
}

export function brokenUntil(platform) {
  const s = loadState(platform)
  return s.brokenUntil || 0
}

/** 写操作总闸。checkAlive() 返回 {ok, why}；write() 干活。任何一步掉号 → 熔断到当天结束。 */
export async function guardedWrite(platform, { checkAlive, write, verify }) {
  if (isBroken(platform)) {
    throw new Error(`${platform} 已熔断（今天 ${new Date(brokenUntil(platform)).toLocaleTimeString('zh-CN')} 前拒绝一切写操作）`)
  }
  const alive = await checkAlive()
  if (!alive.ok) {
    // 「没登录」和「掉号」要分开：没登录只是不干活（soft），不熔断；
    // 有 cookie 但接口不认 = 会话被平台写注销了，那才是要熔断的事故。
    if (alive.soft) throw new Error(`${platform} 未登录：${alive.why}（先扫码登录，不触发熔断）`)
    trip(platform, `写前体检不通过：${alive.why}`)
    throw new Error(`写前体检不通过：${alive.why}`)
  }
  const cfg = readConfig().rateLimitSec || {}
  const gap = (cfg[platform] || 60) * 1000
  const s0 = loadState(platform)
  const since = Date.now() - (s0.lastWriteAt || 0)
  if (since < gap) {
    const wait = gap - since
    logEvent(platform, 'breaker.throttle', { ok: true, waitMs: wait })
    await new Promise(r => setTimeout(r, wait))
  }
  const out = await write()
  const after = verify ? await verify() : { ok: true }
  if (!after.ok) {
    if (after.soft) throw new Error(`写后检查：${after.why}（会话没了，但没有 cookie 可言，不判掉号）`)
    trip(platform, `写后复检掉号：${after.why}`)
    throw new Error(`写后复检掉号：${after.why}`)
  }
  const st = loadState(platform)
  st.lastWriteAt = Date.now()
  fs.writeFileSync(stateFile(platform), JSON.stringify(st), 'utf8')
  return out
}

function trip(platform, why) {
  // 熔到今天 23:59:59 —— 当天不再碰任何写操作
  const end = new Date(); end.setHours(23, 59, 59, 999)
  fs.writeFileSync(stateFile(platform), JSON.stringify({
    brokenUntil: end.getTime(), why, at: new Date().toISOString(),
  }, null, 1), 'utf8')
  logEvent(platform, 'breaker.trip', { ok: false, why, until: end.toISOString() })
}
