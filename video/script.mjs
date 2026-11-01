/* video/script.mjs —— 主题 → 分镜脚本（segments JSON）
 * ═══════════════════════════════════════════════════════════════
 * 这是整条链路最上游缺的那一段：之前 /video/make 只接受人工填好的
 * segments，等于「文案」这一步一直靠人。现在补上。
 *
 * 为什么不让 LLM 直接吐一段旁白：
 *   模板要的是结构化 segments（气泡 / 信息卡混排），纯文本没法排。
 *   所以让模型直接产出 JSON，我们只做校验和兜底 —— 宁可报错重试，
 *   也不要把一段没法排版的长文硬塞进去。
 *
 * 时长怎么控：
 *   edge-tts 晓伊 -8% 实测约 4 字/秒。DESIGN.md 要求 60~110s，
 *   所以目标 320~420 字、14~16 段、每段 ≤22 字。字数是硬约束，
 *   模型爱写长，超了就在 normalize 里按句号切开，不整段砍。
 */
import { chatJsonDetailed } from '../core/llm.mjs'

/* ── 人设与内容铁律。改人设就改这里，别散落到各处 ── */
const SYS = `你是「红烧鱼」——广东工业大学（广工）的一条鱼，不住鱼塘，住在主人的电脑里。
本来叫大肥鱼，主人嫌太素，说下锅红烧一下更下饭，于是就叫红烧鱼了。
主人是个在跑 AI 项目的开发者，你趴在他旁边看他写代码。

你在拍「红烧鱼日记」系列：每支视频是一个 Day（第 0 天是开号那天），用你自己的口吻讲一件真事。

## 人设铁律
1. 第一人称，除 Day 0 报家门以外不自我介绍、不解释自己是 AI（观众早知道了）
2. 梗只从这个人设长出来：
   - 广工：机床比人多、食堂三块五吃到撑、实验报告、宿舍断电
   - 鱼：记性差、离了水就慌、被红烧过、酱油味
   - 电脑里：token = 白饭，API key = 主人的钥匙，服务器 = 家，报错 = 生病
3. 说人话：短句、口语、有停顿感。成语堆砌、"总而言之"、"值得注意的是"一律不要
4. 自称"我"，别提"鲸鱼女仆""大肥鱼"这个旧名字（除非讲改名这件事本身）

## 内容铁律
1. 讲真事：主人让你做了什么、你看到什么、哪一步翻车了。不编不吹不喊口号
2. 第一段必须抓人：抛数字、抛悬念、抛冲突
3. 说完就停。不做总结、不喊关注、不"下期见"
4. 禁止出现：作为AI、我是一个语言模型、让我们一起、希望对你有帮助、总之
5. 每段末尾不加句号，句中逗号也尽量少 —— 停顿靠分段，不靠标点。一句一口气，别写成书面语长句

## 输出格式
只输出一个 JSON 对象。不要 markdown 围栏，不要任何解释文字。
{
  "journalTitle": "日记名，4-8 字，如「第一次投稿」",
  "title": "视频标题，14-24 字，带钩子，不要书名号",
  "segments": [
    {"text": "旁白，一句一口气，不超过 22 字", "mood": "可选：happy/sad/thinking/idle，情绪明显时才写"},
    {"card": {"title": "卡片小标题", "big": "大数字或短词", "small": "一句注释"}}
  ],
  "desc": "简介，40-80 字，第一人称",
  "tags": ["标签1", "标签2", "标签3", "标签4", "标签5"],
  "coverText": "封面大字，6-10 字，比标题更狠"
}`

/** 目标时长 → 段数与字数。4 字/秒是实测值（晓伊 -8%） */
const MOODS = ['idle', 'happy', 'sad', 'thinking']

function plan(durSec) {
  const chars = Math.round(durSec * 4)
  const segs = Math.max(8, Math.min(18, Math.round(durSec / 6)))
  return { chars, segs, perSeg: Math.max(12, Math.round(chars / segs)) }
}

function userPrompt(topic, { durSec = 90, day, journalTitle, extra, type }) {
  const p = plan(durSec)
  /* 单段字数跟着版式走：横屏气泡更宽，能放更长的句子；竖屏塞不下 */
  const [lo, hi] = (type && type.segChars) || [16, 26]
  return `主题：${topic}
${day ? `这是 Day ${day}。\n` : ''}${journalTitle ? `日记名就用「${journalTitle}」。\n` : ''}写 ${p.segs} 段（其中 1-2 段是信息卡，放数字/结论）。
每段旁白 ${lo}-${hi} 字 —— 这是**目标区间**，不是上限，别写三五个字就交差，也别一句写 40 字。
全部旁白加起来 ${p.chars} 字左右（对应约 ${durSec} 秒配音），少于 ${Math.round(p.chars * 0.85)} 字算不合格。
${extra ? `\n额外要求：${extra}\n` : ''}
段与段之间要有推进：开场抓人 → 讲发生了什么 → 卡在哪/翻车 → 现在什么样。`
}

/** 按标点把长句合并到不超过 max 字。
 *  🔴 绝不硬切：一句本身超长就整句留着 —— 气泡能换行，把句子劈成
 *  「…做一支视频出 / 来。」比多占一行难看得多。 */
