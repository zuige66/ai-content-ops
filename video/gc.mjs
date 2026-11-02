/* video/gc.mjs —— video/out 的清理
 * ═══════════════════════════════════════════════════════════════
 * 这个目录本来只该放「成片」，实际会攒出四类垃圾：
 *   1. 失败任务的空壳目录（只剩一个 0 字节的 voice.mp3.part）
 *   2. 散落在根目录的调试截图（edit-open.png 之类）
 *   3. publish/ 下过期的投稿截图目录
 *   4. 成片目录里的 page@*.webm —— Playwright 原始录屏，一个片子 45MB
 *
 * 默认 **只预览不删**（dryRun），要真删得显式传 apply。
 * webm 单独用 raw 开关：它删了要重跑才能回来，虽然只是中间产物，
 * 但别让人手滑一次全没了。
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, logEvent } from '../core/log.mjs'

const OUT = path.join(ROOT, 'video', 'out')

const mb = (n) => Math.round((n / 1048576) * 10) / 10

/** 只在 OUT 内部动手，别让任何路径穿越把外面删了 */
function safeIn(p) {
  const abs = path.resolve(p)
  return abs === OUT || abs.startsWith(OUT + path.sep) ? abs : null
}

function sizeOf(p) {
  try {
    const st = fs.statSync(p)
    if (st.isFile()) return st.size
    return fs.readdirSync(p).reduce((s, f) => s + sizeOf(path.join(p, f)), 0)
  } catch { return 0 }
}

export function gc({ apply = false, raw = false, publish = false } = {}) {
  const items = []   // { kind, path, why, bytes }

  let dirs = []
  try {
    dirs = fs.readdirSync(OUT, { withFileTypes: true })
  } catch {
    return { ok: true, dir: OUT, apply, items: [], freedMB: 0, note: 'video/out 还不存在' }
  }

  /* ── 1. 根目录散落的文件（截图之类，成片必须是目录） ── */
  for (const d of dirs) {
    if (!d.isFile()) continue
    const p = path.join(OUT, d.name)
    items.push({ kind: 'stray-file', path: p, why: '根目录只该有子目录；调试截图应在 state/', bytes: sizeOf(p) })
  }

  /* ── 2. 空壳目录：没有 video.mp4，且只有 0 字节残渣 ── */
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    if (d.name === 'publish' || d.name === 'cover') continue
    const dir = path.join(OUT, d.name)
    if (fs.existsSync(path.join(dir, 'video.mp4'))) continue

    const files = []
    const walk = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const f = path.join(p, e.name)
        if (e.isDirectory()) walk(f)
        else files.push(f)
      }
    }
    try { walk(dir) } catch { continue }

    const allJunk = files.every((f) => /\.part$/.test(f) || sizeOf(f) === 0)
    if (allJunk) {
      items.push({
        kind: 'empty-dir', path: dir, bytes: sizeOf(dir),
        why: files.length ? `只有残渣（${files.map((f) => path.basename(f)).join(', ')}）` : '空目录',
      })
    }
  }

  /* ── 3. 原始录屏：合成完就没用了，但删了要重跑才能回来，所以单独开关 ── */
  if (raw) {
    for (const d of dirs) {
      /* publish/ 是投稿截图，cover/ 是散图 —— 两个都没有 video.mp4，
       * 下面那句 existsSync 本来就会跳过它们。这里只排除 publish，
       * 是为了让 cover/ 万一将来带上 mp4 也能被清；两处判断保持一致。 */
      if (!d.isDirectory() || d.name === 'publish') continue
      const dir = path.join(OUT, d.name)
      if (!fs.existsSync(path.join(dir, 'video.mp4'))) continue   // 没成片的别动，那是别人正在跑
      let files = []
      try { files = fs.readdirSync(dir) } catch { continue }
      for (const f of files) {
        if (!/^page@.*\.(webm|mp4)$/i.test(f)) continue
        const p = path.join(dir, f)
        items.push({ kind: 'raw-recording', path: p, why: 'Playwright 原始录屏，mp4 已合成', bytes: sizeOf(p) })
      }
    }
  }

  /* ── 4. 投稿截图：每投一次攒 3 张 png，失败/测试的留一堆 ── */
  if (publish) {
    const pdir = path.join(OUT, 'publish')
    let subs = []
    try { subs = fs.readdirSync(pdir, { withFileTypes: true }).filter((x) => x.isDirectory()) } catch { /* 没有 */ }
    for (const s of subs) {
      const p = path.join(pdir, s.name)
      const n = fs.readdirSync(p).length
      items.push({
        kind: 'publish-shots', path: p, bytes: sizeOf(p),
        why: n ? `${n} 张投稿截图（dry-run 留痕）` : '空目录',
      })
    }
  }

  const bytes = items.reduce((s, x) => s + x.bytes, 0)
  const out = {
    ok: true, dir: OUT, apply, raw, publish,
    items: items.map((x) => ({ ...x, path: path.relative(OUT, x.path).replace(/\\/g, '/'), sizeMB: mb(x.bytes) })),
    count: items.length,
    freedMB: mb(bytes),
  }

  if (!apply) {
    out.note = '这是预览。要真删：POST /video/gc {apply:true}；连原始录屏一起删再加 raw:true'
    return out
  }

  /* ── 执行 ── */
  let deleted = 0
  const failed = []
  for (const it of items) {
    const p = safeIn(it.path)
    if (!p) { failed.push({ path: it.path, error: '不在 video/out 里，拒绝' }); continue }
    try {
      fs.rmSync(p, { recursive: true, force: true })
      deleted++
    } catch (e) {
      failed.push({ path: it.path, error: String(e.message || e).slice(0, 120) })
    }
  }
  out.deleted = deleted
  out.failed = failed
  out.note = `删了 ${deleted} 项，省 ${mb(bytes)}MB${failed.length ? `；${failed.length} 项失败` : ''}`
  logEvent('video', 'gc', { ok: true, deleted, mb: mb(bytes), raw, publish })
  return out
}
