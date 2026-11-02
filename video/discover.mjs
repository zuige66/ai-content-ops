/* video/discover.mjs —— 选题源：从 GitHub 找候选，生成 draft 策划
 * ═══════════════════════════════════════════════════════════════
 * 这是「自动找选题」缺的那一块。设计上有三条硬约束：
 *
 *   1. **只产出 draft**。绝不自动 approved —— AGENTS.md 那道闸的意义
 *      就在于「写完停下等人点头」，自动批准等于把闸拆了。
 *   2. **只抓事实，不写结论**。star / 语言 / 许可 / 描述都是 GitHub 给的原文，
 *      LLM 只负责按系列设定写钩子、标题、口播、分镜。数字不许 LLM 编。
 *   3. **门槛来自 series/github-picks.md**，不在这里另立一套：
 *      必须有可演示界面 / 90 天内首发或有近期大版本 / 中文用户能用。
 *
 * 搜索用 GitHub 的 search API，不需要 key（限速 10 次/分，够用）。
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'
import { chatJsonDetailed } from '../core/llm.mjs'
import { readConfig } from '../core/shell.mjs'

const PLANS_DIR = path.join(ROOT, 'video', 'plans')
const GH = 'https://api.github.com'

/* 🔴 GitHub 未认证请求是 60 次/小时（search 更少）。这个模块一次选题
 *    要打 2~3 次（search + repo + readme），很容易撞限速。
 *
 *    想稳定用就在 config.json 里加：
 *      "github": { "token": "ghp_xxx" }
 *    或者设环境变量 GITHUB_TOKEN。有 token 是 5000 次/小时。
 *    token 不进仓库（config.json 本来就在 .gitignore 里）。 */
let _token
function token() {
  if (_token !== undefined) return _token
  if (process.env.GITHUB_TOKEN) return (_token = process.env.GITHUB_TOKEN)
  try { _token = (readConfig().github || {}).token || '' } catch { _token = '' }
  return _token
}

/* 不做纯库 / 纯 CLI / 纯框架 —— 观众看不见东西（series 第五节） */
const BAD_TOPICS = new Set(['cli', 'command-line', 'library', 'framework', 'sdk', 'api', 'plugin', 'boilerplate'])
/* 需要企业资质、付费才能看效果的，一律不做 */
const BAD_LICENSE = new Set(['NOASSERTION', ''])

/** 统一的 GitHub 请求。限速要给人话，别只回一个 403。 */
const gh = async (p, { raw = false } = {}) => {
  const t = token()
  const r = await fetch(GH + p, {
    headers: {
      'user-agent': 'zhibo-auto',
      accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    signal: AbortSignal.timeout(20000),
  })
  if (r.status === 403 || r.status === 429) {
    const reset = r.headers.get('x-ratelimit-reset')
    const at = reset ? new Date(Number(reset) * 1000).toLocaleTimeString('zh-CN') : '稍后'
    const remaining = r.headers.get('x-ratelimit-remaining')
    throw new Error(
      `GitHub 限速了（剩余 ${remaining ?? '?'} 次，${at} 恢复）。`
      + (t ? '' : '在 config.json 加 "github":{"token":"ghp_..."} 可以把额度提到 5000 次/小时。'),
    )
  }
  if (!r.ok) throw new Error(`GitHub ${r.status}：${(await r.text()).slice(0, 160)}`)
  return raw ? r.text() : r.json()
}

/** 已经做过哪几期（按 repo 字段去重），选题时跳过 */
function usedRepos() {
  const used = new Set()
  let names = []
  try { names = fs.readdirSync(PLANS_DIR) } catch { return used }
  for (const n of names) {
    if (!n.endsWith('.md') || n.startsWith('_')) continue
    try {
      const t = fs.readFileSync(path.join(PLANS_DIR, n), 'utf8')
      const m = t.match(/^repo:\s*(\S+)/m)
      if (m) used.add(m[1].toLowerCase())
    } catch { /* 读不到就算了 */ }
  }
  return used
}

/**
 * 找候选仓库。
 * @param {{days?:number, minStars?:number, limit?:number, language?:string}} o
 */
export async function findCandidates({ days = 30, minStars = 80, limit = 12, language = '' } = {}) {
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
  const parts = [`created:>${since}`, `stars:>${minStars}`]
  if (language) parts.push(`language:${language}`)
  const q = encodeURIComponent(parts.join(' '))

  const j = await gh(`/search/repositories?q=${q}&sort=stars&order=desc&per_page=${Math.min(50, limit * 2)}`)
  const used = usedRepos()

  const items = (j.items || []).map((x) => ({
    repo: x.full_name,
    name: x.name,
    desc: String(x.description || '').slice(0, 200),
    stars: x.stargazers_count,
    language: x.language || '',
    license: x.license ? x.license.spdx_id : '',
    topics: x.topics || [],
    homepage: x.homepage || '',
    createdAt: String(x.created_at || '').slice(0, 10),
    pushedAt: String(x.pushed_at || '').slice(0, 10),
    htmlUrl: x.html_url,
    archived: Boolean(x.archived),
    fork: Boolean(x.fork),
  }))
    /* 门槛过滤（series 第五节）：看得见的东西、不是 fork/归档、有许可证 */
    .filter((x) => !x.archived && !x.fork)
    .filter((x) => !BAD_LICENSE.has(x.license))
    .filter((x) => !x.topics.some((t) => BAD_TOPICS.has(String(t).toLowerCase())))
    .filter((x) => !used.has(x.repo.toLowerCase()))     // 做过的跳过
    .slice(0, limit)

  logEvent('video', 'discover.candidates', { ok: true, days, minStars, found: items.length })
  return { ok: true, days, minStars, candidates: items, skippedUsed: used.size }
}

/** 取一个仓库的 README 摘要（前 1500 字），给 LLM 写钩子用。
 *  README 读不到不阻塞 —— 少一份事实来源而已，LLM 会写得保守些。 */
async function readmeBrief(repo) {
  try {
    const t = await gh(`/repos/${repo}/readme`, { raw: true })
    return String(t)
      .replace(/```[\s\S]*?```/g, ' ')          // 去掉代码块
      .replace(/<[^>]+>/g, ' ')                  // 去掉 HTML
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // 去掉图片
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // 链接留文字
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1500)
  } catch { return '' }
}

