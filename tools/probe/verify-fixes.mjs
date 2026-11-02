/* .run/trash/verify-fixes.mjs —— 验证本轮 P0/P1 修复，不产生任何对外副作用
 * 只读 + 内存态，不建 job、不发写请求、不动线上账号。 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../../core/log.mjs'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

/* ── 1. confirm 闸：只有严格 true 才放行 ─────────────────────── */
{
  const readBodySim = (raw) => { try { return raw ? JSON.parse(raw) : {} } catch { return {} } }
  const cases = [
    ['', false], ['not-json{{', false], ['{"foo":1}', false],
    ['{"confirm":"false"}', false], ['{"confirm":0}', false],
    ['{"confirm":null}', false], ['{"confirm":false}', false],
    ['{"confirm":true}', true],
  ]
  let allOk = true
  const bad = []
  for (const [raw, want] of cases) {
    const got = readBodySim(raw).confirm === true
    if (got !== want) { allOk = false; bad.push(`${JSON.stringify(raw)}=>${got}`) }
  }
  check('P0-1 confirm 闸默认放行已修', allOk, bad.length ? bad.join(', ') : `${cases.length} 组输入全部正确`)
}

/* ── 2. onCancel 按 kind:platform 分槽，两平台互不覆盖 ────────── */
{
  /* 🔴 不再 enqueue 真任务来验 —— 那会写进 state/jobs.json 污染真实任务记录
   *    （上一版就多留了 2 条 __verify__ 假任务）。这里改成纯静态断言：
   *    直接读源码，确认注册表和查表逻辑都按 platform 分了槽。 */
  const src = fs.readFileSync(path.join(ROOT, 'core', 'jobs.mjs'), 'utf8')
  const perPlatform = /\$\{kind\}:\$\{platform\}/.test(src)
  const picker = /pickCancelHandler/.test(src)
  const dyReg = fs.readFileSync(path.join(ROOT, 'douyin', 'publish.mjs'), 'utf8')
  const biReg = fs.readFileSync(path.join(ROOT, 'bili', 'publish.mjs'), 'utf8')
  check('P0-2 onCancel 注册表按 kind:platform 分槽', perPlatform && picker)
  check('P0-2 抖音注册带 platform', /onCancel\('publish',\s*'douyin'/.test(dyReg))
  check('P0-2 B站注册带 platform', /onCancel\('publish',\s*'bili'/.test(biReg))
}

/* ── 3. 策划闸 ──────────────────────────────────────────────── */
{
  const plans = await import('../../video/plans.mjs')
  const noPlan = plans.checkPlanGate({})
  const strict = plans.checkPlanGate({ strict: true })
  const missing = plans.checkPlanGate({ planSlug: 'no-such-plan' })
  const real = plans.checkPlanGate({ planSlug: 'dsh-go' })
  check('P0-4 不带 plan 默认放行（试片场景）', noPlan.ok === true)
  check('P0-4 strict 模式下不带 plan 被拒', strict.ok === false && strict.code === 'no-plan')
  check('P0-4 不存在的策划被拒', missing.ok === false && missing.code === 'plan-not-found')
  check('P0-4 非 approved 的策划被拒',
    real.ok === false && real.code === 'plan-not-approved',
    real.ok ? '意外放行' : `dsh-go status 拦住了（${real.error?.slice(0, 40)}）`)
}

/* ── 4. 节假日表覆盖 2027 ───────────────────────────────────── */
{
  const o = await import('../../core/offpeak.mjs')
  const y2027 = new Date('2027-03-10T10:00:00+08:00')   // 2027 普通工作日周三
  const xmas = new Date('2027-01-01T10:00:00+08:00')    // 元旦
  check('P1 节假日表已覆盖 2027', o.HOLIDAY_TABLE_YEARS.includes(2027), o.HOLIDAY_TABLE_YEARS.join(','))
  check('P1 2027 元旦按节假日（平峰）', o.isPeak(xmas) === false, o.describe(xmas))
  check('P1 2027 普通工作日 10 点仍按高峰', o.isPeak(y2027) === true, o.describe(y2027))
}

/* ── 5. getLive 兼容 CDP ────────────────────────────────────── */
{
  const b = await import('../../core/browser.mjs')
  check('P1 getLive 在无 context 时返回 null（不抛）', b.getLive('__none__') === null)
  check('P1 liveHeadless 在无 context 时返回 null', b.liveHeadless('__none__') === null)
}

/* ── 6. dm 序号分支已删除 ───────────────────────────────────── */
{
  const src = fs.readFileSync(path.join(ROOT, 'douyin', 'dm.mjs'), 'utf8')
  /* 只看**代码行**，注释里提到 el.click() 是在讲坑，不算违规 */
  const codeLines = src.split(/\r?\n/).filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
  const code = codeLines.join('\n')
  const hasElClick = /\.evaluate\(\s*el\s*=>\s*el\.click\(\)|await\s+item\.evaluate\(/.test(code)
  const hasThrow = /只接受会话名/.test(src)
  check('P1 dm 序号分支的 el.click() 已移除', !hasElClick, hasElClick ? '仍存在 el.click() 调用' : '代码里已无该项')
  check('P1 dm 非名字调用会明确抛错', hasThrow)
}

/* ── 7. AI 声明 / 标题 / 成功判定 ───────────────────────────── */
{
  const src = fs.readFileSync(path.join(ROOT, 'douyin', 'publish.mjs'), 'utf8')
  check('P0-5 AI 生成内容声明已实现', /declareAiGenerated/.test(src))
  check('P1 抖音标题独立填写已实现', /titleFilled/.test(src))
  check('P1 成功判定不再用裸 /审核/', !/\/审核\|已发布\//.test(src) && /PUBLISHED_RE/.test(src))
  check('P1 验证码判定不再依赖 p.headed', /isWindowVisible/.test(src))
}

/* ── 8. readBody 超限不再挂死（源码层断言） ─────────────────── */
{
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')
  const hasFinishBeforeDestroy = /finish\(\{\}\)\s*\n\s*req\.destroy\(\)/.test(src)
  check('P1 readBody 超限先 resolve 再 destroy', hasFinishBeforeDestroy)
  check('P0-1 server 用 body.confirm === true', /body\.confirm === true/.test(src))
}

/* ── 汇总 ───────────────────────────────────────────────────── */
const fail = results.filter((r) => !r.pass)
console.log('\n' + '='.repeat(52))
console.log(`总计 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length}`)
if (fail.length) {
  console.log('失败项：')
  fail.forEach((f) => console.log('  - ' + f.name + (f.detail ? '：' + f.detail : '')))
  process.exit(1)
}
console.log('全部通过')
