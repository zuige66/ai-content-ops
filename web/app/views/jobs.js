/* ═══════════════════════════════════════════════════════════════
 * views/jobs.js —— 任务中心
 *
 * 这个屏幕要回答的一个问题：**有哪几条停在发布前等我点头？**
 * 所以最大的东西不是表格，是"等确认"那几行；最常用的动作（确认发布）
 * 就在右侧详情里，选中一行、看一眼截图、点一下 —— 不用开弹窗。
 *
 * 表格靠对齐和行线，没有斑马纹、没有表头色带、没有分页。
 * ═══════════════════════════════════════════════════════════════ */

const { ref, computed, watch } = Vue
import { api } from '../core/api.js'
import { store, refresh, jobStats, toast } from '../store.js'
import { ago } from '../core/ui.js'

const STATUS = {
  done: { text: '完成', cls: 'pill--ok' },
  failed: { text: '失败', cls: 'pill--bad' },
  running: { text: '进行中', cls: 'pill--accent' },
  pending: { text: '排队', cls: '' },
  'awaiting-confirm': { text: '等确认', cls: 'pill--warn' },
}

const PLATFORM = { douyin: '抖音', bili: 'B站', video: '视频' }

/* 选中行的详情（截图可能不在 /status 里，得单独取） */
const detail = ref({ id: null, note: '', shots: [], loading: false, error: '' })

async function open(row) {
  if (!row) return
  detail.value = { id: row.id, note: '', shots: [], loading: true, error: '' }
  try {
    const d = await api.steps(row.id)
    detail.value = {
      id: row.id,
      note: d.job?.result?.note || '',
      shots: d.job?.result?.screenshots || [],
      loading: false,
      error: '',
    }
  } catch (e) {
    detail.value = { id: row.id, note: '', shots: [], loading: false, error: String(e.message || e) }
  }
}

async function resolve(id, ok) {
  try {
    await api.confirm(id, ok)
    toast(ok ? '已确认发布' : '已撤销', ok ? 'ok' : 'info')
    await refresh()
    detail.value = { id: null, note: '', shots: [], loading: false, error: '' }
  } catch (e) {
    toast(String(e.message || e), 'bad')
  }
}

