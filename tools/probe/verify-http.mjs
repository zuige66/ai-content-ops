/* 实测 confirm 闸 + readBody 超限，打真实服务 */
const BASE = 'http://127.0.0.1:18090'

async function main() {
  console.log('=== confirm 闸：不带合法 confirm 一律不放行 ===')
  const cases = [
    ['空 body', undefined, {}],
    ['非法 JSON', 'not-json{{', { 'content-type': 'application/json' }],
    ['字段写错', JSON.stringify({ foo: 1 }), { 'content-type': 'application/json' }],
    ['字符串 false', JSON.stringify({ confirm: 'false' }), { 'content-type': 'application/json' }],
    ['数字 0', JSON.stringify({ confirm: 0 }), { 'content-type': 'application/json' }],
    ['null', JSON.stringify({ confirm: null }), { 'content-type': 'application/json' }],
    ['严格 true', JSON.stringify({ confirm: true }), { 'content-type': 'application/json' }],
  ]
  for (const [name, body, headers] of cases) {
    const r = await fetch(`${BASE}/jobs/j999999/confirm`, { method: 'POST', headers, body })
    const j = await r.json().catch(() => ({}))
    /* 任务不存在时一律 404，说明闸门没有被"默认放行"短路 */
    console.log(' ', name.padEnd(12), '->', r.status, String(j.error || '').slice(0, 60))
  }

  console.log('')
  console.log('=== readBody 超限：应快速返回而不是挂死 ===')
  const big = 'x'.repeat(2_500_000)
  const t0 = Date.now()
  try {
    const r = await fetch(`${BASE}/jobs/j999999/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
      signal: AbortSignal.timeout(15000),
    })
    console.log('  status =', r.status, ` 耗时 ${Date.now() - t0}ms`)
  } catch (e) {
    console.log('  异常 =', e.name, ` 耗时 ${Date.now() - t0}ms`)
  }

  console.log('')
  console.log('=== 静态白名单：config.json 必须拿不到 ===')
  for (const p of ['/config.json', '/media/../config.json', '/server.mjs', '/state/jobs.json']) {
    const r = await fetch(BASE + p)
    console.log(' ', p.padEnd(28), '->', r.status, r.headers.get('content-type') || '')
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1) })
