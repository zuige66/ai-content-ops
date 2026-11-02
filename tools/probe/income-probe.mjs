/* tools/probe/income-probe.mjs —— 只读探测：抖音创作者后台「收入」接口
 * ═══════════════════════════════════════════════════════════════
 * 目的：确认 douyin/insight.mjs 能不能像取 profile/works/live 那样，
 *       用同一套「页面上下文 fetch credentials:include」拿到直播收入。
 *
 * 已知接口（来自 state/probe-douyin.json 的历史抓包，2026-10-31）：
 *   GET creator.douyin.com/aweme/v1/creator/income/category/summary/
 *       → day1/day7/day30_income_summary、today_total_income、total_balance
 *   GET creator.douyin.com/aweme/v1/creator/mission/user_summary/
 *       → income_summary.history_total_income、total_balance
 *
 * 🔴 这个文件只读，不改任何东西。一次性探测用，跑完可以留着，
 *    页面改版后重跑对字段。
 * ═══════════════════════════════════════════════════════════════ */
import { launchPersistent, getLive, pin } from '../../core/browser.mjs'

const CREATOR = 'https://creator.douyin.com'

const ENDPOINTS = {
  incomeSummary: `${CREATOR}/aweme/v1/creator/income/category/summary/?aid=2906&app_name=aweme_creator_platform&device_platform=web`,
  missionSummary: `${CREATOR}/aweme/v1/creator/mission/user_summary/?aid=2906&app_name=aweme_creator_platform&device_platform=web`,
}

async function main() {
  const live = getLive('douyin')
  const ctx = live || (await launchPersistent('douyin', { headless: true, pinned: true })).ctx
  if (live) pin('douyin')

  const p = await ctx.newPage()
  await p.goto(`${CREATOR}/creator-micro/home`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => { })
  await p.waitForLoadState('load', { timeout: 15000 }).catch(() => { })
  await p.waitForTimeout(1500)

  const out = {}
  for (const [name, url] of Object.entries(ENDPOINTS)) {
    const r = await p.evaluate(async (u) => {
      try {
        const res = await fetch(u, { credentials: 'include' })
        const t = await res.text()
        let j = null
        try { j = JSON.parse(t) } catch { }
        return { status: res.status, json: j, raw: t.slice(0, 200) }
      } catch (e) { return { status: 0, error: String(e).slice(0, 200) } }
    }, url)
    out[name] = r
    console.log(`\n═══ ${name} ═══`)
    console.log('status:', r.status)
    if (r.json) console.log(JSON.stringify(r.json, null, 1).slice(0, 4000))
    else console.log('非 JSON:', r.error || r.raw)
  }

  await p.close().catch(() => { })
  console.log('\n═══ 汇总 ═══')
  console.log(JSON.stringify(out, null, 1).slice(0, 6000))
}

main().catch((e) => { console.error('FAIL', e); process.exit(1) })
