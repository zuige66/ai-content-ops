/* ═══════════════════════════════════════════════════════════════
 * main.js —— 外壳（侧栏 + 画布 + Toast）
 *
 * 框架形状变了：从"一个 468 行的 index.html 塞下所有视图"，
 * 变成"外壳 + 四个视图模块 + 一个动效层 + 一个 API 层"。
 * 用原生 ES module，没有打包步骤 —— 改完存盘刷新就生效。
 *
 * 侧栏是 Open plane：落在页面底色上，一条发丝线和画布分开，没有顶栏。
 * 顶栏那一条最容易变成"后台模板"的识别特征（左边标题 + 右边一排状态
 * 徽标），所以这里把标题放回画布、状态放回侧栏底部。
 * ═══════════════════════════════════════════════════════════════ */

const { createApp, ref, computed, onMounted, nextTick, watch } = Vue

import { store, refresh, pendingCount, dropToast } from './store.js'
import { api } from './core/api.js'
import { Icon, Btn, NumBox } from './core/ui.js'
import { slideInk, startScan, toastEnter, toastLeave, sheetEnter, sheetLeave } from './core/motion.js'
import { LoginView } from './views/login.js'
import { VideoView } from './views/video.js'
import { JobsView } from './views/jobs.js'
import { LogsView } from './views/logs.js'
import { DouyinView } from './views/douyin.js'

const MENUS = [
  { key: 'login', icon: 'shield', label: '平台登录' },
  { key: 'douyin', icon: 'spark', label: '抖音账号' },
  { key: 'video', icon: 'film', label: '视频工坊' },
  { key: 'jobs', icon: 'list', label: '任务中心' },
  { key: 'logs', icon: 'term', label: '运行日志' },
]

const VIEWS = { login: LoginView, douyin: DouyinView, video: VideoView, jobs: JobsView, logs: LogsView }

