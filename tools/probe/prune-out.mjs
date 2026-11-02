/* video/out 清理：同一标题反复出的片子只留最新一条
 *
 * 为什么不用 gc.mjs：gc 只认「空壳目录 / 散落文件 / 原始录屏」，
 * 看不出「同一个标题出了 8 遍」这种语义重复。
 *
 * 规则（保守，默认只预览）：
 *   · 按 voice.marks.json 里的旁白首句分组
 *   · 每组只保留**最新**的那一条（创建时间最晚）
 *   · 其余标记为可删
 *   · 跨标题的（talk 那条、最新那条）一律不动
 *
 * 用法：
 *   node tools/probe/prune-out.mjs          预览
 *   node tools/probe/prune-out.mjs --apply  真删
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from '../../core/log.mjs'

const OUT = path.join(ROOT, 'video', 'out')
const APPLY = process.argv.includes('--apply')
const KEEP = new Set(['publish', 'cover', 'preview'])

function titleOf(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'voice.marks.json'), 'utf8'))
    const t = String(m.text || '').trim()
    return t.split(/[。！？!?\n]/)[0].trim().slice(0, 40)
  } catch { return '' }
}

const dirs = []
for (const d of fs.readdirSync(OUT, { withFileTypes: true })) {
  if (!d.isDirectory() || KEEP.has(d.name) || d.name.startsWith('.')) continue
  const dir = path.join(OUT, d.name)
  const mp4 = path.join(dir, 'video.mp4')
  let st
  try { st = fs.statSync(mp4) } catch { continue }
  if (!st.isFile()) continue
  dirs.push({
    name: d.name,
    dir,
    title: titleOf(dir),
    mtime: st.mtimeMs,
    bytes: st.size,
    sizeMB: Math.round((st.size / 1048576) * 10) / 10,
  })
}

/* 按标题分组；没有标题的各自独立成组（不参与去重，怕误删） */
const groups = new Map()
dirs.forEach((x, i) => {
  const key = x.title || `__no_title_${i}__`
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(x)
})

const doomed = []
const keep = []
for (const [title, list] of groups) {
  list.sort((a, b) => b.mtime - a.mtime)          // 最新在前
  keep.push(list[0])
  if (list.length > 1) doomed.push(...list.slice(1))
}

console.log(`共 ${dirs.length} 个成片目录，${groups.size} 个不同标题\n`)
console.log('=== 保留（每组最新一条）===')
keep.forEach((x) => console.log(`  ✓ ${x.name}  ${String(x.sizeMB).padStart(6)}MB  ${x.title}`))

if (doomed.length) {
  console.log('\n=== 可删（同标题的旧版本）===')
  let mb = 0
  doomed.forEach((x) => { mb += x.sizeMB; console.log(`  ✗ ${x.name}  ${String(x.sizeMB).padStart(6)}MB  ${x.title}`) })
  console.log(`\n合计可省 ${Math.round(mb * 10) / 10} MB`)
} else {
  console.log('\n没有重复标题的片子')
}

if (!APPLY) {
  console.log('\n这是预览。真删：node tools/probe/prune-out.mjs --apply')
  process.exit(0)
}

if (!doomed.length) process.exit(0)

console.log('\n=== 执行删除 ===')
let n = 0
for (const x of doomed) {
  /* 双保险：只删 OUT 里面的 */
  const abs = path.resolve(x.dir)
  if (abs !== OUT && !abs.startsWith(OUT + path.sep)) { console.log('  拒绝（越界）:', x.dir); continue }
  try {
    fs.rmSync(abs, { recursive: true, force: true })
    console.log('  删了', x.name)
    n++
  } catch (e) { console.log('  失败', x.name, String(e.message).slice(0, 80)) }
}
console.log(`\n删了 ${n} 个目录`)
