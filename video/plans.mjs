/* video/plans.mjs —— 策划台（读 md，不改内容）
 * ═══════════════════════════════════════════════════════════════
 * 策划 md 是人写的，格式会变。所以这里的原则是：**解析失败不算错**，
 * 拿不到就给 null，让前端显示「—」，绝不让一个格式小改把整个列表打挂。
 *
 * 只做三件事：
 *   1. 扫描 video/plans/*.md，把 front matter + 几个关键统计抠出来给列表用
 *   2. 单期详情：原文 + 口播表 + 分镜表
 *   3. 改状态（draft → approved），**只动 status 那一行**
 *
 * 为什么审批放在这里而不是前端直接写文件：前端没有文件系统权限，
 * 而且状态机只该有一个入口。改状态前要校验白名单，不然手滑把
 * status 写成 `ok` 这种，闸就形同虚设。
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../core/log.mjs'

const DIR = path.join(ROOT, 'video', 'plans')

/** 状态机：只认这四个。顺序有意义，日更排期靠 approved 数算库存 */
export const STATUSES = ['draft', 'approved', 'shot', 'published']

/** slug 只允许字母数字横线 —— 它会被拼进文件路径，必须挡住 ../ 这类 */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i

const exists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }

/** front matter：`---` 之间的一坨 key: value。不做 YAML 解析，够用就行 */
function parseFront(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const out = {}
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (!kv) continue
    /* 行尾注释也剥掉：`status: draft   # draft → approved` */
    out[kv[1]] = kv[2].replace(/\s+#.*$/, '').trim()
  }
  return out
}

