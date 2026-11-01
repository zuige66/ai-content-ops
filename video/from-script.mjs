/* video/from-script.mjs —— 已有脚本 JSON → 成片 + 封面
 * ═══════════════════════════════════════════════════════════════
 * 什么时候用它：
 *   /pipeline/run 是「主题 → 文案 → 出片」全自动，但文案经常要人改。
 *   改完 _script_xxx.json 之后不用重跑 LLM，直接拿这份 JSON 出片 ——
 *   零 token，只花 TTS 和渲染时间。
 *
 * 用法：
 *   node video/from-script.mjs _script_day0.json
 *   node video/from-script.mjs _script_day0.json --template diary
 *   node video/from-script.mjs _script_day0.json --no-cover
 */
import fs from 'node:fs'
import path from 'node:path'
import { makeVideo } from './make.mjs'
import { makeCover } from './cover.mjs'
import { getType } from './types.mjs'

const args = process.argv.slice(2)
const file = args.find(a => !a.startsWith('--') && a.endsWith('.json'))
if (!file) {
  console.error('用法：node video/from-script.mjs <脚本.json> [--template talk|diary] [--no-cover]')
  process.exit(1)
}
const flag = k => args.includes('--' + k)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }

const s = JSON.parse(fs.readFileSync(file, 'utf8'))
const type = getType(opt('template', 'talk'))
const id = `${type.id}-${Date.now()}`

const r = await makeVideo({
  id,
  params: {
    template: type.id,
    title: s.title,
    day: s.day,
    journalTitle: s.journalTitle,
    segments: s.segments,
  },
}, { step: m => console.log('·', m) })

let cover = null
if (!flag('no-cover')) {
  /* 副标题取简介第一句；第一句太短（「抖音第一条。」）就并上第二句，
   * 不然封面上挂一句没信息量的话 */
  const parts = String(s.desc || '').split('。').filter(Boolean)
  let sub = parts[0] ? parts[0] + '。' : ''
  if (sub.length < 12 && parts[1]) sub += parts[1] + '。'
  cover = await makeCover({
    big: s.coverText || s.journalTitle,
    sub,
    day: s.day,
    out: path.join(r.dir, 'cover.png'),
  })
}

console.log(JSON.stringify({ dir: r.dir, mp4: r.mp4, dur: r.dur, cover: cover && cover.png }, null, 1))
