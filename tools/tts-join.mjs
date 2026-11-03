/* tools/tts-join.mjs —— 把分段配音拼回一条整轨
 * ═══════════════════════════════════════════════════════════════
 * 为什么需要：Remotion 那条链路（Day 1 日报）是「一句一合成」，
 * out/day1/voice/ 里躺着 16 个 seg-NN.mp3 + 一份 timing.json。
 * 发布留档要的是**一条 voice.mp3**，不是 16 个碎片。
 *
 * timing.json 里每段都带 start/end（已含 0.18s 气口），所以拼接**不用重新算间隙**：
 * 直接把每段塞到它的 start 上，空隙用静音填，得到的时间轴和成片口播完全对齐。
 *
 * 用法：
 *   node tools/tts-join.mjs --dir video/out/day1/voice --out video/out/day1/voice.mp3
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { ROOT, logEvent } from '../core/log.mjs'
import { run } from '../core/shell.mjs'

const args = process.argv.slice(2)
const get = k => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }

const dir = path.resolve(ROOT, get('dir') || 'video/out/day1/voice')
const out = path.resolve(ROOT, get('out') || path.join(dir, '..', 'voice.mp3'))

const timing = JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'))
const segs = (timing.segments || []).filter(s => s.file)
if (!segs.length) { console.error('timing.json 里没有分段'); process.exit(1) }

/* 逐段 adelay 到它的 start（毫秒），再 amix 混合。
 * amix 的 normalize=0 是必须的：默认会按输入数把音量压到 1/16。 */
const inputs = []
const filters = []
const labels = []
segs.forEach((s, i) => {
  const f = path.join(dir, s.file)
  if (!fs.existsSync(f)) { console.error('缺文件：' + s.file); process.exit(1) }
  inputs.push('-i', f)
  const ms = Math.max(0, Math.round((s.start || 0) * 1000))
  filters.push(`[${i}:a]adelay=${ms}|${ms},aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`)
  labels.push(`[a${i}]`)
})

const total = Number(timing.total) || segs.reduce((m, s) => Math.max(m, s.end || 0), 0)
const filter = [
  ...filters,
  `${labels.join('')}amix=inputs=${segs.length}:normalize=0:dropout_transition=0[mix]`,
  `[mix]apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[out]`,
].join(';')

const r = await run(ffmpegPath, [
  '-y', '-v', 'error',
  ...inputs,
  '-filter_complex', filter,
  '-map', '[out]',
  '-c:a', 'libmp3lame', '-b:a', '192k',
  out,
], { timeoutMs: 180000 })

if (r.code !== 0) { console.error('ffmpeg 失败：' + String(r.stderr).slice(-500)); process.exit(1) }

const st = fs.statSync(out)
console.log(`拼好 ${segs.length} 段 → ${path.relative(ROOT, out)}`)
console.log(`  时长 ${total.toFixed(2)}s  ${(st.size / 1024).toFixed(0)} KB`)
logEvent('video', 'tts-join', { segs: segs.length, total, out: path.relative(ROOT, out) })
