/* core/llm.mjs —— 极简 LLM 客户端（OpenAI 兼容 /chat/completions）
 * ═══════════════════════════════════════════════════════════════
 * 为什么自己写而不是装 SDK：只用得到 chat + JSON 输出这一件事，
 * 一个 fetch 就够。SDK 会把依赖树撑大，还会在 Windows 上带一堆坑。
 *
 * 配置来源（按优先级）：
 *   1. config.json 的 llm 段（base/key/model 直接写在这）
 *   2. config.json 的 llm.from —— 指向另一个项目的 llm.json（复用现成 key）
 *      🔴 key 绝不进本仓库：config.json 里只放路径。
 *
 * 借鉴 MoneyPrinterTurbo 的两个做法：
 *   · deepseek 系要显式 thinking:{type:'disabled'}，不然思考内容会混进正文
 *   · 返回先剥 markdown / think 块，再从里面抠 JSON —— 模型很爱加 ```json
 */
import fs from 'node:fs'
import path from 'node:path'
import { readConfig } from './shell.mjs'
import { logEvent } from './log.mjs'

/** 解析配置。支持 llm.from 指向外部 json（zhibo 项目那套） */
export function llmConfig() {
  const c = readConfig().llm || {}
  let base = c.base, key = c.key, model = c.model
  if ((!base || !key) && c.from) {
    const f = path.resolve(c.from)
    if (fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'))
        base = base || j.base
        key = key || j.key
        model = model || j.model
      } catch (e) {
        throw new Error(`llm.from 读不了：${f}（${String(e).slice(0, 80)}）`)
      }
    } else {
      throw new Error(`llm.from 指向的文件不存在：${f}`)
    }
  }
  if (!base || !key || !model) throw new Error('没配 LLM：config.json 的 llm 段要给 base/key/model（或用 llm.from 指向现成 llm.json）')
  return { base: base.replace(/\/+$/, ''), key, model, timeoutMs: Number(c.timeoutMs) || 120000 }
}

/** 剥掉模型爱加的包装：```json 围栏、<think> 块、标题井号 */
export function cleanText(s) {
  let t = String(s || '')
  t = t.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
  t = t.replace(/^.*<\/think\s*>/i, '')
  t = t.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '')
  return t.trim()
}

/** 从一段文本里抠出第一个 JSON 对象/数组。模型经常前后带解释 */
export function pickJson(s) {
  const t = cleanText(s)
  const m = t.match(/\{[\s\S]*\}/) || t.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('模型没给 JSON：' + t.slice(0, 120))
  return JSON.parse(m[0])
}

/**
 * 调一次 chat。默认要 JSON 对象。
 * @returns {Promise<{text:string, usage:object, ms:number}>}
 */
export async function chatDetailed({ system, user, maxTokens = 2000, temperature = 0.8, json = true }) {
  const c = llmConfig()
  const body = {
    model: c.model,
    temperature,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
  }
  /* deepseek 的思考模式会把 reasoning 混进 content，做结构化输出必须关掉 */
  if (/deepseek/i.test(c.base) || /deepseek/i.test(c.model)) body.thinking = { type: 'disabled' }
  if (json) body.response_format = { type: 'json_object' }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(`${c.base}/chat/completions`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`LLM HTTP ${res.status}：${txt.slice(0, 200)}`)
    }
    const j = await res.json()
    const out = j?.choices?.[0]?.message?.content
    if (!out) throw new Error('LLM 没返回 content：' + JSON.stringify(j).slice(0, 200))
    /* usage 是接口真实返回的用量，别自己按字数估 —— 中文 token 跟字数不是 1:1 */
    const usage = j.usage || {}
    const ms = Date.now() - t0
    logEvent('core', 'llm.ok', {
      ms, model: c.model, chars: String(out).length,
      prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    })
    return { text: cleanText(out), usage, ms }
  } catch (e) {
    logEvent('core', 'llm.fail', { ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 200) })
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 只要文本时用这个 */
export async function chat(opts) {
  return (await chatDetailed(opts)).text
}

/** 要结构化结果时用这个：chat + 抠 JSON */
export async function chatJson(opts) {
  return pickJson(await chat(opts))
}

/** 结构化 + 用量，脚本生成要记账就用这个 */
export async function chatJsonDetailed(opts) {
  const r = await chatDetailed(opts)
  return { data: pickJson(r.text), usage: r.usage, ms: r.ms }
}