/* ── 策划 md 渲染 ─────────────────────────────────────────────
 * 严格照 _TEMPLATE.md 的八块结构，好让 plans.mjs 的解析器能读懂。
 * 表格里的列数和顺序不能变 —— parseVoice / parseShots 靠位置取列。 */
function renderPlan({ episode, repo, meta, brief, draft, today }) {
  const slug = String(repo.split('/')[1] || repo).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  const q = (s) => `\`${String(s || '').replace(/`/g, '')}\``
  const num = (n) => Number(n || 0).toLocaleString('en-US')

  const voice = Array.isArray(draft.voice) ? draft.voice : []
  const shots = Array.isArray(draft.shots) ? draft.shots : []
  const totalChars = voice.reduce((s, v) => s + String(v.text || '').length, 0)

  return `---
series: github-picks
episode: ${episode}
repo: ${repo}
slug: ${slug}
status: draft
created: ${today}
---

# 第 ${String(episode).padStart(2, '0')} 期 · ${draft.project || meta.name}

> 填写前先读 \`video/series/github-picks.md\`。本文件是**唯一事实源**，
> \`_script_*.json\` 从这里派生。\`status\` 不是 \`approved\` 之前，不许生成视频。

## 0. 事实卡

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | ${q(repo)} | GitHub API |
| 一句话定位 | ${meta.desc || '—'} | README 首段 |
| 语言 / 技术栈 | ${meta.language || '—'} | GitHub API |
| 许可证 | ${meta.license || '—'} | GitHub API |
| 首发日期 | ${meta.createdAt || '—'} | GitHub API |
| Star | ${num(meta.stars)} | 抓取日：${today} |
| 作者 | ${q(repo.split('/')[0])} | GitHub |
| 官网 / 下载 | ${meta.homepage || meta.htmlUrl} | GitHub |

> 每个数字都要写来源和抓取日。视频里说出口的 star 数，误差超过 10% 就会被评论区抓。

## 1. 钩子（三选一，选中的打 ✔）

${(draft.hooks || []).map((h, i) => `- [${i === (draft.hookPick || 0) ? 'x' : ' '}] ${String.fromCharCode(65 + i)}：${h}`).join('\n')}

> 三个钩子必须走不同路线：A 讲麻烦、B 讲新鲜、C 讲场景。
> 30 秒只养得起一个，别想全塞。

**选它，因为**：${draft.hookWhy || '（待补）'}

## 2. 标题

**抖音**（≤20 字，5 条）

${(draft.titles?.douyin || []).map((t, i) => `${i + 1}. ${t}`).join('\n')}

**B站**（≤30 字，带项目名，3 条）

${(draft.titles?.bili || []).map((t, i) => `${i + 1}. ${t}`).join('\n')}

## 3. 封面文案

\`\`\`
第一行（≤6 字）：${draft.cover?.line1 || ''}
第二行（≤6 字）：${draft.cover?.line2 || ''}
\`\`\`

> 第一行名词，第二行结果。不许出现「推荐」「第 N 期」。

## 4. 口播稿

> 总字数控制在 **115~130**，五段对应五个镜头。写完数一遍字数，写在这里。

| 段 | 镜 | 时间 | 字数 | 文本 |
|---|---|---|---|---|
${voice.map((v, i) => `| ${i + 1} | ${v.shot || ''} | ${v.time || ''} | ${String(v.text || '').length} | ${String(v.text || '').replace(/\|/g, '｜')} |`).join('\n')}

**合计字数**：${totalChars}　**预估时长**：${draft.durSec || 30} 秒

## 5. 分镜表

| 镜 | 时间 | 画面 | 屏上文字 | 素材来源 | 状态 |
|---|---|---|---|---|---|
${shots.map((s, i) => `| ${i + 1} | ${s.time || ''} | ${String(s.frame || '').replace(/\|/g, '｜')} | ${String(s.onScreen || '').replace(/\|/g, '｜')} | ${s.source || '纯排版'} | ☐ |`).join('\n')}

> 「素材来源」只填三种：\`仓库截图:<文件名>\` / \`需录屏:<做什么>\` / \`纯排版\`。
> 出现 \`需录屏\` 就意味着要额外花时间，日更排期里要提前准备。

## 6. 发布包

\`\`\`
desc  ：${draft.publish?.desc || ''}
tags  ：${draft.publish?.tags || ''}
地点  ：${draft.publish?.location || ''}
定时  ：
平台  ：抖音 + B站
\`\`\`

## 7. 风险与坦白

**事实待核实**：
${(draft.risks?.todo || []).map((x) => `- ${x}`).join('\n') || '- （待补）'}

**这项目现在还不能干什么**（必须写一条，尽量进正片）：
${draft.risks?.limit || '（待补）'}

**版权 / 许可注意**：${meta.license || '未标注'}。${draft.risks?.license || ''}

## 8. 版本

| 稿次 | 日期 | 改了什么 | 确认 |
|---|---|---|---|
| v1 | ${today} | AI 初稿（事实来自 GitHub API，文案待人工审） | ☐ |

<!--
  自动生成说明：
  · 事实卡与 README 摘要来自 GitHub API，抓取日 ${today}
  · 钩子/标题/口播/分镜由 LLM 按 series/github-picks.md 生成，**未经人工审核**
  · 审完把 front matter 的 status 改成 approved 才能出片
  · README 摘要（供复核用）：
  ${brief.slice(0, 400)}
-->
`
}

