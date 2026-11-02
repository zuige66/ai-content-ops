/* video/audio.mjs —— 声音层：BGM 垫底 + SFX 钉帧
 *
 * 之前整片只有一条 TTS 人声，5 次硬切全是无声的「啪」。
 * 规则（video-shotcraft/references/sound-design.md）：
 *   S1 配乐与音效按"片种"选，不按"事件"选
 *   S4 拟音优先于装饰音，音频裁到与动作严格等长
 *   S2 连发要双样本交替 + 音量阶梯递减，否则读作机枪
 *
 * 素材来自 video-shotcraft 自带的 Mixkit 免费音效（可商用、免署名），
 * 已复制到 video/assets/audio/，不依赖 D:/tools 是否还在。
 */
import fs from 'fs'
import path from 'path'
import ffmpegPath from 'ffmpeg-static'
import { execFile } from 'child_process'

const SFX_DIR = path.resolve('video/assets/audio/sfx')
const BGM_DIR = path.resolve('video/assets/audio/bgm')

const run = (args, timeoutMs = 180000) => new Promise(res => {
  execFile(ffmpegPath, args, { timeout: timeoutMs, maxBuffer: 1 << 26 },
    (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
})

/* ── 音效时间表 ─────────────────────────────────────────────────
 * 每条 = 一个画面动作。**钉在动作发生的时刻**，不是钉在切镜时刻。
 * trim 是播放窗口：impact-cine 有 4.1s 尾巴，不裁会糊住下一镜。
 *
 * 🔴 音量是乘法系数，不是目标响度。人声在 1.0，SFX 超过 0.6 就会
 * 把口播盖掉 —— 这套片子是「讲给你听」，声音只能是配角。
 */
export function buildSfxTimeline({ starts = [], shots = [], introEnd = 1.35 }) {
  const ev = []
  const push = (t, file, vol, trim) => {
    if (!Number.isFinite(t) || t < 0) return
    ev.push({ t: +t.toFixed(3), file, vol, trim })
  }

  /* ① 封面入场：一声闷的 whoosh，把画面"推"上来 */
  push(0.02, 'whoosh-big.mp3', 0.26, 1.2)

  /* ② 解构转场落地：impact 是这一下唯一的重量，全片只给 2 次
     （开场 + 结尾峰值），中间不许再砸。 */
  push(introEnd - 0.12, 'impact-cine.mp3', 0.5, 1.5)
  push(introEnd, 'transition-soft.mp3', 0.2, 0.9)

  /* ③ 逐镜动作音 */
  shots.forEach((s, i) => {
    const t = starts[i]
    if (!Number.isFinite(t)) return

    /* 切镜本身：轻扫。第一镜的切镜已经由转场 impact 承担，跳过 */
    if (i > 0) push(t - 0.03, i % 2 ? 'transition-soft.mp3' : 'swoosh-quick.mp3', 0.24, 0.8)

    const k = s.kind || 'shot'

    if (k === 'shot') {
      /* 截图滑入 + 数字滚动。有 big 才有滚数字那一下 */
      push(t + 0.1, 'swoosh-quick.mp3', 0.2, 0.6)
      if (s.big) push(t + 0.26, 'pop.mp3', 0.3, 0.5)
    } else if (k === 'strike') {
      /* 两行划线：同一个音色不能连发两次，第二条换音色 + 降音量 */
      push(t + 0.24, 'swoosh-quick.mp3', 0.26, 0.5)
      push(t + 0.4, 'pop.mp3', 0.16, 0.4)
    } else if (k === 'duo') {
      /* 两张卡滑入 + 脉冲起跑 */
      push(t + 0.08, 'swoosh-quick.mp3', 0.22, 0.6)
      push(t + 0.2, 'pop.mp3', 0.18, 0.5)
    } else if (k === 'core') {
      /* 剖面三层依次落位，三条音阶梯递减（S2 的"不同响度复读"） */
      push(t + 0.16, 'pop.mp3', 0.24, 0.4)
      push(t + 0.34, 'pop.mp3', 0.18, 0.4)
      push(t + 0.52, 'pop.mp3', 0.13, 0.4)
    } else if (k === 'finale') {
      /* 收尾峰值：元素飞入 → 落定 → 地址压印 */
      push(t + 0.06, 'whoosh-fast.mp3', 0.34, 1.1)
      push(t + 0.34, 'pop.mp3', 0.2, 0.5)
      push(t + 0.62, 'impact-cine.mp3', 0.46, 1.6)
    }
  })

  return ev
}

/* ── 混音 ───────────────────────────────────────────────────────
 * BGM 用 sidechaincompress 跟着人声自动让路：说话时压下去，间隙抬回来。
 * 比固定音量好在「不说话的地方音乐是活的」，又不抢字。
 */
export async function mixAudio({ voice, out, dur, starts, shots, introEnd, bgm = true }) {
  const ev = buildSfxTimeline({ starts, shots, introEnd })
  const missing = ev.filter(e => !fs.existsSync(path.join(SFX_DIR, e.file)))
  if (missing.length) throw new Error('缺音效文件：' + [...new Set(missing.map(m => m.file))].join(', '))

  const bgmPath = path.join(BGM_DIR, 'tech-house.mp3')
  const useBgm = bgm && fs.existsSync(bgmPath)

  const inputs = ['-i', voice]
  if (useBgm) inputs.push('-stream_loop', '-1', '-i', bgmPath)
  for (const e of ev) inputs.push('-i', path.join(SFX_DIR, e.file))

  const parts = []
  /* 人声先统一成单声道 44.1k，后面 amix 才不会因为采样率不一致失败。
     🔴 有 BGM 时必须 asplit 成两路：同一个带标签的输出 pad 只能被消费一次，
     人声既要进 amix（出声）又要当侧链（压 BGM），不拆就报
     「Invalid stream specifier」，而且报错指向标签名，很容易误判成拼写问题。 */
  if (useBgm) {
    parts.push(`[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,volume=1.0,asplit=2[vox][voxpre]`)
  } else {
    parts.push(`[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,volume=1.0[vox]`)
  }

  let bgmTag = null
  if (useBgm) {
    const fadeOutStart = Math.max(0, dur - 1.8)
    parts.push(
      `[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,` +
      `atrim=0:${dur},asetpts=N/SR/TB,` +
      `volume=0.16,` +
      `afade=t=in:st=0:d=1.4,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=1.8[bgmraw]`
    )
    /* 🔴 侧链必须 apad 到全片长度。
       sidechaincompress 的输出长度跟着**侧链**走，而人声只有 28.2s、
       画面 29.3s —— 不补的话 BGM 到 28.2s 就断了，最后 1 秒是死寂。
       这个错不报错，只是片子尾巴突然安静。 */
    parts.push(`[voxpre]apad=whole_dur=${dur}[voxsc]`)
    /* 侧链压缩：人声一响，BGM 自动让路。threshold 0.06 对应正常口播电平 */
    parts.push(`[bgmraw][voxsc]sidechaincompress=threshold=0.06:ratio=7:attack=12:release=380:makeup=1[bgm]`)
    bgmTag = 'bgm'
  }

  const sfxTags = []
  ev.forEach((e, n) => {
    const ms = Math.round(e.t * 1000)
    const tag = `sfx${n}`
    parts.push(
      `[${n + (useBgm ? 2 : 1)}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=mono,` +
      `atrim=0:${e.trim},asetpts=N/SR/TB,` +
      `volume=${e.vol},` +
      `afade=t=out:st=${Math.max(0, e.trim - 0.12).toFixed(2)}:d=0.12,` +
      `adelay=${ms}:all=1[${tag}]`
    )
    sfxTags.push(tag)
  })

  const mixIn = ['vox', ...(bgmTag ? [bgmTag] : []), ...sfxTags]
  parts.push(
    mixIn.map(t => `[${t}]`).join('') +
    /* duration=longest 而不是 first：人声比画面短（TTS 收在 28.2s，
       画面 29.3s），用 first 的话最后 1 秒连 BGM 都没了，尾巴是死寂。
       长度由后面的 atrim 收口。 */
    `amix=inputs=${mixIn.length}:duration=longest:normalize=0,` +
    `alimiter=limit=0.95,` +
    `atrim=0:${dur},asetpts=N/SR/TB[aout]`
  )

  const r = await run([
    '-y', ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[aout]',
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1',
    '-t', String(dur),
    out,
  ])
  if (r.code !== 0) throw new Error('混音失败：' + r.stderr.slice(-2000))
  return { out, events: ev.length, bgm: useBgm }
}