/** 按 `## ` 切段，键取标题里的序号：`## 4. 口播稿` → 4 */
function sections(text) {
  const out = {}
  const parts = text.split(/^##\s+/m).slice(1)
  for (const p of parts) {
    const head = p.slice(0, p.indexOf('\n') < 0 ? p.length : p.indexOf('\n'))
    const num = head.match(/^(\d+)/)
    if (num) out[Number(num[1])] = p
  }
  return out
}

/** markdown 表格 → 行数组（跳过表头和分隔线） */
function tableRows(block) {
  if (!block) return []
  return block.split(/\r?\n/)
    .filter(l => /^\s*\|/.test(l))
    .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
    .filter(cells => !cells.every(c => /^:?-{2,}:?$/.test(c)))   // 分隔线
    .slice(1)                                                     // 表头
}

/** 口播表：| 段 | 镜 | 时间 | 字数 | 文本 | */
function parseVoice(sec) {
  return tableRows(sec).map(c => ({
    seg: Number(c[0]) || 0,
    shot: c[1] || '',
    time: c[2] || '',
    chars: Number(String(c[3] || '').replace(/[^\d]/g, '')) || 0,
    text: c[4] || '',
  })).filter(v => v.seg > 0)
}

/** 分镜表：| 镜 | 时间 | 画面 | 屏上文字 | 素材来源 | 状态 | */
function parseShots(sec) {
  return tableRows(sec).map(c => ({
    no: Number(c[0]) || 0,
    time: c[1] || '',
    frame: c[2] || '',
    onScreen: c[3] || '',
    source: c[4] || '',
    done: /[☑✓✔]/.test(c[5] || ''),
  })).filter(s => s.no > 0)
}

/** 合计字数 / 预估时长：写法是「约 119 个汉字 + 9 个英文词」「约 29s」 */
function parseTotals(text) {
  const chars = text.match(/\*\*合计字数\*\*[:：]\s*约?\s*(\d+)/)
  const dur = text.match(/\*\*预估时长\*\*[:：]\s*约?\s*(\d+(?:\.\d+)?)\s*s/i)
  return {
    chars: chars ? Number(chars[1]) : null,
    durSec: dur ? Number(dur[1]) : null,
  }
}

/** 选中的钩子：`- [x] A：**六天，四千四百星**` */
function parseHook(text) {
  const m = text.match(/^-\s*\[[xX]\]\s*(.+)$/m)
  if (!m) return null
  return m[1].replace(/\*\*/g, '').trim()
}

/** 封面两行：代码块里的 `第一行（≤6 字）：xxx` */
function parseCover(text) {
  const a = text.match(/第一行[^：:]*[：:]\s*(.+)/)
  const b = text.match(/第二行[^：:]*[：:]\s*(.+)/)
  return { line1: a ? a[1].trim() : '', line2: b ? b[1].trim() : '' }
}

/** 标题候选条数：抖音 ≤20 字 5 条、B站 3 条，数出来就知道策划填没填满 */
function countTitles(text) {
  const grab = (label) => {
    const i = text.indexOf(label)
    if (i < 0) return 0
    const rest = text.slice(i, i + 2000)
    const stop = rest.slice(label.length).search(/\*\*B站\*\*|\n## /)
    const block = stop < 0 ? rest : rest.slice(0, label.length + stop)
    return (block.match(/^\s*\d+\.\s*\S+/gm) || []).length
  }
  return { douyin: grab('**抖音**'), bili: grab('**B站**') }
}

function parseOne(file) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return null }
  const fm = parseFront(text)
  const sec = sections(text)
  const titleLine = (text.match(/^#\s+(.+)$/m) || [, ''])[1].trim()
  const totals = parseTotals(text)
  const voice = parseVoice(sec[4])
  const shots = parseShots(sec[5])

  return {
    slug: fm.slug || path.basename(file, '.md'),
    file: path.basename(file),
    series: fm.series || '',
    episode: Number(fm.episode) || 0,
    repo: fm.repo || '',
    status: STATUSES.includes(fm.status) ? fm.status : 'draft',
    created: fm.created || '',
    title: titleLine,
    /* 「# 第 01 期 · DSH Go」→ 项目名取 · 后面那截 */
    project: (titleLine.split('·')[1] || titleLine).trim(),
    hook: parseHook(text),
    cover: parseCover(text),
    titles: countTitles(text),
    chars: totals.chars,
    durSec: totals.durSec,
    voice,
    shots,
    /* 风险块有没有写「不能干什么」——没写就是没做功课 */
    hasRisk: /这项目现在还不能干什么[\s\S]{0,200}?>\s*\S/.test(text),
  }
}

/** 列表：期号倒序（最新的在最上面），_TEMPLATE 不算一期 */
export function listPlans() {
  let names = []
  try { names = fs.readdirSync(DIR) } catch { return [] }
  return names
    .filter(n => n.endsWith('.md') && !n.startsWith('_'))
    .map(n => parseOne(path.join(DIR, n)))
    .filter(Boolean)
    .sort((a, b) => b.episode - a.episode)
}

/** 按 slug 找文件。
 *  🔴 文件名和 slug 不是一回事：文件叫 `github-picks-01-dsh-go.md`（带系列和
 *     期号，按名字排序就是时间顺序），slug 是 `dsh-go`（短，给 URL 用）。
 *     所以不能直接拼 `${slug}.md`，得回退到扫 front matter。 */
function findFile(slug) {
  if (!SLUG_RE.test(slug || '')) return null
  const direct = path.join(DIR, `${slug}.md`)
  if (exists(direct)) return direct
  let names = []
  try { names = fs.readdirSync(DIR) } catch { return null }
  for (const n of names) {
    if (!n.endsWith('.md') || n.startsWith('_')) continue
    const p = path.join(DIR, n)
    const fm = parseFront(fs.readFileSync(p, 'utf8'))
    if ((fm.slug || path.basename(n, '.md')) === slug) return p
  }
  return null
}

/** 单期详情：给原文，前端自己渲染 —— 后端不解析 markdown 成 HTML，
 *  免得两边各有一套规则。想看排版好的直接开文件。 */
export function readPlan(slug) {
  const file = findFile(slug)
  if (!file) return null
  const text = fs.readFileSync(file, 'utf8')
  return { ...parseOne(file), text }
}

/** 改状态：只替换 front matter 里 status 的值，行尾注释原样留着 */
export function setPlanStatus(slug, status) {
  if (!SLUG_RE.test(slug || '')) return { ok: false, error: 'slug 不合法' }
  if (!STATUSES.includes(status)) return { ok: false, error: `status 只能是 ${STATUSES.join(' / ')}` }
  const file = findFile(slug)
  if (!file) return { ok: false, error: `找不到 ${slug} 对应的策划文件` }

  const text = fs.readFileSync(file, 'utf8')
  const re = /^status:(\s*)(\S+)/m
  if (!re.test(text)) return { ok: false, error: '这份策划没有 front matter 的 status 字段' }
  const next = text.replace(re, (_, sp) => `status:${sp}${status}`)
  fs.writeFileSync(file, next, 'utf8')
  return { ok: true, slug, status, prev: (text.match(re) || [])[2] }
}

/** 日更库存：approved 但还没出片的期数。低于 3 就该提醒补货了 */
export function planStock() {
  const all = listPlans()
  const by = (s) => all.filter(p => p.status === s).length
  return {
    total: all.length,
    draft: by('draft'),
    approved: by('approved'),
    shot: by('shot'),
    published: by('published'),
    /* 可出片 = 已审批但还没录 */
    ready: all.filter(p => p.status === 'approved').length,
    low: all.filter(p => p.status === 'approved').length < 3,
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 出片闸门
 * ══════════════════════════════════════════════════════════════════════
 * AGENTS.md 把「没有策划 md 不许生成视频 / status 不是 approved 不许跑 TTS」
 * 写成硬闸，但之前**没有任何代码校验它** —— runPipeline 和 /video/make
 * 都不碰 plans.mjs，UI 上的闸等于摆设，脚本一调就绕过去。
 *
 * 这里的取舍：不是所有片子都从策划派生（临时试片、调试模板很常见），
 * 所以默认**不拦**，只在调用方显式带上 plan slug 时才校验。
 * 但 `--strict` / `strictPlans:true` 打开后，没策划一律拒绝。 */

/**
 * 校验一次出片请求是否被允许。
 * @param {{planSlug?: string, strict?: boolean}} opts
 * @returns {{ok: true, plan?: object} | {ok: false, error: string, code: string}}
 */
export function checkPlanGate({ planSlug, strict = false } = {}) {
  const slug = String(planSlug || '').trim()

  if (!slug) {
    if (!strict) return { ok: true, plan: null }
    return {
      ok: false,
      code: 'no-plan',
      error: '严格模式：出片必须挂一期策划（body.plan = <slug>）。策划在 video/plans/，先写 md 再出片',
    }
  }

  const plan = readPlan(slug)
  if (!plan) {
    return { ok: false, code: 'plan-not-found', error: `找不到策划 ${slug}（GET /plans 看有哪些）` }
  }
  if (plan.status !== 'approved') {
    return {
      ok: false,
      code: 'plan-not-approved',
      error: `策划「${plan.title || slug}」当前 status=${plan.status}，只有 approved 才允许出片。`
        + '先在策划台点「审批通过」，或 POST /plans/<slug>/status {status:"approved"}',
    }
  }
  return { ok: true, plan }
}
