/* tools/pet-anim.mjs —— 序列帧 → 带透明通道的循环视频（一次性预处理）
 * ═══════════════════════════════════════════════════════════════
 * assets/pet2/ 里是 4 组 124 帧 webp（713×714、24fps、pingpong）。
 *
 * 为什么不直接逐帧换 <img> 的 src：
 *   124 帧 × 713×714×4B ≈ 254MB 解码内存/组，四组就是 1GB；
 *   而且首轮播放要边播边解码，录制时会掉帧。
 *   编成 webm 交给 <video> 解码，内存是常数、切换是零成本的。
 *
 * 为什么是 VP9 + yuva420p：
 *   Chrome 原生支持带 alpha 的 VP9/WebM，皮套能直接压在页面背景上，
 *   不用 chroma key，也不用把背景烘进视频。
 *
 * pingpong 为什么烘进文件：
 *   <video loop> 只能正放。把 123..2 接在 124 后面，loop 起来就是
 *   一去一回无缝，比在 JS 里来回 seek 稳得多。
 *
 * 用法：node tools/pet-anim.mjs [--force]
 */
import fs from 'node:fs'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'
import { readConfig, run } from '../core/shell.mjs'

const cfg = readConfig()
const SRC = cfg.video?.petFrames
if (!SRC || !fs.existsSync(SRC)) {
  console.error('config.json 里没有 video.petFrames，或目录不存在：', SRC)
  process.exit(1)
}
const OUT = path.join(SRC, 'anim')
fs.mkdirSync(OUT, { recursive: true })

const force = process.argv.includes('--force')
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'))
const fps = Number(manifest.fps) || 24

for (const [clip, info] of Object.entries(manifest.clips || {})) {
  const n = Number(info.frames)
  if (!n) { console.log(`跳过 ${clip}：manifest 没写帧数`); continue }
  const dir = path.join(SRC, clip)
  const first = path.join(dir, `${clip}_001.webp`)
  const last = path.join(dir, `${clip}_${String(n).padStart(3, '0')}.webp`)
  if (!fs.existsSync(first)) { console.log(`跳过 ${clip}：找不到 ${first}`); continue }

  const out = path.join(OUT, `${clip}.webm`)
  if (!force && fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(last).mtimeMs) {
    console.log(`✓ ${clip}.webm 已是最新（${(fs.statSync(out).size / 1048576).toFixed(1)}MB），跳过`)
    continue
  }

  /* 正放 1..n，再反放 n-1..2（掐掉两个端点，接缝才不会重复一帧）。
   * reverse 会把整段帧缓冲在内存里，124 帧约 250MB，一次性开销。 */
  /* 末尾那段 alpha 处理：源帧的 alpha 过渡有 5 个像素宽，而且是白到透明的
   * 渐变 —— 压在粉色背景上就是一圈发白的毛边（用户说的"抠图不干净"）。
   * 把 alpha 曲线压陡（<80 全透、>200 全实），过渡从 5px 收到 1~2px，
   * 边缘立刻利落，而且不会出现锯齿。 */
  const fc = `[0:v]split[a][b];` +
    `[b]reverse,trim=start_frame=1:end_frame=${n - 1},setpts=PTS-STARTPTS[r];` +
    `[a][r]concat=n=2:v=1[cat];` +
    `[cat]format=rgba,split[c][al];` +
    `[al]alphaextract,lut=y='if(lt(val,80),0,if(gt(val,200),255,val))'[a2];` +
    `[c][a2]alphamerge[v]`
  console.log(`编码 ${clip}（${n} 帧 → ${n * 2 - 2} 帧循环）…`)
  const t0 = Date.now()
  const r = await run(ffmpegPath, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(fps), '-i', path.join(dir, `${clip}_%03d.webp`),
    '-filter_complex', fc, '-map', '[v]',
    /* crf 34 是早期的省事设置：alpha 被量化成 8bit 台阶，头发边缘一圈发灰的锯齿。
     * 16 差不多是视觉无损，代价是文件大三倍左右（本地加载，无所谓）。
     * -r 25：录屏是 25fps，素材 24fps 直接喂进去会被重采样，动作一顿一顿的；
     * 这里先补帧到 25，录的时候就是 1:1。 */
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '16',
    '-row-mt', '1', '-cpu-used', '3', '-auto-alt-ref', '0',
    '-r', '25', '-an',
    out,
  ], { timeoutMs: 900000 })
  if (r.code !== 0 || !fs.existsSync(out)) {
    console.error(`✗ ${clip} 编码失败：${r.stderr.slice(-300)}`)
    process.exit(1)
  }
  console.log(`✓ ${clip}.webm ${(fs.statSync(out).size / 1048576).toFixed(1)}MB，${((Date.now() - t0) / 1000).toFixed(1)}s`)
}
console.log('输出目录：' + OUT)
