/* ═══════════════════════════════════════════════════════════════
 * ui.js —— 三个基础组件 + 几个格式化函数
 *
 * 组件只做三件事：图标、按钮、数字步进。
 * 原来靠 Element Plus 撑起来的 tag / alert / steps / radio-group /
 * table / dialog 全部换成了手写的最小实现（见各视图），
 * 因为它们的默认长相正是"后台模板"的识别特征。
 * ═══════════════════════════════════════════════════════════════ */

const { computed } = Vue

/* 图标：24 格网格，1.6px 描边，不填色。全部手画，不用图标库 */
const ICONS = {
  shield: ['M12 3.6l7 2.6v5.3c0 4.2-2.9 7.4-7 8.9-4.1-1.5-7-4.7-7-8.9V6.2l7-2.6z', 'M9.2 12.1l2 2 3.6-3.7'],
  film: ['M3.5 6h17v12h-17z', 'M3.5 9.6h17', 'M3.5 14.4h17', 'M8 6v12', 'M16 6v12'],
  list: ['M8 6.5h12', 'M8 12h12', 'M8 17.5h12', 'M4.2 6.5h.01', 'M4.2 12h.01', 'M4.2 17.5h.01'],
  term: ['M4 5h16v14H4z', 'M7.6 9.6L10 12l-2.4 2.4', 'M12.6 14.8h4'],
  refresh: ['M19.4 12a7.4 7.4 0 1 1-2.2-5.2', 'M19.4 4.6v5.2h-5.2'],
  play: ['M8.4 5.6l10.4 6.4-10.4 6.4z'],
  check: ['M4.6 12.5l4.9 4.9L19.6 7'],
  x: ['M6.2 6.2l11.6 11.6', 'M17.8 6.2L6.2 17.8'],
  image: ['M3.5 5.5h17v13h-17z', 'M3.5 15.4l4.4-4.4 3.4 3.4 3-3 6 6', 'M15.4 9.6h.01'],
  arrow: ['M5 12h13', 'M12.4 6l6 6-6 6'],
  spark: ['M12 4.2l1.7 4.7 4.7 1.7-4.7 1.7L12 17l-1.7-4.7L5.6 10.6l4.7-1.7z'],
  qr: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h2.4v2.4H14z', 'M17.6 14H20v2.4h-2.4z', 'M14 17.6h2.4V20H14z', 'M17.6 17.6H20V20h-2.4z'],
  doc: ['M6 3.6h8l4 4v12.8H6z', 'M14 3.6v4h4', 'M9 12h6', 'M9 15.6h6'],
  down: ['M12 4.6v13', 'M6.4 12.2l5.6 5.6 5.6-5.6'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  minus: ['M5.5 12h13'],
  menu: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
}

export const Icon = {
  name: 'Icon',
  props: { name: { type: String, required: true } },
  computed: {
    paths() { return ICONS[this.name] || [] },
  },
  template: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
  ><path v-for="(d, i) in paths" :key="i" :d="d"/></svg>`,
}

/* 按钮：一个 variant 决定它是主按钮、次按钮还是文字按钮。
   整个应用只有一个实心主按钮，其余都是描边或文字。 */
export const Btn = {
  name: 'Btn',
  props: {
    variant: { type: String, default: '' },
    size: { type: String, default: '' },
    icon: { type: String, default: '' },
    loading: Boolean,
    disabled: Boolean,
    block: Boolean,
    title: { type: String, default: '' },
  },
  emits: ['click'],
  template: `<button type="button" class="btn"
    :class="[variant && 'btn--' + variant, size && 'btn--' + size, block && 'btn--block', { 'is-loading': loading }]"
    :disabled="disabled || loading" :title="title" @click="$emit('click', $event)"
  ><Icon v-if="icon" :name="icon"/><slot/></button>`,
}

/* 数字步进：原生 input 去掉上下箭头，自己的两个按钮，值永远夹在范围内 */
export const NumBox = {
  name: 'NumBox',
  props: {
    modelValue: { type: Number, default: 0 },
    min: { type: Number, default: -Infinity },
    max: { type: Number, default: Infinity },
    step: { type: Number, default: 1 },
    width: { type: Number, default: 42 },
  },
  emits: ['update:modelValue'],
  computed: {
    show() { return Number.isFinite(this.modelValue) ? this.modelValue : '' },
  },
  methods: {
    clamp(v) {
      const n = Number(v)
      if (!Number.isFinite(n)) return this.modelValue
      return Math.min(this.max, Math.max(this.min, n))
    },
    bump(d) { this.$emit('update:modelValue', this.clamp(Number(this.modelValue) + d)) },
    onInput(e) {
      const raw = e.target.value
      if (raw === '') return
      this.$emit('update:modelValue', this.clamp(raw))
    },
  },
  template: `<div class="numbox">
    <button type="button" aria-label="减" @click="bump(-step)">−</button>
    <input :value="show" inputmode="numeric" :style="{ width: width + 'px' }" @change="onInput">
    <button type="button" aria-label="加" @click="bump(step)">+</button>
  </div>`,
}

/* ── 格式化：所有数字走同一套口径，表格里才对得齐 ───────────── */

/** 时间戳 → 12:04:31 */
export function hhmmss(ts) {
  const d = new Date(ts || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 时间戳 → 刚刚 / 3 分钟前 / 12:04 */
export function ago(ts) {
  if (!ts) return '—'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 45) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return hhmmss(ts)
}

/** 日志行的时间：只留 MM-DD HH:MM:SS 里的时分秒 */
export function logTime(t) {
  return String(t || '').slice(11, 19) || '—'
}

/** 字 → 秒（后端用 4.4 字/秒估，这里跟它保持一致，别出现两个口径） */
export function charsToSec(n) {
  return Math.round((n || 0) / 4.4)
}