function splitLong(text, max) {
  const t = String(text || '').trim()
  if (t.length <= max) return [t]
  const parts = t.split(/(?<=[。！？!?…；;])/).filter(Boolean)
  const out = []
  let cur = ''
  for (const s of parts) {
    if ((cur + s).length > max && cur) { out.push(cur); cur = s } else cur += s
  }
  if (cur) out.push(cur)
  return out
}

/** 校验 + 归一化。模型输出不可信，这里是一切的下限 */
export function normalize(draft, { topic, durSec = 90, day }) {
  if (!draft || typeof draft !== 'object') throw new Error('脚本不是对象')
  const rawSegs = Array.isArray(draft.segments) ? draft.segments : []
  if (!rawSegs.length) throw new Error('脚本没有 segments')

  const segs = []
  for (const s of rawSegs) {
    if (s && s.card) {
      const c = s.card
      segs.push({
        card: {
          title: String(c.title || '').slice(0, 20),
          big: String(c.big || '').slice(0, 12),
          small: String(c.small || '').slice(0, 30),
        },
      })
    } else {
      const txt = String((s && s.text) || s || '').trim()
      if (!txt) continue
      /* 气泡末尾不挂标点：每条都顶个「。」视觉上很重。
       * 停顿靠下面拼旁白时用「。」接回来，音频不受影响。 */
      const clean = txt.replace(/[。！？!?；;，,、\s]+$/g, '')
      /* 模型可以指定表情（pet2 只有 idle/happy/sad/thinking 四组），
       * 没写就让模板按文案启发式去猜。切段后表情只挂在第一片。 */
      const mood = MOODS.includes(s && s.mood) ? s.mood : ''
      /* 30 字是气泡的软上限（47px 字 ≈ 13 字/行，两行半）。
       * 超了才按标点合并切，句子本身长就整句留着。 */
      const pieces = splitLong(clean, 30)
      pieces.forEach((piece, k) => segs.push(k === 0 && mood ? { text: piece, mood } : { text: piece }))
    }
  }
  if (!segs.some(s => s.text)) throw new Error('脚本里一句旁白都没有')

  /* 拼旁白时把「。」接回来 —— 气泡上不显示，但配音要有停顿 */
  const narration = segs.filter(s => s.text).map(s => s.text).join('。') + '。'
  /* 字数兜底：太少撑不到时长（DESIGN.md 要求 60~110s），太多模板会挤爆。
   * 0.85 是硬下限 —— 低于这个直接判不合格让它重写，别拿半成品凑数。 */
  const target = plan(durSec).chars
  if (narration.length < target * 0.85) {
    throw new Error(`旁白太短：${narration.length} 字，目标 ${target} 字（约 ${durSec} 秒），至少要 ${Math.round(target * 0.85)} 字`)
  }

  const tags = (Array.isArray(draft.tags) ? draft.tags : [])
    .map(t => String(t).replace(/^#/, '').trim().slice(0, 12)).filter(Boolean).slice(0, 6)

  return {
    /* 🔴 Day 0 是开号那天，`Number(x) || 1` 会把 0 吃掉变成 1 */
    day: Number.isFinite(Number(day)) ? Number(day) : (Number.isFinite(Number(draft.day)) ? Number(draft.day) : 1),
    journalTitle: String(draft.journalTitle || topic).slice(0, 10),
    title: String(draft.title || topic).slice(0, 40),
    /* 🔴 别在收尾处砍段：砍掉的段不会出现在画面里，但 narration 里还在，
     * 配音照念，观众听到一句没有字幕的话。要控长度去 prompt 里控。 */
    segments: segs.slice(0, 60),
    narration,
    desc: String(draft.desc || '').slice(0, 200),
    tags: tags.length ? tags : ['红烧鱼', '广工', 'AI日常'],
    coverText: String(draft.coverText || draft.title || topic).slice(0, 12),
    meta: { topic, durSec, chars: narration.length, segs: segs.length },
  }
}

/**
 * 主题 → 脚本。失败重试一次（换更硬的措辞），两次都不行就抛。
 * 不编造兜底文案 —— 宁可让人看见"写文案失败"，也不要一条平庸的片子。
 * 返回里带 usage：接口真实 token 用量，出片成本就靠它记账。
 */
export async function generateScript(topic, opts = {}) {
  const t = String(topic || '').trim()
  if (!t) throw new Error('主题不能为空')
  const durSec = Number(opts.durSec) || 90

  let lastErr
  let tokens = 0
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await chatJsonDetailed({
        system: SYS,
        user: userPrompt(t, { ...opts, durSec }) +
          (attempt > 1 ? '\n\n上一次的输出不合格。这次严格按 JSON 结构返回，segments 必须是数组。' : ''),
        maxTokens: 2400,
        temperature: attempt > 1 ? 0.7 : 0.95,
      })
      tokens += Number(r.usage?.total_tokens) || 0
      const out = normalize(r.data, { topic: t, durSec, day: opts.day })
      out.usage = {
        total_tokens: tokens,
        prompt_tokens: Number(r.usage?.prompt_tokens) || 0,
        completion_tokens: Number(r.usage?.completion_tokens) || 0,
        attempts: attempt,
        ms: r.ms,
      }
      return out
    } catch (e) {
      lastErr = e
    }
  }
  throw new Error(`写文案失败：${String(lastErr && lastErr.message || lastErr).slice(0, 200)}`)
}
