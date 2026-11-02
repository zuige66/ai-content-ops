/* ═══════════════════════════════════════════════════════════════
 * views/plans.js —— 策划台
 *
 * 这个屏幕要回答的一个问题：**有哪几期卡在出片前，等我点头？**
 *
 * 它是「闸」的可视化。没有这一屏，闸就只存在于 AGENTS.md 里，
 * 人一着急就直接去视频工坊点生成了 —— 规则写在纸上没人看，摆在眼前才有用。
 *
 * 所以布局照搬任务中心：左边列表、右边详情、结论放最上面一行，
 * 最常用的动作（通过）就落在详情底部，不弹窗、不二次确认。
 * 数据不放进 store 轮询：策划不会自己变，进来拉一次就够。
 * ═══════════════════════════════════════════════════════════════ */

const { ref, computed } = Vue
import { api } from '../core/api.js'
import { toast, store } from '../store.js'

const STATUS = {
  draft: { text: '待批', cls: 'pill--warn' },
  approved: { text: '可出片', cls: 'pill--ok' },
  shot: { text: '已拍', cls: 'pill--accent' },
  published: { text: '已发', cls: '' },
}

/** 策划里带 markdown 反引号（`4,389★`），列表里不需要，剥掉 */
const clean = (s) => String(s == null ? '' : s).replace(/`/g, '').trim()

/* 状态放模块作用域：切走再切回来不用重新拉 */
const data = ref({ plans: [], stock: null, ready: false, error: '' })
const detail = ref({ slug: null, plan: null, loading: false, error: '' })
const busy = ref(false)

async function load() {
  try {
    const d = await api.plans()
    data.value = { plans: d.plans || [], stock: d.stock || null, ready: true, error: '' }
  } catch (e) {
    data.value = { plans: [], stock: null, ready: true, error: String(e.message || e) }
  }
}

async function open(row) {
  if (!row) return
  detail.value = { slug: row.slug, plan: null, loading: true, error: '' }
  try {
    const d = await api.plan(row.slug)
    detail.value = { slug: row.slug, plan: d.plan, loading: false, error: '' }
  } catch (e) {
    detail.value = { slug: row.slug, plan: null, loading: false, error: String(e.message || e) }
  }
}

async function setStatus(slug, status) {
  busy.value = true
  try {
    await api.planStatus(slug, status)
    toast(status === 'approved' ? '已通过，可以出片了' : `状态改为 ${status}`, 'ok')
    await load()
    const row = data.value.plans.find((p) => p.slug === slug)
    if (row) await open(row)
  } catch (e) {
    toast(String(e.message || e), 'bad')
  } finally {
    busy.value = false
  }
}

export const PlansView = {
  name: 'PlansView',
  setup() {
    const sel = ref(null)
    const stock = computed(() => data.value.stock)

    const rows = computed(() => data.value.plans.map((p) => ({
      ...p,
      pill: STATUS[p.status] || { text: p.status, cls: '' },
      charsText: p.chars ? `${p.chars} 字` : '—',
      durText: p.durSec ? `${p.durSec}s` : '—',
    })))

    /* 一句话结论：先说"有几期等你"，再提库存。别写界面说明。 */
    const finding = computed(() => {
      if (!data.value.ready) return '正在读策划…'
      if (data.value.error) return '读不到策划目录'
      const s = stock.value || {}
      if (!s.total) return '还没有任何策划，先做一期'
      if (s.draft) return `${s.draft} 期待批，批完才能出片`
      if (s.low) return `库存只剩 ${s.approved} 期，日更撑不过三天`
      return `${s.approved} 期已批，库存够用`
    })

    /* 进来就选中第一期待批的 —— 最该动手的那期放最显眼处 */
    let autoPicked = false
    function autoPick(list) {
      if (autoPicked || !list.length) return
      autoPicked = true
      const first = list.find((p) => p.status === 'draft') || list[0]
      sel.value = first.slug
      open(first)
    }

    /* 首次进入自己拉一次，不等别人喂 */
    if (!data.value.ready) {
      load().then(() => autoPick(data.value.plans))
    } else {
      autoPick(data.value.plans)
    }

    function pick(row) {
      sel.value = row.slug
      open(row)
    }

    /* 把这一期交给视频工坊。
     * 只传 slug —— 工坊自己去 /plans/<slug> 读全文，事实源仍是那个 md。
     * 顺手清掉，免得下次进工坊又被旧策划覆盖。 */
    function goShoot(plan) {
      if (!plan) return
      store.pendingPlan = plan.slug
      store.view = 'video'
      toast(`已把「${plan.title || plan.slug}」交给视频工坊`, 'ok')
    }

    return {
      data, detail, busy, stock, rows, sel, finding,
      pick, setStatus, reload: load, clean, goShoot,
    }
  },
  template: `
  <div>
    <header class="head">
      <div class="head__main">
        <h1>策划台</h1>
        <p class="head__sub">{{ finding }}</p>
      </div>
      <div class="head__actions">
        <span style="font-size:12px;color:var(--muted)">策划未通过，不许出片</span>
        <Btn variant="quiet" icon="refresh" @click="reload">刷新</Btn>
      </div>
    </header>

    <div class="kpi">
      <div class="kpi__cell">
        <div class="kpi__k">待批</div>
        <div class="kpi__v" :class="stock && stock.draft ? 'kpi__v--accent' : ''">{{ stock ? stock.draft : '—' }}</div>
        <div class="kpi__cap">等你点头</div>
      </div>
      <div class="kpi__cell">
        <div class="kpi__k">可出片</div>
        <div class="kpi__v">{{ stock ? stock.approved : '—' }}</div>
        <div class="kpi__cap">库存 {{ stock && stock.low ? '偏少' : '够用' }}</div>
      </div>
      <div class="kpi__cell">
        <div class="kpi__k">已拍</div>
        <div class="kpi__v">{{ stock ? stock.shot : '—' }}</div>
        <div class="kpi__cap">出了没发</div>
      </div>
      <div class="kpi__cell">
        <div class="kpi__k">已发</div>
        <div class="kpi__v">{{ stock ? stock.published : '—' }}</div>
        <div class="kpi__cap">共 {{ stock ? stock.total : 0 }} 期</div>
      </div>
    </div>

    <div class="grid grid--rail mt4">
      <section class="card">
        <div class="card__head">
          <h2 class="card__title">策划</h2>
          <span class="card__meta">{{ rows.length }} 期</span>
        </div>

        <table v-if="rows.length" class="tbl tbl--fixed">
          <thead>
            <tr>
              <th style="width:44px">期</th>
              <th>项目</th>
              <th style="width:80px">状态</th>
              <th class="num" style="width:64px">字数</th>
              <th class="num" style="width:56px">时长</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.slug" class="clickable"
              :class="{ sel: sel === r.slug }" @click="pick(r)">
              <td class="num">{{ String(r.episode).padStart(2, '0') }}</td>
              <td>
                <div class="cell-name">{{ r.project }}</div>
                <div class="cell-sub">{{ r.repo }}</div>
              </td>
              <td><span class="pill" :class="r.pill.cls">{{ r.pill.text }}</span></td>
              <td class="num">{{ r.charsText }}</td>
              <td class="num">{{ r.durText }}</td>
            </tr>
          </tbody>
        </table>

        <div v-else class="empty">
          {{ data.ready ? '还没有策划。让 AI 按模板建一份' : '正在读策划…' }}
        </div>
      </section>

      <section class="card card--fill">
        <div class="card__head">
          <h2 class="card__title">详情</h2>
          <span class="card__meta">{{ detail.plan ? detail.plan.slug : '' }}</span>
        </div>

        <div v-if="detail.loading" class="empty">正在读…</div>
        <div v-else-if="detail.error" class="alert alert--bad">{{ detail.error }}</div>

        <template v-else-if="detail.plan">
          <h3 style="margin:0 0 4px;font-size:15px;font-weight:600">{{ detail.plan.title }}</h3>
          <p style="margin:0 0 12px;font-size:12px;color:var(--muted)">
            {{ detail.plan.created }} · {{ detail.plan.repo }}
          </p>

          <div class="kv">
            <div class="kv__row"><span class="kv__k">钩子</span>
              <span class="kv__v">{{ clean(detail.plan.hook) || '未选' }}</span></div>
            <div class="kv__row"><span class="kv__k">封面</span>
              <span class="kv__v">{{ detail.plan.cover.line1 }} / {{ detail.plan.cover.line2 }}</span></div>
            <div class="kv__row"><span class="kv__k">标题</span>
              <span class="kv__v">抖音 {{ detail.plan.titles.douyin }} 条 · B站 {{ detail.plan.titles.bili }} 条</span></div>
            <div class="kv__row"><span class="kv__k">口播</span>
              <span class="kv__v">{{ detail.plan.chars || '—' }} 字 · 约 {{ detail.plan.durSec || '—' }} 秒</span></div>
            <div class="kv__row"><span class="kv__k">分镜</span>
              <span class="kv__v">{{ detail.plan.shots.length }} 个</span></div>
            <div class="kv__row"><span class="kv__k">风险</span>
              <span class="kv__v">
                <span class="pill" :class="detail.plan.hasRisk ? 'pill--ok' : 'pill--bad'">
                  {{ detail.plan.hasRisk ? '已写坦白' : '缺「不能干什么」' }}
                </span>
              </span></div>
          </div>

          <div class="plan-voice mt3">
            <div class="plan-voice__h">口播稿</div>
            <div v-for="v in detail.plan.voice" :key="v.seg" class="plan-voice__row">
              <span class="plan-voice__t">{{ v.time }}</span>
              <span class="plan-voice__x">{{ v.text }}</span>
            </div>
            <div v-if="!detail.plan.voice.length" class="empty" style="padding:16px 0">
              没解析到口播表，检查策划里的表格格式
            </div>
          </div>

          <div class="card__foot">
            <Btn v-if="detail.plan.status === 'draft'" variant="primary" icon="check"
              :disabled="busy" @click="setStatus(detail.plan.slug, 'approved')">通过，可以出片</Btn>
            <!-- approved 之后唯一的下一步就是去出片：把 slug 交给工坊，别再让人自己找过去 -->
            <Btn v-else-if="detail.plan.status === 'approved'" variant="primary" icon="film"
              @click="goShoot(detail.plan)">去出片</Btn>
            <Btn v-else-if="detail.plan.status === 'shot'" variant="primary" icon="check"
              :disabled="busy" @click="setStatus(detail.plan.slug, 'published')">标记已发</Btn>
            <span v-else style="font-size:12px;color:var(--muted)">这期已经发出去了</span>
            <Btn v-if="detail.plan.status === 'shot'" variant="quiet" icon="film"
              @click="goShoot(detail.plan)">重新出片</Btn>
            <Btn v-if="detail.plan.status === 'approved'" variant="quiet" icon="x"
              :disabled="busy" @click="setStatus(detail.plan.slug, 'draft')">退回</Btn>
          </div>
        </template>

        <div v-else class="empty">
          选左边任意一期看策划<br>通过之后，视频工坊才能生成
        </div>
      </section>
    </div>
  </div>`,
}