/**
 * 生成一期 draft 策划。
 * @param {{repo:string, episode?:number, template?:string}} o
 */
export async function draftPlan({ repo, episode, template = 'review' }) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) {
    return { ok: false, error: '要给 repo，格式 owner/name' }
  }

  /* 1. 抓事实（数字一律来自这里，不许 LLM 编） */
  const meta = await gh(`/repos/${repo}`)
  const brief = await readmeBrief(repo)

  /* 2. 期号：没给就取现有最大期号 +1 */
  const ep = Number(episode) || nextEpisode()

  /* 3. 让 LLM 按系列设定写文案 */
  const sys = `你在为「大肥鱼」的抖音/B站日更系列「GitHub 项目推荐」写一期 30 秒短片的策划。

系列铁律（来自 series/github-picks.md，必须遵守）：
1. 时长 30 秒，口播总字数 115~130 个汉字，五段对应五个镜头。
2. **第一句话不许介绍项目**。先抛麻烦或反常识，项目名放到第 3 秒之后。
3. 不解释原理。说「不用 root」，不说「基于 PRoot 的 user-space 容器」。
4. 每个卖点必须能被截图证明。说不清长什么样的功能不配进 30 秒。
5. 固定 5 镜时间轴：1 钩子 0-3.5s / 2 痛点具象 3.5-10s / 3 主卖点 10-18s / 4 次卖点 18-24s / 5 落地 24-30s。
6. 标题：抖音 5 条（≤20 字，口语，可以不带项目名）、B站 3 条（≤30 字，带项目名）。
7. 封面两行、每行 ≤6 字：第一行名词，第二行结果。不许出现「推荐」「第 N 期」。
8. 禁用词：「震惊」「逆天」「天花板」「神器」「必看」。
9. **必须写一条「这项目现在还不能干什么」**，这是防「你用了几天就敢推」的。

写法要点：反常识在前，数字在后。先给一句让人愣一下的话，再接一个具体到不可能的数补可信度。

只输出 JSON，结构：
{
  "project": "项目名（给人看的写法）",
  "hooks": ["A：...", "B：...", "C：..."],
  "hookPick": 0,
  "hookWhy": "为什么选它，一句话",
  "titles": { "douyin": ["5 条"], "bili": ["3 条"] },
  "cover": { "line1": "≤6字", "line2": "≤6字" },
  "voice": [
    {"shot":"钩子","time":"0–3.5s","text":"..."},
    {"shot":"痛点","time":"3.5–10s","text":"..."},
    {"shot":"主卖点","time":"10–18s","text":"..."},
    {"shot":"次卖点","time":"18–24s","text":"..."},
    {"shot":"落地","time":"24–30s","text":"..."}
  ],
  "shots": [
    {"time":"0–3.5s","frame":"画面描述","onScreen":"屏上文字","source":"仓库截图:hero.png"},
    ...共 5 条
  ],
  "publish": { "desc": "发布正文", "tags": "逗号分隔", "location": "" },
  "risks": { "todo": ["待核实的事实"], "limit": "这项目现在还不能干什么", "license": "许可注意" },
  "durSec": 30
}`

  const user = `仓库：${repo}
GitHub 原始数据（**这些数字是权威的，不许改**）：
- 描述：${meta.description || '（无）'}
- 语言：${meta.language || '（未标注）'}
- Star：${meta.stargazers_count}
- 许可：${meta.license ? meta.license.spdx_id : '未标注'}
- 首发：${String(meta.created_at).slice(0, 10)}
- 最近推送：${String(meta.pushed_at).slice(0, 10)}
- 主页：${meta.homepage || '（无）'}
- topics：${(meta.topics || []).join(', ') || '（无）'}

README 摘要（事实来源，别编 README 里没有的功能）：
${brief || '（读不到 README，只能靠上面的描述，写法要保守）'}`

  const { data, usage, ms } = await chatJsonDetailed({ system: sys, user, maxTokens: 2200, temperature: 0.85 })

  /* 4. 渲染 md 并落盘 —— 只写 draft，绝不自动 approved */
  const today = new Date().toISOString().slice(0, 10)
  const md = renderPlan({
    episode: ep, repo, meta: {
      name: meta.name, desc: meta.description, language: meta.language,
      license: meta.license ? meta.license.spdx_id : '',
      createdAt: String(meta.created_at).slice(0, 10),
      stars: meta.stargazers_count, homepage: meta.homepage, htmlUrl: meta.html_url,
    }, brief, draft: data, today,
  })

  const slug = String(repo.split('/')[1] || repo).toLowerCase().replace(/[^a-z0-9._-]/g, '-')
  const fileName = `github-picks-${String(ep).padStart(2, '0')}-${slug}.md`
  const file = path.join(PLANS_DIR, fileName)
  fs.mkdirSync(PLANS_DIR, { recursive: true })
  if (fs.existsSync(file)) return { ok: false, error: `已经有一期叫 ${fileName} 了（换期号或先删掉旧的）` }
  fs.writeFileSync(file, md, 'utf8')

  logEvent('video', 'plan.draft', { ok: true, repo, episode: ep, file: fileName, tokens: usage.total_tokens })
  return {
    ok: true,
    file: fileName,
    slug,
    episode: ep,
    repo,
    chars: (data.voice || []).reduce((s, v) => s + String(v.text || '').length, 0),
    tokens: usage.total_tokens,
    ms,
    note: '已生成 draft 策划。**必须人工审过、把 status 改成 approved 才能出片。**',
  }
}

/** 下一期期号 = 现有最大 +1（_TEMPLATE 不算） */
export function nextEpisode() {
  let max = 0
  let names = []
  try { names = fs.readdirSync(PLANS_DIR) } catch { return 1 }
  for (const n of names) {
    if (!n.endsWith('.md') || n.startsWith('_')) continue
    try {
      const t = fs.readFileSync(path.join(PLANS_DIR, n), 'utf8')
      const m = t.match(/^episode:\s*(\d+)/m)
      if (m) max = Math.max(max, Number(m[1]))
    } catch { /* 跳过 */ }
  }
  return max + 1
}
