/* core/log.mjs —— 分平台 NDJSON 日志
 * ═══════════════════════════════════════════════════════════════
 * 主人要求：B站和抖音的记忆（日志）**分开**。所以每个平台一个目录，
 * 互不掺杂；视频合成这类公共动作走 logs/video/。
 * 每行一个 JSON：{t, action, ok, ...detail} —— 直接 cat / tail 可审计。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..')
const LOGS = path.join(ROOT, 'logs')

export function logEvent(platform, action, detail = {}) {
  const dir = path.join(LOGS, platform)
  fs.mkdirSync(dir, { recursive: true })
  const day = new Date().toISOString().slice(0, 10)
  const row = JSON.stringify({
    t: new Date().toISOString(),
    action,
    ok: detail.ok !== false,
    ...detail,
  })
  fs.appendFileSync(path.join(dir, `${day}.ndjson`), row + '\n', 'utf8')
  return row
}

/** 最近 N 行（控制台页的日志页签用），platform=douyin|bili|video */
export function tailLog(platform, lines = 200) {
  const dir = path.join(LOGS, platform)
  let names = []
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.ndjson')).sort() } catch { return [] }
  const out = []
  for (let i = names.length - 1; i >= 0 && out.length < lines; i--) {
    const rows = fs.readFileSync(path.join(dir, names[i]), 'utf8').trimEnd().split('\n')
    out.unshift(...rows.slice(-lines + out.length).map(r => { try { return JSON.parse(r) } catch { return { raw: r } } }))
  }
  return out
}
