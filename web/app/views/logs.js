/* ═══════════════════════════════════════════════════════════════
 * views/logs.js —— 运行日志
 *
 * 这个屏幕要回答的一个问题：**刚才那次为什么失败？**
 * 所以它是终端，不是卡片列表：等宽、深底、一行一条、平台分开记。
 * 新到的行闪一下底就落定 —— 这是"行到达"的反馈，位置不动，
 * 不然整块在抖。
 *
 * 最后一个页签是「服务」：读的不是业务留痕，是控制台进程自己的输出
 * （.run/server.log）——"服务什么时候重启过、上次为什么挂"只有这里能答。
 * ═══════════════════════════════════════════════════════════════ */

const { ref, computed, onMounted, onUnmounted, nextTick } = Vue
import { api } from '../core/api.js'
import { flashRow } from '../core/motion.js'
import { logTime } from '../core/ui.js'

const TABS = [
  { id: 'douyin', name: '抖音' },
  { id: 'bili', name: 'B站' },
  { id: 'video', name: '视频' },
  { id: 'server', name: '服务' },
]

/** 秒 → 「3 小时 12 分」/「12 分 34 秒」。控制台是长驻的，时长比时间戳直观。 */
function upText(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

export const LogsView = {
  name: 'LogsView',
  setup() {
    const tab = ref('douyin')
    const rows = ref([])
    const raw = ref([])
    const ctl = ref(null)
    const error = ref('')
    const loaded = ref(false)
    const bodyEl = ref(null)
    const at = ref(0)
    let timer = null

    const isSvc = computed(() => tab.value === 'server')

    /* 每行渲染成一行文本，别在模板里对 200 条做 JSON.stringify */
    const lines = computed(() => rows.value.map((r) => {
      const { t, action, ...rest } = r
      return {
        key: t + '|' + action,
        time: logTime(t),
        action: action || '—',
        body: JSON.stringify(rest).slice(0, 180),
        bad: r.ok === false,
      }
    }))

    const svc = computed(() => ctl.value || null)
    const up = computed(() => (ctl.value ? upText(ctl.value.ctl.upSec) : ''))

    async function loadLog({ silent = false } = {}) {
      try {
        const r = await api.logs(tab.value)
        const next = (r.rows || []).slice().reverse()
        const prevTop = rows.value[0]?.t || ''
        rows.value = next
        error.value = ''
        loaded.value = true
        at.value = Date.now()

        /* 只有"本来就有数据"的刷新才闪，首屏不闪 */
        const added = prevTop ? Math.max(0, next.findIndex((x) => x.t <= prevTop)) : 0
        await nextTick()
        if (added > 0 && bodyEl.value) {
          const nodes = bodyEl.value.querySelectorAll('.logrow')
          for (let i = 0; i < Math.min(added, nodes.length); i++) flashRow(nodes[i])
        }
      } catch (e) {
        error.value = String(e.message || e)
        if (!silent) loaded.value = true
      }
    }

    /* 服务页签：日志是纯文本（进程自己 console.log 的那份），
     * 顶部那一条状态来自 /ctl/status —— 端口、pid、跑多久、队列深浅。 */
    async function loadSvc({ silent = false } = {}) {
      try {
        const [r, s] = await Promise.all([
          api.ctlLog(200),
          api.ctlStatus().catch(() => null),
        ])
        raw.value = (r.lines || []).slice().reverse()
        if (s) ctl.value = s
        error.value = ''
        loaded.value = true
        at.value = Date.now()
      } catch (e) {
        error.value = String(e.message || e)
        if (!silent) loaded.value = true
      }
    }

    const load = (o) => (isSvc.value ? loadSvc(o) : loadLog(o))

    function switchTo(id) {
      if (tab.value === id) return
      tab.value = id
      rows.value = []
      raw.value = []
      loaded.value = false
      load()
    }

    onMounted(() => {
      load()
      timer = setInterval(() => load({ silent: true }), 8000)
    })
    onUnmounted(() => clearInterval(timer))

    return {
      TABS, tab, rows, raw, lines, svc, up, error, loaded, bodyEl, at,
      isSvc, load, switchTo,
    }
  },
  template: `
  <div>
    <header class="head">
      <div class="head__main">
        <h1>运行日志</h1>
        <p class="head__sub">
          平台分开记，NDJSON 全留痕。「服务」那页读的是控制台进程自己的输出。
          每 8 秒自动拉一次，最多 200 条。
        </p>
      </div>
      <div class="head__actions">
        <span style="font-size:12px;color:var(--muted)">
          {{ at ? '同步于 ' + new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '' }}
        </span>
        <Btn variant="quiet" icon="refresh" @click="load({ quiet: false })">刷新</Btn>
      </div>
    </header>

    <!-- 服务页签的抬头：这几项答的是"进程还健康吗"，不是"业务跑到哪了" -->
    <div v-if="isSvc && svc" class="svc">
      <span><b>后端</b> :{{ svc.ctl.port }} · 已跑 {{ up }}</span>
      <span><b>pid</b> {{ svc.ctl.pid }}</span>
      <span><b>node</b> {{ svc.ctl.node }}</span>
      <span><b>队列</b> 跑 {{ svc.queue.running }} / 等 {{ svc.queue.waiting }} / 待确认 {{ svc.queue.confirm }}</span>
      <span><b>浏览器</b> 抖音 {{ svc.browser.douyin ? '开着' : '—' }} · B站 {{ svc.browser.bili ? '开着' : '—' }}</span>
    </div>

    <section class="card">
      <div class="tabs">
        <button v-for="t in TABS" :key="t.id" class="tabs__item"
          :class="{ on: tab === t.id }" @click="switchTo(t.id)">{{ t.name }}</button>
      </div>

      <div class="term">
        <div class="term__bar">
          <span class="term__name">{{ isSvc ? '.run/server.log' : 'logs/' + tab + '.ndjson' }}</span>
          <span class="term__right">
            {{ isSvc ? raw.length : lines.length }} 行 · 新的在上面
          </span>
        </div>
        <div class="term__body" ref="bodyEl">
          <div v-if="error" class="logrow bad">
            <span class="t">—</span><span class="a">读取失败</span><span class="d">{{ error }}</span>
          </div>

          <template v-else-if="isSvc">
            <div v-for="(l, i) in raw" :key="i" class="lograw">{{ l }}</div>
            <div v-if="!raw.length" style="color:var(--term-dim);padding:8px 4px">
              {{ loaded ? '这份日志还是空的 —— 服务刚起来，或者还没出过事' : '正在读…' }}
            </div>
          </template>

          <template v-else-if="lines.length">
            <div v-for="l in lines" :key="l.key" class="logrow" :class="{ bad: l.bad }">
              <span class="t">{{ l.time }}</span>
              <span class="a">{{ l.action }}</span>
              <span class="d">{{ l.body }}</span>
            </div>
          </template>

          <div v-else style="color:var(--term-dim);padding:8px 4px">
            {{ loaded ? '这个平台还没有日志 —— 跑一次就会有' : '正在读…' }}
          </div>
        </div>
      </div>
    </section>
  </div>`,
}