export const JobsView = {
  name: 'JobsView',
  setup() {
    const sel = ref(null)
    const stats = computed(() => jobStats())
    const selected = computed(() => store.jobs.find((j) => j.id === sel.value) || null)

    const rows = computed(() => store.jobs.map((j) => ({
      ...j,
      platformName: PLATFORM[j.platform] || j.platform,
      pill: STATUS[j.status] || { text: j.status, cls: '' },
      when: ago(j.updatedAt),
      waiting: j.status === 'awaiting-confirm',
    })))

    /* 一句话结论：这条副标题就是屏幕的"发现"，不是界面说明 */
    const finding = computed(() => {
      const s = stats.value
      if (!store.ready) return '正在读队列…'
      if (s.pending) return `${s.pending} 条停在发布前，等你点头`
      if (s.failed) return `${s.failed} 条失败，其余没有等人动手的`
      if (!s.total) return '队列是空的，还没有跑过任务'
      return '没有等人动手的任务'
    })

    /* 进来就选中第一条"等确认"的 —— 那个面板不该一开就是空的，
       最常用的动作（确认发布）要一眼能看到 */
    let autoPicked = false
    watch(() => store.jobs, (list) => {
      if (autoPicked || !list.length) return
      const first = list.find((j) => j.status === 'awaiting-confirm') || list[0]
      autoPicked = true
      pick(first)
    }, { immediate: true })

    /* 选中的任务没了就清空选中，别留一个指向空气的面板 */
    watch(() => store.jobs.length, () => {
      if (sel.value && !store.jobs.some((j) => j.id === sel.value)) sel.value = null
    })

    function pick(row) {
      sel.value = row.id
      open(row)
    }

    return { store, stats, rows, sel, selected, detail, finding, pick, resolve, refresh }
  },
  template: `
  <div>
    <header class="head">
      <div class="head__main">
        <h1>任务中心</h1>
        <p class="head__sub">{{ finding }}</p>
      </div>
      <div class="head__actions">
        <span style="font-size:12px;color:var(--muted)">每 6 秒自动同步</span>
        <Btn variant="quiet" icon="refresh" @click="refresh({ quiet: false })">刷新</Btn>
      </div>
    </header>

    <!-- KPI：一个容器，1px 分隔线切四格 -->
    <div class="kpi">
      <div class="kpi__cell">
        <div class="kpi__k">队列总数</div>
        <div class="kpi__v" v-if="store.ready">{{ stats.total }}</div>
        <span v-else class="skel" style="width:34px;height:26px;margin-top:2px"></span>
        <div class="kpi__cap">最近 20 条</div>
      </div>
      <div class="kpi__cell">
        <div class="kpi__k">进行中</div>
        <div class="kpi__v" v-if="store.ready">{{ stats.running }}</div>
        <span v-else class="skel" style="width:34px;height:26px;margin-top:2px"></span>
        <div class="kpi__cap">排队 + 渲染</div>
      </div>
      <div class="kpi__cell">
        <div class="kpi__k">等确认</div>
        <div class="kpi__v" :class="stats.pending ? 'kpi__v--accent' : ''" v-if="store.ready">{{ stats.pending }}</div>
        <span v-else class="skel" style="width:34px;height:26px;margin-top:2px"></span>
        <div class="kpi__cap">停在发布前</div>
      </div>
      <div class="kpi__cell">
        <div class="kpi__k">失败</div>
        <div class="kpi__v" :class="stats.failed ? 'kpi__v--bad' : ''" v-if="store.ready">{{ stats.failed }}</div>
        <span v-else class="skel" style="width:34px;height:26px;margin-top:2px"></span>
        <div class="kpi__cap">需要看一眼</div>
      </div>
    </div>

    <div class="grid grid--rail mt4">
      <!-- 左：队列 -->
      <section class="card">
        <div class="card__head">
          <h2 class="card__title">队列</h2>
          <span class="card__meta">{{ rows.length }} 条</span>
        </div>

        <table v-if="rows.length" class="tbl tbl--fixed">
          <thead>
            <tr>
              <th>任务</th>
              <th style="width:72px">平台</th>
              <th style="width:84px">状态</th>
              <th class="num" style="width:92px">更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.id" class="clickable"
              :class="{ sel: sel === r.id }" @click="pick(r)">
              <td>
                <div class="cell-name">{{ r.title }}</div>
                <div class="cell-sub">
                  <span class="id">{{ r.id }}</span>
                  <span v-if="r.waiting" style="color:var(--accent-ink);margin-left:8px">· 等你点头</span>
                  <span v-else-if="r.error" class="err" style="margin-left:8px">· {{ r.error }}</span>
                  <span v-else-if="r.result?.note" style="margin-left:8px">· {{ r.result.note }}</span>
                </div>
              </td>
              <td>{{ r.platformName }}</td>
              <td><span class="pill" :class="r.pill.cls">{{ r.pill.text }}</span></td>
              <td class="num">{{ r.when }}</td>
            </tr>
          </tbody>
        </table>

        <div v-else class="empty">
          {{ store.ready ? '队列是空的，还没有跑过任务' : '正在读队列…' }}
        </div>
      </section>

      <!-- 右：详情。确认发布就在这，一点就走 -->
      <section class="card card--fill">
        <div class="card__head">
          <h2 class="card__title">详情</h2>
          <span class="card__meta">{{ selected ? selected.id : '' }}</span>
        </div>

        <template v-if="selected">
          <p style="margin:0 0 12px;font-size:13px;line-height:1.5">{{ selected.title }}</p>

          <div class="kv">
            <div class="kv__row"><span class="kv__k">平台</span>
              <span class="kv__v">{{ rows.find(r => r.id === selected.id)?.platformName }}</span></div>
            <div class="kv__row"><span class="kv__k">状态</span>
              <span class="kv__v">
                <span class="pill" :class="rows.find(r => r.id === selected.id)?.pill.cls">
                  {{ rows.find(r => r.id === selected.id)?.pill.text }}
                </span>
              </span></div>
            <div class="kv__row"><span class="kv__k">更新时间</span>
              <span class="kv__v">{{ rows.find(r => r.id === selected.id)?.when }}</span></div>
          </div>

          <div v-if="detail.loading" class="alert mt3">正在取截图…</div>
          <div v-else-if="detail.error" class="alert alert--bad mt3">{{ detail.error }}</div>
          <template v-else>
            <p v-if="detail.note" class="mt3" style="font-size:12px;color:var(--muted);line-height:1.6">{{ detail.note }}</p>
            <div v-if="detail.shots.length" class="dlg__shots">
              <img v-for="f in detail.shots" :key="f" :src="f" alt="投稿截图">
            </div>
            <div v-else-if="!detail.note" class="empty mt3">这条任务没有附带截图</div>
          </template>

          <div v-if="selected.status === 'awaiting-confirm'" class="card__foot">
            <Btn variant="primary" icon="check" @click="resolve(selected.id, true)">确认发布</Btn>
            <Btn icon="x" @click="resolve(selected.id, false)">撤销</Btn>
          </div>
          <div v-else class="card__foot">
            <span style="font-size:12px;color:var(--muted)">只有停在发布前的任务才需要确认</span>
          </div>
        </template>

        <div v-else class="empty">
          选左边任意一条看详情<br>等确认的任务，截图会出现在这里
        </div>
      </section>
    </div>
  </div>`,
}
