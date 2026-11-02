/* peek-dm.mjs —— 只读排查：看聊天页的会话列表 / 某个会话的消息
 * ═══════════════════════════════════════════════════════════════
 * 用法：
 *   node tools/peek-dm.mjs                    # 只列会话
 *   node tools/peek-dm.mjs 金麦味片            # 列会话 + 展开某个会话的对话
 *
 * 为什么要有它：私信这块的坑全在"读"上 —— 消息顺序、时间戳粘连、
 * 系统提示误判、发送后列表不刷新。光看代码和日志判断不了，
 * 得能把"页面现在到底长什么样"直接打出来。
 *
 * 🔴 只读，一个字都不发。走 CDP 附着项目自己的调试 Chrome。
 * ═══════════════════════════════════════════════════════════════ */
import * as dm from '../douyin/dm.mjs'

const target = process.argv[2] || ''

await dm.open()
const s = await dm.listSessions()
if (!s.ok) { console.log('读会话失败：', s.error); process.exit(1) }

console.log(`会话 ${s.sessions.length} 个：`)
for (const x of s.sessions) {
  console.log(`  · ${String(x.name).padEnd(16)} 预览：${String(x.preview || '').slice(0, 40)}`)
}

if (target) {
  try {
    const o = await dm.openSession(target)
    const t = await dm.readThread({ limit: 15 })
    console.log(`\n=== ${o.name}（旧 → 新）===`)
    if (!t.ok) { console.log('  读失败：', t.error) }
    else {
      for (const m of t.messages) {
        const who = m.timeOnly ? '[时间条]' : m.system ? '[系统]' : m.self ? '[我]  ' : '[对方]'
        console.log(`  ${who} ${JSON.stringify(String(m.text || '').slice(0, 52))}`)
      }
      const real = t.messages.filter(m => !m.timeOnly && !m.system)
      const last = real[real.length - 1]
      console.log(`\n  真人消息 ${real.length} 条；最后一条：${last ? (last.self ? '我' : '对方') + ' / ' + last.text.slice(0, 30) : '无'}`)
    }
  } catch (e) {
    console.log(`\n打开「${target}」失败：`, String(e.message || e).slice(0, 120))
  }
}
process.exit(0)
