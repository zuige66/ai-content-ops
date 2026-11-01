/* core/shell.mjs —— 子进程封装：外部命令一律带超时，绝不无限等 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './log.mjs'

/**
 * 读 config.json。
 * 第一次 clone 下来没有这个文件（它在本机是要改路径的，不进仓库），
 * 这时自动从 config.example.json 复制一份 —— 省得人卡在"启动就报错"。
 * 复制出来的还是占位符路径，跑视频时会明确告诉你哪一项要改。
 */
export function readConfig() {
  const p = path.join(ROOT, 'config.json')
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    const ex = path.join(ROOT, 'config.example.json')
    if (!fs.existsSync(ex)) throw e
    try {
      fs.copyFileSync(ex, p)
      return JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch {
      throw e
    }
  }
}

export function run(cmd, args, { timeoutMs = 120000, cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true })
    let stdout = '', stderr = '', done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; p.kill(); resolve({ code: -1, stdout, stderr: stderr + '\n[超时]' }) }
    }, timeoutMs)
    p.stdout.on('data', b => { stdout += b })
    p.stderr.on('data', b => { stderr += b })
    p.on('error', e => { clearTimeout(timer); if (!done) { done = true; resolve({ code: -1, stdout, stderr: String(e) }) } })
    p.on('close', code => { clearTimeout(timer); if (!done) { done = true; resolve({ code, stdout, stderr }) } })
  })
}

/** 大肥鱼的声音：直接调 zhibo 的 tools/tts.py（edge-tts，无密钥、带缓存）。
 *  返回 {file, dur, marks} —— dur 是秒，视频动画按时长对齐就靠它；
 *  marks 是逐句时间戳 [{t,d,text}]（毫秒），弹幕按它对齐才不会漂。
 *  老版本 tts.py 不认 --timing-out，那时 marks 是空数组，调用方自己回退。 */
export async function ttsSynth(text, outPath, { timing = true } = {}) {
  const cfg = readConfig().tts
  const timingOut = timing ? outPath.replace(/\.mp3$/i, '') + '.marks.json' : ''
  const args = [cfg.script, '--text', text, '--voice', cfg.voice, `--rate=${cfg.rate}`, '--out', outPath]
  if (timingOut) args.push('--timing-out', timingOut)
  const r = await run(cfg.python, args, { timeoutMs: 120000 })
  let j = null
  try { j = JSON.parse(r.stdout.trim().split('\n').pop()) } catch { /* 不是 JSON 就当失败 */ }
  if (r.code !== 0 || !j || !j.ok || !j.file) {
    throw new Error(`TTS 失败：${(j && j.error) || r.stderr.slice(-300) || r.stdout.slice(-300)}`)
  }
  // tts.py 默认写进它自己的缓存目录；指定 --out 时直接落我们给的路径。
  // 有的版本忽略 --out，那就从返回的 file 拷过来，两个行为都兼容。
  if (path.resolve(j.file) !== path.resolve(outPath)) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.copyFileSync(j.file, outPath)
  }
  let marks = Array.isArray(j.marks) ? j.marks : []
  if (!marks.length && timingOut && fs.existsSync(timingOut)) {
    try { marks = JSON.parse(fs.readFileSync(timingOut, 'utf8')).marks || [] } catch { /* 读不到就算了 */ }
  }
  return { file: outPath, dur: Number(j.dur) || 0, marks }
}
