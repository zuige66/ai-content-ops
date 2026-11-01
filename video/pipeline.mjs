/* video/pipeline.mjs —— 一条龙：主题 → 文案 → 成片
 * ═══════════════════════════════════════════════════════════════
 * 把最上游那两段接起来。之前要「人写 segments → 点做视频」，
 * 现在给一个主题就行。
 *
 * 刻意不做成黑盒：中间的脚本会完整写进 job.result.script，
 * 控制台能看见、能改、能重跑。写文案和出片也可以分开调
 * （/video/script 只写文案不渲染），改一版文案不用重渲 80 秒。
 */
import { generateScript } from './script.mjs'
import { makeVideo } from './make.mjs'
import { makeCover } from './cover.mjs'
import { getType } from './types.mjs'
import { readConfig } from '../core/shell.mjs'
import path from 'node:path'

export async function runPipeline(job, { step }) {
  const p = job.params
  const cfg = readConfig()
  const topic = String(p.topic || '').trim()
  if (!topic) throw new Error('要给一个主题')
  const type = getType(p.template)
  step(`类型：${type.name}（${type.tag}）`)

  /* 1. 写文案 */
  step(`写文案：${topic.slice(0, 40)}`)
  const script = await generateScript(topic, {
    durSec: Number(p.durSec) || cfg.video?.durSec || 90,
    day: p.day,
    journalTitle: p.journalTitle,
    extra: p.extra,
    type,
  })
  step(`文案好了：${script.segments.length} 段 / ${script.meta.chars} 字 / 约 ${Math.round(script.meta.chars / 4.4)}s`)
  step(`token：${script.usage.total_tokens}（prompt ${script.usage.prompt_tokens} + 输出 ${script.usage.completion_tokens}）`)
  step(`标题「${script.title}」`)

  /* 2. 出片 */
  const r = await makeVideo({
    id: job.id,
    params: {
      template: type.id,
      title: script.title,
      day: script.day,
      journalTitle: script.journalTitle,
      segments: script.segments,
      narration: script.narration,
      petImage: p.petImage || cfg.video?.petImage,
    },
  }, { step })

  /* 3. 封面：零 token，几秒钟，顺手就出了。失败不算整条挂掉 ——
   *    片子已经渲完了，不能因为一张图把它判死。 */
  let cover = null
  try {
    step('出封面')
    cover = await makeCover({
      big: script.coverText || script.journalTitle,
      sub: script.title,
      day: script.day,
      out: path.join(path.dirname(r.mp4), 'cover.png'),
    })
    step(`封面 ${cover.width}×${cover.height}`)
  } catch (e) {
    step('封面失败（不影响成片）：' + String(e).slice(0, 80))
  }

  /* 4. 把脚本一起交出去 —— 发布时标题/简介/标签直接从这儿取 */
  return {
    ...r, script, cover,
    type: { id: type.id, name: type.name, width: type.width, height: type.height },
  }
}