/* 视图存在 hash 里：刷新页面还停在原来那屏，也能直接贴链接 */
function readHash() {
  const k = (location.hash || '').replace(/^#\/?/, '')
  return MENUS.some((m) => m.key === k) ? k : null
}

const App = {
  components: { LoginView, DouyinView, VideoView, JobsView, LogsView },

  setup() {
    const navEl = ref(null)
    const inkEl = ref(null)
    /* 手机上的抽屉：只有窄屏才用得到 */
    const sheet = ref(false)
    /* 侧栏收起（只剩图标）。窄屏没有侧栏，这个开关不出现 */
    const fold = ref(false)

    const current = computed(() => VIEWS[store.view] || LoginView)
    const currentLabel = computed(() => MENUS.find((m) => m.key === store.view)?.label || '')
    const pending = computed(() => pendingCount())

    /* ── 标签页：打开过的页面停在顶栏下面，能关能快切（跟 zhibo 一样） ──
     * 存 sessionStorage：刷新还在，关掉浏览器就清 —— 这是一次会话里的"我来过哪"。 */
    const TABS_KEY = 'za-tabs'
    function loadTabs() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(TABS_KEY) || '[]')
        if (Array.isArray(saved)) {
          const ok = saved.filter((k) => MENUS.some((m) => m.key === k))
          if (ok.length) return ok
        }
      } catch { /* 存坏了就当没存 */ }
      /* 这里**不能**拿 store.view 兜底：setup 跑的时候地址里的 hash 还没读，
       * store.view 永远是初始值，会凭空多出一个"平台登录"标签页。
       * 空的就空着，onMounted 读到真实视图后会把它加进来。 */
      return []
    }
    const opened = ref(loadTabs())
    const saveTabs = () => {
      try { sessionStorage.setItem(TABS_KEY, JSON.stringify(opened.value)) } catch { /* 隐私模式写不进去，不影响用 */ }
    }
    const labelOf = (k) => MENUS.find((m) => m.key === k)?.label || k

    /* 只切视图、不动地址；顺带保证这屏在标签页里 */
    function enter(key) {
      if (!opened.value.includes(key)) {
        opened.value.push(key)
        saveTabs()
      }
      store.view = key
    }

    function go(key) {
      sheet.value = false
      enter(key)
      if (location.hash.replace(/^#\/?/, '') !== key) location.hash = key
    }

    /* 最后一个关不掉 —— 关光了就没内容了。关掉的正是当前页时，切到它左边那个 */
    function closeTab(key) {
      const i = opened.value.indexOf(key)
      if (i < 0 || opened.value.length <= 1) return
      opened.value.splice(i, 1)
      saveTabs()
      if (store.view === key) enter(opened.value[Math.max(0, i - 1)])
    }

    const ffmpegOk = computed(() => Boolean(store.ffmpeg) && !String(store.ffmpeg).startsWith('FAIL'))

    /* 顶栏右侧那一句：队列现在什么样。跟 zhibo 的"在放什么"同一个位置 */
    const queueText = computed(() => {
      if (!store.ready) return '读取队列…'
      const j = store.jobs
      const confirm = j.filter((x) => x.status === 'awaiting-confirm').length
      const running = j.filter((x) => x.status === 'running' || x.status === 'pending').length
      if (confirm) return `${confirm} 条等你确认`
      if (running) return `正在跑 ${running} 条`
      return '队列空闲'
    })
    const queueDot = computed(() => {
      if (!store.ready) return ''
      const j = store.jobs
      if (j.some((x) => x.status === 'awaiting-confirm')) return 'dot--warn'
      if (j.some((x) => x.status === 'running' || x.status === 'pending')) return 'dot--live'
      return 'dot--ok'
    })

    const platforms = computed(() => ([
      { id: 'douyin', name: '抖音', st: store.platforms.douyin || {} },
      { id: 'bili', name: 'B站', st: store.platforms.bili || {} },
    ].map((p) => ({
      ...p,
      on: Boolean(p.st.loggedIn),
      who: p.st.who?.name || (p.st.loggedIn ? '已登录' : '未登录'),
    }))))

    /* 选中块跟着当前项走。这是"我换了位置"的反馈，不是入场动画 */
    function moveInk() {
      const host = navEl.value
      const ink = inkEl.value
      if (!host || !ink) return
      const el = host.querySelector('.nav__item.on')
      if (el) slideInk(ink, el)
    }

    watch(() => store.view, () => {
      document.title = `zhibo-auto · ${currentLabel.value}`
      nextTick(moveInk)
    })

    /* 收起/展开侧栏后行宽变了，选中块得重新量一次 */
    watch(fold, () => { setTimeout(moveInk, 180) })

    /* 拉宽到桌面就自动收起抽屉，别留一个悬着的全屏层 */
    function onResize() {
      if (window.innerWidth > 900) sheet.value = false
      moveInk()
    }

    /* 地址栏改 hash、或者浏览器后退/前进，视图要跟着走 ——
     * 不然贴出去的链接和真的打开的那一屏对不上 */
    function onHash() {
      const h = readHash()
      if (h && h !== store.view) {
        sheet.value = false
        enter(h)
      }
    }

    onMounted(async () => {
      enter(readHash() || store.view)
      document.title = `zhibo-auto · ${currentLabel.value}`

      await nextTick()
      moveInk()
      window.addEventListener('resize', onResize)
      window.addEventListener('hashchange', onHash)

      /* ffmpeg 自检：出片全靠它，先问一句 */
      api.doctor().then((d) => { store.ffmpeg = d.ffmpeg || '' }).catch(() => { store.ffmpeg = 'FAIL' })

      await refresh()
      setInterval(() => refresh(), 6000)
    })

    return {
      store, MENUS, navEl, inkEl, current, currentLabel, opened, labelOf, closeTab,
      queueText, queueDot, fold, pending, ffmpegOk, platforms, go, sheet,
      /* Toast / 抽屉的进出钩子，交给 GSAP */
      toastEnter, toastLeave, dropToast, sheetEnter, sheetLeave,
    }
  },

  template: `
  <div class="shell" :class="{ 'shell--fold': fold }">
    <aside class="rail">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true">鱼</span>
        <span>
          <span class="brand__name">zhibo-auto</span>
          <span class="brand__scope">大肥鱼 · 本机</span>
        </span>
      </div>

      <div class="rail__body">
        <div class="rail__group">
          <div class="rail__label">控制台</div>
          <nav class="nav" ref="navEl">
            <span class="nav__ink" ref="inkEl" aria-hidden="true"></span>
            <button v-for="m in MENUS" :key="m.key" type="button" class="nav__item"
              :class="{ on: store.view === m.key }" @click="go(m.key)" :title="m.label">
              <Icon :name="m.icon"/>
              <span>{{ m.label }}</span>
              <span v-if="m.key === 'jobs' && pending" class="nav__count">{{ pending }}</span>
            </button>
          </nav>
        </div>
      </div>

      <div class="rail__foot">
        <div class="rail__stat" :title="ffmpegOk ? 'ffmpeg 可用' : 'ffmpeg 异常'">
          <i class="dot" :class="ffmpegOk ? 'dot--ok' : 'dot--bad'"></i>
          <b>ffmpeg</b>
          <span>{{ ffmpegOk ? '可用' : '异常' }}</span>
        </div>
        <div v-for="p in platforms" :key="p.id" class="rail__stat" :title="p.name + ' · ' + p.who">
          <i class="dot" :class="p.on ? 'dot--ok' : 'dot--bad'"></i>
          <b>{{ p.name }}</b>
          <span>{{ p.who }}</span>
        </div>
      </div>
    </aside>

    <div class="main">
      <!-- 顶栏：折叠 + 当前页 + 右侧实时状态（跟 zhibo 的"在放什么"同一个位置） -->
      <header class="top">
        <button type="button" class="iconbtn iconbtn--fold"
          :title="fold ? '展开侧栏' : '收起侧栏'" @click="fold = !fold">
          <Icon name="menu"/>
        </button>
        <button type="button" class="iconbtn iconbtn--menu" aria-label="打开导航" @click="sheet = true">
          <Icon name="menu"/>
        </button>
        <div class="crumb">{{ currentLabel }}</div>
        <div class="spacer"></div>
        <button type="button" class="topstat" title="去任务中心" @click="go('jobs')">
          <i class="dot" :class="queueDot"></i>
          <span>{{ queueText }}</span>
        </button>
      </header>

      <!-- 标签页：打开过的页面停在这儿，能关能快切 -->
      <div class="tabbar">
        <button v-for="k in opened" :key="k" type="button" class="tbtn"
          :class="{ on: store.view === k }" @click="go(k)">
          {{ labelOf(k) }}
          <b v-if="opened.length > 1" class="tbtn__x" title="关闭" @click.stop="closeTab(k)">×</b>
        </button>
      </div>

      <main class="canvas">
        <div class="canvas__inner">
          <component :is="current"/>
        </div>
      </main>
    </div>

    <!-- 窄屏抽屉：导航 + 运行状态，一行 48px，拇指够得着 -->
    <Transition :css="false" @enter="sheetEnter" @leave="sheetLeave">
      <div v-if="sheet" class="mask mask--sheet" @click.self="sheet = false">
        <div class="sheet">
          <div class="sheet__head">
            <span class="brand__mark" aria-hidden="true">鱼</span>
            <span>
              <span class="brand__name">zhibo-auto</span>
              <span class="brand__scope">大肥鱼 · 本机</span>
            </span>
            <button type="button" class="iconbtn" aria-label="关闭导航" @click="sheet = false">
              <Icon name="x"/>
            </button>
          </div>

          <nav class="sheet__nav">
            <button v-for="m in MENUS" :key="m.key" type="button" class="sheet__item"
              :class="{ on: store.view === m.key }" @click="go(m.key)">
              <Icon :name="m.icon"/>
              <span>{{ m.label }}</span>
              <span v-if="m.key === 'jobs' && pending" class="nav__count">{{ pending }}</span>
            </button>
          </nav>

          <div class="sheet__foot">
            <div class="rail__stat">
              <i class="dot" :class="ffmpegOk ? 'dot--ok' : 'dot--bad'"></i>
              <b>ffmpeg</b><span>{{ ffmpegOk ? '可用' : '异常' }}</span>
            </div>
            <div v-for="p in platforms" :key="p.id" class="rail__stat">
              <i class="dot" :class="p.on ? 'dot--ok' : 'dot--bad'"></i>
              <b>{{ p.name }}</b><span>{{ p.who }}</span>
            </div>
          </div>
        </div>
      </div>
    </Transition>

    <div class="toasts">
      <TransitionGroup :css="false" @enter="toastEnter" @leave="toastLeave">
        <div v-for="t in store.toasts" :key="t.id" class="toast"
          :class="t.kind === 'bad' ? 'toast--bad' : t.kind === 'ok' ? 'toast--ok' : ''">
          <span>{{ t.msg }}</span>
        </div>
      </TransitionGroup>
    </div>
  </div>`,
}

const app = createApp(App)

/* 全局组件：三个基础件，视图里直接用 */
app.component('Icon', Icon)
app.component('Btn', Btn)
app.component('NumBox', NumBox)

/* v-scan：挂上就扫，卸载就停（二维码只在"正在等"的时候存在） */
app.directive('scan', {
  mounted(el) { el._stopScan = startScan(el) },
  unmounted(el) { if (el._stopScan) el._stopScan() },
})

app.mount('#app')
