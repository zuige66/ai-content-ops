/* video/types.mjs —— 视频类型注册表
 * ═══════════════════════════════════════════════════════════════
 * 一种「类型」= 一套版式 + 一组硬参数（画幅、常驻条数、单段字数上限）。
 * 加新类型只在这里登记 + 在 video/templates/<id>/ 放一个模板页，
 * make.mjs / 控制台 / 脚本生成都从这里取参数，别散落着写死。
 *
 * 为什么单段字数要跟着类型变：横屏气泡更宽（968px vs 640px），
 * 同样 56px 的字一行能多放几个字，硬用竖屏的 22 字反而浪费版面。
 */
export const TYPES = {
  diary: {
    id: 'diary',
    name: '日记体',
    tag: '竖屏 9:16',
    desc: '左气泡 + 右立绘，常驻 4 条。适合日更叙事，一条讲一件事',
    width: 1080,
    height: 1920,
    maxVisible: 4,
    segChars: [16, 26],   // 单段旁白的目标区间
  },
  talk: {
    id: 'talk',
    name: '鱼说',
    tag: '横屏 16:9',
    desc: '左立绘 + 右气泡，常驻 2 条。适合观点输出、回应评论、讲一段道理',
    width: 1920,
    height: 1080,
    maxVisible: 2,
    segChars: [18, 30],
  },
}

export const DEFAULT_TYPE = 'diary'

export function getType(id) {
  return TYPES[id] || TYPES[DEFAULT_TYPE]
}

export function listTypes() {
  return Object.values(TYPES)
}
