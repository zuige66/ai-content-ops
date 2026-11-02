import ffmpegPath from 'ffmpeg-static'
import { spawnSync } from 'child_process'

const f = process.argv[2]
const probe = args => {
  const r = spawnSync(ffmpegPath, args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  return (r.stderr || '') + (r.stdout || '')
}

const win = (t, d = 0.12) => {
  /* 用 atrim 取样，不用 -ss：-ss 放 -i 前是按关键帧跳（实测偏一秒以上），
     放 -i 后又先跑完整段滤镜再 seek，volumedetect 量的还是全片。 */
  const o = probe(['-hide_banner', '-i', f, '-af',
    `atrim=start=${t.toFixed(3)}:duration=${d},volumedetect`, '-f', 'null', '-'])
  const mx = o.match(/max_volume:\s*(-?[\d.]+)/)
  const mn = o.match(/mean_volume:\s*(-?[\d.]+)/)
  return [mx ? mx[1] : '?', mn ? mn[1] : '?']
}

const points = [
  ['封面静默(0.30)', 0.30],
  ['封面入场 whoosh(0.05)', 0.05],
  ['转场 impact(0.75)', 0.75],
  ['转场后(1.20)', 1.20],
  ['镜1 稳定(2.60)', 2.60],
  ['切镜2前(4.60)', 4.60],
  ['切镜2(4.76)', 4.76],
  ['镜2 划线(5.02)', 5.02],
  ['镜2 稳定(6.50)', 6.50],
  ['切镜3(10.07)', 10.07],
  ['镜3 稳定(12.0)', 12.0],
  ['切镜4(16.26)', 16.26],
  ['镜4 稳定(18.0)', 18.0],
  ['切镜5(21.04)', 21.04],
  ['收尾 impact(21.70)', 21.70],
  ['片尾(28.6)', 28.6],
]
console.log('窗口'.padEnd(24) + 'max_dB   mean_dB')
for (const [name, t] of points) {
  const [mx, mn] = win(t)
  console.log(name.padEnd(24) + mx.padStart(6) + '  ' + mn.padStart(7))
}
