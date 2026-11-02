import ffmpegPath from 'ffmpeg-static'
import { spawnSync } from 'child_process'

const f = process.argv[2] || 'video/out/test-mix.wav'
const probe = args => {
  const r = spawnSync(ffmpegPath, args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  return (r.stderr || '') + (r.stdout || '')
}

const all = probe(['-hide_banner', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'])
console.log(all.split('\n').filter(l => /mean_volume|max_volume|Duration/.test(l)).join('\n'))

console.log('--- 逐秒 RMS (dB) ---')
const rows = []
for (let t = 0; t < 29; t++) {
  const o = probe(['-hide_banner', '-ss', String(t), '-t', '1', '-i', f, '-af', 'astats', '-f', 'null', '-'])
  const m = o.match(/RMS level dB:\s*(-?[\d.]+)/)
  rows.push(t.toString().padStart(2) + 's ' + (m ? m[1] : '?'))
}
console.log(rows.join('  '))
