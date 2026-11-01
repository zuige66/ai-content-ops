/* douyin/verify-login.mjs —— 验证抖音登录态在「投稿真正需要的页面」上有效
 * 不是看 cookie 有没有，而是直接开创作者后台，看会不会被踢回登录页。
 * 用法：node douyin/verify-login.mjs
 */
import path from 'node:path'
import { launchPersistent } from '../core/browser.mjs'
import { ROOT } from '../core/log.mjs'
import * as session from './session.mjs'

const { ctx } = await launchPersistent('douyin', { headless: true })
const quick = await session.quickCheck(ctx)
console.log('cookie 检查:', quick.ok ? '有 sessionid ✓' : '没有 ✗')

const alive = await session.checkAlive(ctx, { deep: true })
console.log('体检:', JSON.stringify(alive))

const page = await ctx.newPage()
await page.goto('https://creator.douyin.com/creator-micro/home', { waitUntil: 'domcontentloaded', timeout: 45000 })
await page.waitForTimeout(4000)
const url = page.url()
const txt = (await page.evaluate(() => document.body.innerText)).slice(0, 500)
console.log('落地 url:', url)
console.log('页面首行:', txt.split('\n').filter(Boolean).slice(0, 6).join(' | '))

const loginModal = /扫码登录|验证码登录/.test(txt)
console.log(loginModal ? '❌ 仍要求登录' : '✅ 已进入创作者后台')

await page.screenshot({ path: path.join(ROOT, 'state', 'verify-creator.png') })
console.log('截图: state/verify-creator.png')

const ck = await ctx.cookies()
const names = ck.filter(c => /sessionid|sid_guard|uid_tt|passport/.test(c.name)).map(c => c.name)
console.log('关键 cookie:', [...new Set(names)].join(', '))
await ctx.close()
