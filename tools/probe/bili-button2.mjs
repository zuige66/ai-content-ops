/* 精确定位「立即投稿」按钮 —— 走服务的 HTTP 接口拿页面，不自己起浏览器
 *
 * 为什么要这样：sessions/bili 这个 profile 被 server 进程占着，
 * 脚本再 launchPersistent 必然报 Target page/context closed（或者降级到 Edge
 * 然后用一个没登录的 profile）。
 *
 * 做法：发一个 dry-run 投稿 → 等它停在 awaiting-confirm → 用 /browser/probe
 * 那套思路在**服务自己的页面**里 dump 按钮。这里直接用 CDP 连 server 用的
 * 那个浏览器太绕，改成让服务跑 dry-run，然后从截图 + DOM dump 判断。
 */
const BASE = 'http://127.0.0.1:18090'

const api = async (p, opt) => {
  const r = await fetch(BASE + p, opt)
  return r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))
}

/* 先清掉挂着的任务 */
const jobs = await api('/jobs?limit=20')
for (const j of (jobs.jobs || []).filter((x) => x.status === 'awaiting-confirm')) {
  await api(`/jobs/${j.id}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: false }),
  })
  console.log('cancelled', j.id)
}

/* 发起 dry-run */
const pub = await api('/publish', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    platform: 'bili',
    id: 'pick-1793551323277',
    title: '安卓手机能跑 Ubuntu，八天五千三百星',
    desc: '安卓手机能跑 Ubuntu。以前想在手机上调代码，得装 Termux，还得 root。',
    tags: ['AI', '编程', '开源'],
    typeName: '科技数码',
  }),
})
console.log('jobId:', pub.jobId)
if (!pub.jobId) process.exit(1)

/* 等到 awaiting-confirm */
let job = null
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const d = await api(`/jobs/${pub.jobId}/steps`)
  job = d.job
  if (job && ['awaiting-confirm', 'failed', 'done'].includes(job.status)) break
}
console.log('status:', job && job.status, '| error:', (job && job.error) || '-')
;(job && job.steps || []).forEach((s) => console.log('  ', s.msg))

/* 用服务的 /browser/probe 探按钮？那个接口只找文本节点。
 * 直接看截图更实在：让服务把当前页面整页截下来。
 * 这里退一步 —— 只要 dry-run 能停在 awaiting-confirm，且截图里按钮可见，
 * 就说明「按钮存在但选择器没匹配上」，问题在选择器写法而不是页面。 */
if (job && job.result && job.result.screenshots) {
  console.log('\n截图:')
  job.result.screenshots.forEach((s) => console.log('  ' + BASE + s))
}
