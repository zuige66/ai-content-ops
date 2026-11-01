/* ═══════════════════════════════════════════════════════════════
 * views/video.js —— 视频工坊
 *
 * 这个屏幕要回答的一个问题：**这一期能不能直接出片？**
 * 所以顺序就是干活的顺序：选题 → 审文案 → 出片，最后一块是跑批现场。
 *
 * 这个产品独有的那个东西（签名元素）也在最后一块：**成片流水线**
 * 文案 → 配音 → 录制 → 合成 → 封面。五个阶段全部来自后端
 * pipeline.mjs / make.mjs 真实 step() 的文案，不是编的。
 *
 * 状态在模块作用域：切走再切回来，写了一半的文案还在。
 * ═══════════════════════════════════════════════════════════════ */

const { reactive, ref, computed } = Vue
import { api } from '../core/api.js'
import { refresh, toast } from '../store.js'
import { nudge } from '../core/motion.js'
import { charsToSec } from '../core/ui.js'

/** 时间戳 → 「3 小时前」 */
function ago(ms) {
  if (!ms) return '—'
  const s = Math.max(0, (Date.now() - Number(ms)) / 1000)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

/* 稿子：默认留一个能直接跑的示例主题，省得每次从空开始 */
const draft = reactive({
  template: 'diary',
  day: 1,
  durSec: 90,
  topic: '第一次被主人放出来做视频，结果发现同行已经在B站当UP主了',
  journalTitle: '',
  title: '',
  coverText: '',
  tags: [],
  segmentText: '',
  narration: '',
})

const busy = reactive({ script: false, make: false, cover: false, pipe: false })

const types = ref([])

/* 跑批现场 */
const live = reactive({
  job: null,
  keyframes: [],
  mp4: null,
  cover: null,
  timer: null,
})

/* 本地成片库：video/out 里出过的所有片子（不是这一个任务，是历史全部） */
const lib = reactive({ items: [], present: 0, missing: 0, loading: false, loaded: false })

async function loadLib() {
  lib.loading = true
  try {
    const r = await api.videoList()
    lib.items = r.items || []
    lib.present = r.present || 0
    lib.missing = r.missing || 0
    lib.loaded = true
  } catch {
    /* 成片库拿不到不影响出片 */
  } finally {
    lib.loading = false
  }
}

/* 五个阶段 —— 关键词对着后端 step() 的真实文案写的 */
const STAGES = [
  { key: 'script', label: '文案', re: /写文案|文案好了|token|标题「|类型：/ },
  { key: 'tts', label: '配音', re: /TTS|配音/ },
  { key: 'record', label: '录制', re: /版式：|录制|Chrome 启动/ },
  { key: 'mux', label: '合成', re: /合成|拼接|成片|mp4/i },
  { key: 'cover', label: '封面', re: /出封面|封面/ },
]

/* ── 数据准备 ───────────────────────────────────────────────── */
async function loadTypes() {
  try {
    const r = await api.types()
    types.value = r.types || []
    if (!types.value.some((t) => t.id === draft.template)) draft.template = types.value[0]?.id || 'diary'
  } catch {
    /* 拿不到清单不影响写文案，只是版式选项空着 */
  }
}

/** 一行一段；`::卡名|大字|小字` 是信息卡 */
function parseSegments(text) {
  return String(text).split('\n').map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.startsWith('::')) {
      const [title, big, small] = s.slice(2).split('|').map((x) => (x || '').trim())
      return { card: { title, big, small } }
    }
    return { text: s }
  })
}

function applyScript(s) {
  draft.title = s.title || ''
  draft.journalTitle = s.journalTitle || ''
  draft.coverText = s.coverText || ''
  draft.tags = s.tags || []
  draft.day = s.day || draft.day
  draft.segmentText = (s.segments || [])
    .map((x) => (x.card ? `::${x.card.title}|${x.card.big}|${x.card.small}` : x.text))
    .join('\n')
  draft.narration = s.narration || ''
}

/* ── 动作 ───────────────────────────────────────────────────── */

/** 只调 LLM，不渲染 —— 几秒出结果，改一版不心疼 */
async function genScript() {
  if (!String(draft.topic || '').trim()) {
    toast('先写个主题（一句话就行）', 'bad')
    return
  }
  busy.script = true
  try {
    const r = await api.script({
      topic: draft.topic,
      durSec: draft.durSec,
      day: draft.day,
      template: draft.template,
    })
    applyScript(r.script)
    live.job = { status: 'done', steps: [{ msg: `文案好了：${r.script.segments.length} 段 / ${r.script.meta.chars} 字（${r.ms}ms）` }] }
    toast('文案写好了，可以直接改', 'ok')
  } catch (e) {
    live.job = { status: 'failed', steps: [], error: String(e.message || e) }
    toast(String(e.message || e), 'bad')
  } finally {
    busy.script = false
  }
}

