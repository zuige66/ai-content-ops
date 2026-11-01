/* tools/douyin-account.mjs —— 只读：把「头像/简介/背景/粉丝」这些字段捞全
 * 用法：node tools/douyin-account.mjs
 * 输出：state/account-self.json + state/account-creator.json，并打印字段清单
 */
import fs from 'node:fs'
import path from 'node:path'
import { launchPersistent } from '../core/browser.mjs'
import { ROOT } from '../core/log.mjs'

const { ctx } = await launchPersistent('douyin', { headless: true })
const page = await ctx.newPage()

const out = { at: new Date().toISOString() }

/* 1) 个人主页自助接口：signature / avatar_larger / 背景 全在这儿 */
await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(1500)
out.self = await page.evaluate(async () => {
  const r = await fetch('https://www.douyin.com/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', { credentials: 'include' })
  const j = await r.json()
  return { status: r.status, body: j }
})

/* 2) 创作者中心账号接口：认证、权限、粉丝数、头像 */
await page.goto('https://creator.douyin.com/creator-micro/home', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(3000)
out.creator = await page.evaluate(async () => {
  const r = await fetch('https://creator.douyin.com/aweme/v1/creator/user/info/', { credentials: 'include' })
  const j = await r.json()
  return { status: r.status, body: j }
})

/* 3) 主页装修 / 背景图：创作者中心的 homepage 模块接口 */
out.homepage = await page.evaluate(async () => {
  try {
    const r = await fetch('https://creator.douyin.com/aweme/v1/creator/homepage/module/', { credentials: 'include' })
    const t = await r.text()
    let j = null; try { j = JSON.parse(t) } catch { }
    return { status: r.status, len: t.length, body: j || t.slice(0, 600) }
  } catch (e) { return { error: String(e).slice(0, 160) } }
})

await page.close()
await ctx.close()

const u = out.self?.body?.user || {}
const FIELDS = ['uid', 'sec_uid', 'unique_id', 'short_id', 'nickname', 'signature', 'avatar_uri',
  'avatar_larger', 'avatar_thumb', 'avatar_168x168', 'avatar_300x300', 'cover_url', 'profile_cover',
  'aweme_count', 'follower_count', 'following_count', 'total_favorited', 'favoriting_count',
  'city', 'province', 'country', 'district', 'ip_location', 'custom_verify', 'enterprise_verify_reason',
  'is_star', 'mix_count', 'mplatform_followers_count']
const present = {}
for (const k of FIELDS) if (k in u) present[k] = u[k]

fs.mkdirSync(path.join(ROOT, 'state'), { recursive: true })
fs.writeFileSync(path.join(ROOT, 'state', 'account-self.json'), JSON.stringify(out.self, null, 2), 'utf8')
fs.writeFileSync(path.join(ROOT, 'state', 'account-creator.json'), JSON.stringify({ creator: out.creator, homepage: out.homepage }, null, 2), 'utf8')

console.log('=== profile/self 状态', out.self?.status, ' 全部字段：', Object.keys(u).length)
console.log('=== 关键字段：')
for (const [k, v] of Object.entries(present)) {
  let s
  if (v && typeof v === 'object') s = JSON.stringify(v).slice(0, 300)
  else s = String(v).slice(0, 300)
  console.log(`  ${k}: ${s}`)
}
console.log('\n=== 没有的字段（说明这条接口给不了）：',
  FIELDS.filter(k => !(k in u)).join(', ') || '（全都有）')
console.log('\n=== creator/user/info 顶层：', Object.keys(out.creator?.body || {}).join(', '))
console.log('=== homepage/module 状态：', out.homepage?.status, ' len=', out.homepage?.len, JSON.stringify(out.homepage?.body).slice(0, 500))
