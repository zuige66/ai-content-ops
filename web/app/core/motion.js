/* ═══════════════════════════════════════════════════════════════
 * motion.js —— 动效层（GSAP）
 *
 * 一条纪律：这是**应用界面**，不是落地页。
 * tasteskill 对后台屏幕的规定是「没有入场动效的硬指标，动效只做反馈：
 * 按下、悬停、聚焦、菜单/弹层打开、一行数据到达」。所以这里没有
 * 卡片依次浮现、没有数字滚动、没有滚动叙事 —— 一个你一天开二十次的
 * 控制台，每次进来都演一遍入场，第三遍就变成噪音。
 *
 * 留下的都是有信息量的动作：
 *   · 导航选中块滑过去        —— 让你知道"我换了位置"
 *   · 弹窗/Toast 进出         —— 让你知道"它开了/它走了"
 *   · 日志新行闪一下          —— 让你知道"这行是刚到的"
 *   · 二维码扫描线            —— 让你知道"还在等扫码"
 *
 * 没上的那些（Aurora 渐变背景、光晕卡片、点击迸溅、3D 背景）：它们正是
 * tasteskill 在 app 章节里点名禁掉的东西 —— 渐变、光晕、装饰形状。
 * 那类特效的正确落点是 video/templates 里的成片模板（那是给观众看的），
 * 不是这个一天开二十次的后台。
 *
 * 所有动作只碰 transform / opacity；系统开了「减少动态效果」就全部走直落。
 * ═══════════════════════════════════════════════════════════════ */

const gsap = window.gsap

export const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

/* 统一缓动：和 CSS 里的 --e-out 是同一个手感 */
const OUT = 'power3.out'
const IN_OUT = 'power2.inOut'

/* ── 导航选中块：从旧位置滑到新位置 ─────────────────────────── */
export function slideInk(inkEl, itemEl) {
  if (!inkEl || !itemEl) return
  const y = itemEl.offsetTop
  const h = itemEl.offsetHeight
  if (reduced) {
    gsap.set(inkEl, { y, height: h })
    return
  }
  gsap.to(inkEl, { y, height: h, duration: .34, ease: OUT, overwrite: true })
}

/* ── 弹窗：遮罩淡入，面板从下方 12px 落定 ───────────────────── */
export function dialogEnter(maskEl, done) {
  const panel = maskEl.querySelector('.dlg')
  if (reduced) { gsap.set([maskEl, panel], { opacity: 1, y: 0, scale: 1 }); done(); return }
  gsap.timeline({ onComplete: done })
    .fromTo(maskEl, { opacity: 0 }, { opacity: 1, duration: .18, ease: 'none' })
    .fromTo(panel, { opacity: 0, y: 12, scale: .985 },
      { opacity: 1, y: 0, scale: 1, duration: .3, ease: OUT }, '-=.1')
}

export function dialogLeave(maskEl, done) {
  const panel = maskEl.querySelector('.dlg')
  if (reduced) { done(); return }
  gsap.timeline({ onComplete: done })
    .to(panel, { opacity: 0, y: 8, scale: .99, duration: .18, ease: 'power2.in' }, 0)
    .to(maskEl, { opacity: 0, duration: .18, ease: 'none' }, 0)
}

/* ── 手机抽屉：整屏铺开，从上方落下 8px 就停 ────────────────── */
export function sheetEnter(el, done) {
  const panel = el.querySelector('.sheet') || el
  if (reduced) { gsap.set([el, panel], { opacity: 1, y: 0 }); done(); return }
  gsap.timeline({ onComplete: done })
    .fromTo(el, { opacity: 0 }, { opacity: 1, duration: .14, ease: 'none' })
    .fromTo(panel, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: .24, ease: OUT }, '-=.06')
}

export function sheetLeave(el, done) {
  const panel = el.querySelector('.sheet') || el
  if (reduced) { done(); return }
  gsap.to(panel, { opacity: 0, y: -8, duration: .16, ease: 'power2.in', onComplete: done })
}

/* ── Toast：右侧推入 ───────────────────────────────────────── */export function toastEnter(el, done) {
  if (reduced) { done(); return }
  gsap.fromTo(el, { opacity: 0, x: 12, y: 4 },
    { opacity: 1, x: 0, y: 0, duration: .26, ease: OUT, onComplete: done })
}

export function toastLeave(el, done) {
  if (reduced) { done(); return }
  gsap.to(el, { opacity: 0, x: 10, duration: .18, ease: 'power2.in', onComplete: done })
}

/* ── 日志新行：闪一下底色再落回，不动位置（不然整块在抖） ───── */
export function flashRow(el) {
  if (!el || reduced) return
  gsap.fromTo(el,
    { backgroundColor: 'rgba(176,39,74,.16)' },
    { backgroundColor: 'rgba(176,39,74,0)', duration: 1.1, ease: 'power2.out', delay: .08 })
}

/* ── 二维码扫描线：等待扫码时的"还在跑"提示 ─────────────────── */
export function startScan(lineEl) {
  if (!lineEl || reduced) return () => {}
  const host = lineEl.parentElement
  const tween = gsap.fromTo(lineEl,
    { y: 0 },
    {
      y: () => Math.max(1, host.clientHeight - 4),
      duration: 1.9,
      ease: 'sine.inOut',
      repeat: -1,
      yoyo: true,
    })
  return () => tween.kill()
}

/* ── 新任务到达时，让进度块轻轻亮一下（反馈，不是入场） ─────── */
export function nudge(el) {
  if (!el || reduced) return
  gsap.fromTo(el, { borderColor: 'rgba(176,39,74,.55)' },
    { borderColor: 'rgba(231,228,230,1)', duration: 1.2, ease: 'power2.out' })
}