/** 出片：排队渲染，1~2 分钟 */
async function makeVideo() {
  const body = {
    template: draft.template,
    title: draft.title,
    narration: draft.narration,
    petImage: 'D:/Workplace/zhibo/assets/pet2-still.png',
  }
  if (draft.template === 'diary') {
    body.day = draft.day
    body.journalTitle = draft.journalTitle
    body.segments = parseSegments(draft.segmentText)
  } else {
    body.lines = String(draft.segmentText).split('\n').map((s) => s.trim()).filter(Boolean)
  }
  if (!body.title && !(body.lines || []).length && !(body.segments || []).length) {
    toast('至少给个标题或一段文案', 'bad')
    return
  }
  busy.make = true
  live.keyframes = []
  live.mp4 = null
  try {
    const r = await api.makeVideo(body)
    watch(r.jobId)
  } catch (e) {
    live.job = { status: 'failed', steps: [], error: String(e.message || e) }
    toast(String(e.message || e), 'bad')
  } finally {
    busy.make = false
  }
}

/** 出封面：零 token、十来秒，可以反复试字直到满意 */
async function makeCover() {
  const big = String(draft.coverText || draft.journalTitle || '').trim()
  if (!big) {
    toast('先填「封面大字」（6-10 字最狠）', 'bad')
    return
  }
  busy.cover = true
  try {
    const r = await api.cover({ big, sub: draft.title, day: draft.day })
    live.cover = r.url
    live.job = { status: 'done', steps: [{ msg: `封面好了：${r.width}×${r.height}，${r.kb}KB（${r.ms}ms）` }] }
  } catch (e) {
    live.job = { status: 'failed', steps: [], error: String(e.message || e) }
    toast(String(e.message || e), 'bad')
  } finally {
    busy.cover = false
  }
}

/** 一条龙：主题 → 文案 → 成片 → 封面，后端排队跑 */
async function runPipeline() {
  if (!String(draft.topic || '').trim()) {
    toast('先写个主题（一句话就行）', 'bad')
    return
  }
  busy.pipe = true
  live.keyframes = []
  live.mp4 = null
  try {
    const r = await api.pipeline({
      topic: draft.topic,
      durSec: draft.durSec,
      day: draft.day,
      template: draft.template,
    })
    toast('已排队：文案 → 出片，进度看下面', 'ok')
    watch(r.jobId)
  } catch (e) {
    live.job = { status: 'failed', steps: [], error: String(e.message || e) }
    toast(String(e.message || e), 'bad')
  } finally {
    busy.pipe = false
  }
}

/** 盯着一个任务：1.5 秒一拍，结束就取关键帧和成片 */
function watch(jobId) {
  clearInterval(live.timer)
  live.job = { status: 'running', steps: [], id: jobId }
  live.timer = setInterval(async () => {
    try {
      const r = await api.steps(jobId)
      const before = live.job?.steps?.length || 0
      live.job = r.job
      if ((r.job.steps || []).length > before) {
        nudge(document.querySelector('[data-live]'))
      }
      if (['done', 'failed'].includes(r.job.status)) {
        clearInterval(live.timer)
        live.timer = null
        const pv = await api.preview(jobId)
        live.keyframes = pv.keyframes || []
        live.mp4 = pv.mp4
        if (pv.cover) live.cover = pv.cover
        refresh()
        loadLib()          // 新出的片子立刻出现在成片库里
      }
    } catch {
      /* 抖一下继续盯 */
    }
  }, 1500)
}

