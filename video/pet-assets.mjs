/* video/pet-assets.mjs —— 皮套素材清单（模板和封面都从这里取）
 * ═══════════════════════════════════════════════════════════════
 * 序列帧本身不能直接喂给浏览器（254MB 解码内存/组），
 * tools/pet-anim.mjs 会先把它们编成 anim/<clip>.webm。
 * 这里只负责回答「有哪些 clip 能用、绝对路径是什么」。
 *
 * 素材缺失不报错 —— 模板会自动退回静图，宁可少点动效也别录不出片。
 */
import fs from 'node:fs'
import path from 'node:path'

export const fileUrl = p => 'file:///' + path.resolve(p).replace(/\\/g, '/')

export function petPayload(cfg) {
  const dir = cfg.video?.petFrames
  const animDir = dir ? path.join(dir, 'anim') : ''
  let clips = []
  if (animDir && fs.existsSync(animDir)) {
    clips = fs.readdirSync(animDir)
      .filter(f => f.toLowerCase().endsWith('.webm'))
      .map(f => path.basename(f, path.extname(f)))
  }
  const still = cfg.video?.petImage
  /* 表情图：{happy, surprise, smug, idle} → file:// 地址。
   * 只保留真实存在的，缺一张就少一张，模板里 faces 只有一张时自动退回静图。 */
  const faces = {}
  const faceCfg = cfg.video?.petFaces
  if (faceCfg && typeof faceCfg === 'object') {
    for (const [k, p] of Object.entries(faceCfg)) {
      if (typeof p === 'string' && p && fs.existsSync(p)) faces[k] = fileUrl(p)
    }
  }
  return {
    /* code = 纯网页代码驱动静图（呼吸/摇摆/点头），边缘绝对干净、零成本；
     * frames = 用 AI 生成的序列帧（有表情，但素材贴边裁过，头顶和尾巴会被切） */
    mode: cfg.video?.petMode === 'frames' ? 'frames' : 'code',
    anim: animDir && fs.existsSync(animDir) ? fileUrl(animDir) : '',
    clips,
    still: still && fs.existsSync(still) ? fileUrl(still) : '',
    faces,
  }
}
