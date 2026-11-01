/* video/library.mjs —— 本地成片库
 * ═══════════════════════════════════════════════════════════════
 * 视频工坊原来只显示「当前这一个任务」的产物，关掉页面/重启服务就
 * 再也找不到之前出过的片子了 —— 明明 video/out/ 里躺着 mp4。
 *
 * 这里把磁盘扫一遍，和 jobs.json 的记录对起来，分三类：
 *   · 有文件 + 有记录 → 正常成片，带标题
 *   · 有文件 + 没记录 → 脚本直接跑出来的（比如 tools 里的），标题用目录名
 *   · 有记录 + 没文件 → 标 missing，明确告诉人"这条被删了"，别让人以为丢数据
 *
 * 只读，不删任何东西。
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../core/log.mjs'
import { listJobs } from '../core/jobs.mjs'

const OUT = path.join(ROOT, 'video', 'out')
/* publish/ 是投稿截图、cover/ 是单张封面，都不是成片 */
const NOT_FILMS = new Set(['publish', 'cover'])

const mediaUrl = (abs) => '/media/' + path.relative(OUT, abs).replace(/\\/g, '/')

const exists = (p) => {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** 任务标题前面都带「视频：」「一条龙：」这种前缀，列表里去掉更好读 */
function cleanTitle(t) {
  return String(t || '').replace(/^(视频|一条龙|投稿抖音|投稿B站)：/, '').trim()
}

/**
 * 没有任务记录时（比如脚本直接跑出来的 talk-xxx），从旁白标记里捞标题。
 * voice.marks.json 里存着配音全文，取第一句就够 —— 比光看目录名强。
 */
function titleFromVoice(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'voice.marks.json'), 'utf8'))
    const t = String(m.text || '').trim()
    if (!t) return ''
    const first = t.split(/[。！？!?\n]/)[0].trim()
    return (first || t).slice(0, 42)
  } catch { return '' }
}

export function listLibrary() {
  const byDir = new Map()

  /* ── 1. 磁盘上真有 mp4 的目录 ── */
  let dirs = []
  try {
    dirs = fs.readdirSync(OUT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !NOT_FILMS.has(d.name))
      .map((d) => d.name)
  } catch { /* 目录还没建，返回空表 */ }

  for (const name of dirs) {
    const dir = path.join(OUT, name)
    const mp4 = path.join(dir, 'video.mp4')
    let st
    try { st = fs.statSync(mp4) } catch { continue }
    if (!st.isFile()) continue

    const cover = path.join(dir, 'cover.png')
    const frames = fs.readdirSync(dir).filter((f) => /^frame-\d+\.png$/.test(f)).sort()
    byDir.set(name, {
      id: name,
      title: titleFromVoice(dir),
      kind: '',
      jobId: '',
      mp4: mediaUrl(mp4),
      cover: exists(cover) ? mediaUrl(cover) : '',
      keyframe: frames.length ? mediaUrl(path.join(dir, frames[0])) : '',
      frames: frames.length,
      mtime: st.mtimeMs,
      sizeMB: Math.round((st.size / 1048576) * 10) / 10,
      missing: false,
    })
  }

  /* ── 2. jobs.json 里的记录：补标题，顺便找出文件已经没了的 ── */
  for (const j of listJobs({ limit: 300 })) {
    const mp4 = j.result && j.result.mp4
    if (!mp4) continue
    const name = path.basename(path.dirname(String(mp4)))
    if (!name || name === '.' || name === 'out') continue

    const hit = byDir.get(name)
    if (hit) {
      const t = cleanTitle(j.title)
      if (t) hit.title = t          // 任务标题比旁白首句准，有就用它
      hit.kind = j.kind || ''
      hit.jobId = j.id
    } else {
      byDir.set(name, {
        id: name,
        title: cleanTitle(j.title),
        kind: j.kind || '',
        jobId: j.id,
        mp4: '',
        cover: '',
        keyframe: '',
        frames: 0,
        mtime: Number(j.updatedAt) || 0,
        sizeMB: 0,
        missing: true,
      })
    }
  }

  const items = [...byDir.values()].sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  return {
    ok: true,
    dir: OUT,
    items,
    total: items.length,
    present: items.filter((x) => !x.missing).length,
    missing: items.filter((x) => x.missing).length,
  }
}