/* ── 组件 ───────────────────────────────────────────────────── */
export const VideoView = {
  name: 'VideoView',
  setup() {
    if (!types.value.length) loadTypes()
    if (!lib.loaded) loadLib()

    const currentType = computed(() => types.value.find((t) => t.id === draft.template) || null)
    const chars = computed(() => (draft.narration.length || draft.segmentText.length))
    const estSec = computed(() => charsToSec(chars.value))

    /* 副标题只说事实：版式、时长、Day；有稿子才报字数，别写"约 0 字" */
    const headLine = computed(() => {
      const bits = []
      if (currentType.value) bits.push(`${currentType.value.name} · ${currentType.value.tag}`)
      bits.push(`${draft.durSec} 秒`)
      bits.push(`Day ${draft.day}`)
      if (chars.value) bits.push(`${chars.value} 字 / 约 ${estSec.value} 秒`)
      return bits.join(' · ')
    })

    const steps = computed(() => live.job?.steps || [])
    const isDone = computed(() => live.job?.status === 'done')
    const isFail = computed(() => live.job?.status === 'failed')

    /* 当前跑到第几个阶段：按后端 step 文案里出现的最靠后的那个阶段算 */
    const stageAt = computed(() => {
      const msgs = steps.value.map((s) => s.msg || '')
      let idx = -1
      STAGES.forEach((st, i) => {
        if (msgs.some((m) => st.re.test(m))) idx = Math.max(idx, i)
      })
      return idx
    })

    const pipe = computed(() => STAGES.map((st, i) => {
      if (isDone.value) return { ...st, cls: 'is-done' }
      if (isFail.value && i === stageAt.value) return { ...st, cls: 'is-fail' }
      if (i < stageAt.value) return { ...st, cls: 'is-done' }
      if (i === stageAt.value) return { ...st, cls: 'is-now' }
      return { ...st, cls: '' }
    }))

    const statusPill = computed(() => {
      if (!live.job) return null
      const s = live.job.status
      if (s === 'done') return { text: '完成', cls: 'pill--ok' }
      if (s === 'failed') return { text: '失败', cls: 'pill--bad' }
      return { text: '进行中', cls: 'pill--accent' }
    })

    return {
      draft, busy, live, types, currentType, chars, estSec, headLine,
      steps, pipe, stageAt, statusPill, isDone, isFail,
      genScript, makeVideo, makeCover, runPipeline,
      lib, loadLib, ago,
      refresh,
    }
  },
  template: `
  <div>
    <header class="head">
      <div class="head__main">
        <h1>视频工坊</h1>
        <p class="head__sub">{{ headLine }}</p>
      </div>
      <div class="head__actions">
        <Btn variant="primary" icon="spark" :loading="busy.pipe" @click="runPipeline">一条龙出片</Btn>
      </div>
    </header>

    <!-- ① 选题 -->
    <section class="card">
      <div class="card__head">
        <h2 class="card__title">选题</h2>
        <span class="card__meta">{{ types.length }} 种版式</span>
      </div>

      <div class="seg">
        <button v-for="t in types" :key="t.id" class="seg__item"
          :class="{ on: draft.template === t.id }" @click="draft.template = t.id">
          {{ t.name }}<span class="seg__tag">{{ t.tag }}</span>
        </button>
      </div>

      <div class="row mt3" style="align-items:flex-end;gap:12px">
        <div class="field" style="flex:1;min-width:240px">
          <label class="field__label">主题</label>
          <input class="input" v-model="draft.topic"
            placeholder="一句话说清这期讲什么，AI 按红烧鱼人设写成日记体">
        </div>
        <div class="field">
          <label class="field__label">时长（秒）</label>
          <NumBox v-model="draft.durSec" :min="45" :max="120" :step="15" :width="46"/>
        </div>
        <div class="field">
          <label class="field__label">Day</label>
          <NumBox v-model="draft.day" :min="0" :step="1" :width="42"/>
        </div>
        <Btn icon="doc" :loading="busy.script" @click="genScript">写文案</Btn>
      </div>

      <p v-if="currentType" class="field__help mt2">{{ currentType.desc }}</p>
    </section>

    <!-- ② 审文案 -->
    <section class="card mt4">
      <div class="card__head">
        <h2 class="card__title">文案审校</h2>
        <span class="card__meta">改文案不花渲染时间</span>
      </div>

      <div class="grid grid--2">
        <div class="stack" style="gap:12px">
          <div class="field">
            <label class="field__label">标题（发布用）</label>
            <input class="input" v-model="draft.title" placeholder="发布时挂在视频上的标题">
          </div>
          <div class="grid grid--2" style="gap:12px">
            <div class="field">
              <label class="field__label">日记名</label>
              <input class="input" v-model="draft.journalTitle" placeholder="比如：Day 3 · 第一次出门">
            </div>
            <div class="field">
              <label class="field__label">封面大字</label>
              <input class="input" v-model="draft.coverText" placeholder="6-10 字最狠">
            </div>
          </div>
          <div class="field">
            <label class="field__label">段落（一行一条，<span class="mono">::卡名|大字|小字</span> 是信息卡）</label>
            <textarea class="textarea textarea--code" v-model="draft.segmentText" rows="10"
              placeholder="一行一段，空行会被忽略"></textarea>
          </div>
        </div>

        <div class="stack stack--fill" style="gap:12px">
          <div class="field">
            <label class="field__label">旁白（配音文案，留空就读上面的段落）</label>
            <textarea class="textarea" v-model="draft.narration" rows="10"
              placeholder="口语一点，念出来要顺"></textarea>
          </div>
          <div class="kv">
            <div class="kv__row"><span class="kv__k">字数</span><span class="kv__v">{{ chars }}</span></div>
            <div class="kv__row"><span class="kv__k">预计时长</span><span class="kv__v">{{ estSec }} 秒</span></div>
            <div class="kv__row"><span class="kv__k">标签</span>
              <span class="kv__v">{{ draft.tags.length ? draft.tags.join(' / ') : '—' }}</span></div>
          </div>
        </div>
      </div>

      <div class="card__foot">
        <Btn icon="play" :loading="busy.make" @click="makeVideo">出片</Btn>
        <Btn icon="image" :loading="busy.cover" @click="makeCover">出封面</Btn>
        <span class="spacer"></span>
        <span style="font-size:12px;color:var(--muted)">皮套动效自动取 zhibo 的 pet2；出片 1~2 分钟，封面约 10 秒</span>
      </div>
    </section>

    <!-- ③ 跑批现场 -->
    <section class="card mt4" data-live>
      <div class="card__head">
        <h2 class="card__title">跑批现场</h2>
        <span v-if="statusPill" class="pill" :class="statusPill.cls">{{ statusPill.text }}</span>
        <span class="card__meta">{{ live.job && live.job.id ? live.job.id : '' }}</span>
      </div>

      <!-- 签名元素：成片流水线。五个阶段取自后端真实 step 文案 -->
      <div class="pipe">
        <div v-for="(s, i) in pipe" :key="s.key" class="pipe__stage" :class="s.cls">
          <div class="pipe__node">
            <span class="pipe__dot"></span>
            <span class="pipe__label">{{ s.label }}</span>
          </div>
          <span v-if="i < pipe.length - 1" class="pipe__bar"></span>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:24px">
        <div>
          <div v-if="live.job && live.job.error" class="alert alert--bad">{{ live.job.error }}</div>

          <div v-else-if="steps.length" class="steps">
            <div v-for="(s, i) in steps" :key="i" class="step"
              :class="{ done: isDone || i < steps.length - 1, cur: !isDone && i === steps.length - 1 }">
              <div class="step__rail"><i class="step__dot"></i></div>
              <div class="step__msg">{{ s.msg }}</div>
            </div>
          </div>

          <div v-else class="empty">
            还没有任务<br>上面写文案，或者直接「一条龙出片」
          </div>

          <div v-if="live.keyframes.length" class="mt4">
            <p class="field__help" style="margin-bottom:8px">关键帧（{{ live.keyframes.length }} 张）</p>
            <div class="kf">
              <img v-for="f in live.keyframes" :key="f" :src="f" alt="关键帧">
            </div>
          </div>

          <div v-if="live.mp4" class="mt3">
            <a class="link" :href="live.mp4" target="_blank" rel="noopener">▶ 打开成片</a>
          </div>
        </div>

        <!-- 封面：竖屏 9:16 收在一个固定高的框里，别让它把整张卡拉长 -->
        <div>
          <p class="field__help" style="margin-bottom:8px">封面</p>
          <img v-if="live.cover" :src="live.cover" alt="封面"
            style="width:100%;height:240px;object-fit:contain;background:var(--raised);
                   border:1px solid var(--border);border-radius:4px;display:block">
          <div v-else class="empty" style="height:240px;padding:12px">还没有封面</div>
        </div>
      </div>
    </section>

    <!-- ④ 本地成片：出过的片子都在，关页面/重启服务也不丢 -->
    <section class="card mt4">
      <div class="card__head">
        <h2 class="card__title">本地成片</h2>
        <span class="card__meta" v-if="lib.loaded">
          {{ lib.present }} 条在盘<span v-if="lib.missing"> · {{ lib.missing }} 条记录还在但文件已删</span>
        </span>
        <span class="spacer"></span>
        <Btn size="sm" variant="quiet" icon="refresh" :loading="lib.loading" @click="loadLib">重新扫</Btn>
      </div>

      <div v-if="lib.items.length" class="lib">
        <div v-for="x in lib.items" :key="x.id" class="lib__row" :class="{ 'lib__row--gone': x.missing }">
          <div class="lib__thumb">
            <img v-if="x.cover || x.keyframe" :src="x.cover || x.keyframe" :alt="x.title || x.id" loading="lazy">
            <span v-else class="lib__noimg">{{ x.missing ? '文件已删' : '无封面' }}</span>
          </div>
          <div class="lib__main">
            <div class="lib__title">{{ x.title || x.id }}</div>
            <div class="lib__meta">
              <span class="mono">{{ x.id }}</span>
              <span v-if="!x.missing">{{ x.sizeMB }} MB</span>
              <span>{{ ago(x.mtime) }}</span>
              <span v-if="x.frames">{{ x.frames }} 张关键帧</span>
            </div>
          </div>
          <div class="lib__act">
            <a v-if="!x.missing" class="link" :href="x.mp4" target="_blank" rel="noopener">▶ 播放</a>
            <span v-else class="pill pill--bad">文件已删</span>
          </div>
        </div>
      </div>
      <div v-else class="empty">
        还没有成片<br>上面出一片，或者直接「一条龙出片」
      </div>
    </section>
  </div>`,
}
