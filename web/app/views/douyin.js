/* ═══════════════════════════════════════════════════════════════
 * views/douyin.js —— 抖音账号（数据 + 回复评论 + 编辑入口）
 *
 * 这个屏幕要回答三个问题：
 *   1. 我这个号现在什么样？（头像/简介/背景/粉丝/作品数据/直播）
 *   2. 这条作品下面谁在说什么？（点作品 → 右侧评论）
 *   3. 我要回一句 / 改一下，从哪儿下手？（回复框 + 编辑按钮）
 *
 * 写操作一律两段式：点「发送」只回显将要发的 payload，再点一次才真发。
 * 编辑不代发 —— 后端只负责把真实后台的编辑页弹出来。
 * ═══════════════════════════════════════════════════════════════ */

const { ref, computed, onMounted } = Vue
import { api } from '../core/api.js'
import { toast } from '../store.js'

/** 大数字压成「1.2万」——表里六列数字，不压缩根本读不过来 */
function fmt(n) {
  const v = Number(n) || 0
  if (v >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, '') + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万'
  return String(v)
}

function day(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts) * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function when(ts) {
  if (!ts) return '—'
  const s = Math.max(0, Date.now() / 1000 - Number(ts))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return day(ts).slice(5)
}

/** 数据抓取时间（毫秒）→ 「3 小时前」。缓存是落盘的，重启也不丢，得让人知道新旧 */
function ago(ms) {
  if (!ms) return '—'
  const s = Math.max(0, (Date.now() - Number(ms)) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`
  return `${Math.round(s / 86400)} 天前`
}

export const DouyinView = {
  name: 'DouyinView',
  setup() {
    const loading = ref(true)
    const refreshing = ref(false)
    const dataAt = ref(0)          // 这批数据是什么时候从抖音抓的
    const error = ref('')
    const prof = ref(null)
    const works = ref([])
    const live = ref({ onAir: null, sessions: [] })

    const selId = ref('')
    const cm = ref(null)            // { item, comments, total }
    const cmLoading = ref(false)
    const cmError = ref('')

    const replyTo = ref(null)       // 正在回复的那条评论
    const replyText = ref('')
    const pending = ref(null)       // dry-run 结果：{ will, note }
    const sending = ref(false)

    const sel = computed(() => works.value.find((w) => w.plainId === selId.value) || null)

    /** 评论作者：后端有时给字符串，有时给 { nickname } —— 两种都得认 */
    const authorName = (c) => {
      const u = c && c.user
      if (!u) return '匿名'
      if (typeof u === 'string') return u
      return u.nickname || u.name || '匿名'
    }

    const totals = computed(() => {
      const t = { play: 0, digg: 0, comment: 0 }
      for (const w of works.value) {
        t.play += w.stats.play; t.digg += w.stats.digg; t.comment += w.stats.comment
      }
      return t
    })

    async function load({ quiet = false } = {}) {
      if (!quiet) loading.value = true
      error.value = ''
      try {
        const [p, w, l] = await Promise.all([api.dyProfile(), api.dyWorks(20), api.dyLive(90)])
        prof.value = p.profile
        works.value = w.items || []
        live.value = { onAir: l.onAir, sessions: l.sessions || [] }
        dataAt.value = Math.max(p.cachedAt || 0, w.cachedAt || 0, l.cachedAt || 0)
        if (!selId.value && works.value.length) openComments(works.value[0])
      } catch (e) {
        error.value = String(e.message || e)
      } finally {
        loading.value = false
      }
    }

    /** 刷新 = 真去抖音抓一遍（平时读的都是本地缓存，只有这里会打接口） */
    async function reload() {
      refreshing.value = true
      try {
        const r = await api.dyRefresh()
        await load({ quiet: true })
        /* 评论缓存也被清了，当前这条要重拉一次，否则还是旧的 */
        if (selId.value) {
          const w = works.value.find((x) => x.plainId === selId.value)
          if (w) await openComments(w)
        }
        if (r.ok) toast(`已重新抓取（${Math.round((r.ms || 0) / 1000)} 秒）`, 'ok')
        else toast('部分数据没抓到，看控制台日志', 'bad')
      } catch (e) {
        toast(String(e.message || e), 'bad')
      } finally {
        refreshing.value = false
      }
    }

    async function openComments(w) {
      if (!w) return
      selId.value = w.plainId
      replyTo.value = null
      pending.value = null
      replyText.value = ''
      cmLoading.value = true
      cmError.value = ''
      try {
        const r = await api.dyComments(w.plainId)
        cm.value = r
      } catch (e) {
        cm.value = null
        cmError.value = String(e.message || e)
      } finally {
        cmLoading.value = false
      }
    }

    /* ── 回复：两段式 ── */
    function startReply(c) {
      replyTo.value = c
      pending.value = null
      replyText.value = ''
    }
    function cancelReply() {
      replyTo.value = null
      pending.value = null
      replyText.value = ''
    }

    /** 第一次点「发送」：不发，只问后端"我打算发这个" */
    async function askSend() {
      const text = replyText.value.trim()
      if (!text) return
      sending.value = true
      try {
        const r = await api.dyReply({
          itemId: selId.value,
          commentId: replyTo.value.id,
          text,
        })
        pending.value = r
      } catch (e) {
        toast(String(e.message || e), 'bad')
      } finally {
        sending.value = false
      }
    }

    /** 第二次点「确认发送」：真发 */
    async function doSend() {
      sending.value = true
      try {
        await api.dyReply({
          itemId: selId.value,
          commentId: replyTo.value.id,
          text: replyText.value.trim(),
          confirm: true,
        })
        toast('回复已发出', 'ok')
        cancelReply()
        await openComments(sel.value)
      } catch (e) {
        toast(String(e.message || e), 'bad')
      } finally {
        sending.value = false
      }
    }

    async function openEditor(w) {
      try {
        await api.dyOpenEditor({ itemId: w ? w.plainId : '' })
        toast('已弹出后台编辑页，在作品那一行点「编辑」', 'ok')
      } catch (e) {
        toast(String(e.message || e), 'bad')
      }
    }

    onMounted(() => load())

    return {
      loading, error, prof, works, live, selId, sel, totals,
      cm, cmLoading, cmError,
      replyTo, replyText, pending, sending,
      refreshing, dataAt,
      load, reload, openComments, startReply, cancelReply, askSend, doSend, openEditor,
      fmt, day, when, ago, authorName,
    }
  },

  template: `
  <div>
    <header class="head">
      <div class="head__main">
        <h1>{{ prof ? prof.nickname : '抖音账号' }}</h1>
        <p class="head__sub" v-if="prof">
          抖音号 {{ prof.uniqueId }} · {{ prof.city || '—' }} · 作品 {{ prof.awemeCount }} 条
          <span v-if="dataAt" style="color:var(--muted)"> · 数据抓取于 {{ ago(dataAt) }}</span>
        </p>
        <p class="head__sub" v-else>正在读账号数据…</p>
      </div>
      <div class="head__actions">
        <Btn variant="quiet" icon="refresh" :loading="refreshing" @click="reload">刷新</Btn>
        <Btn icon="doc" @click="openEditor(sel)">在后台编辑</Btn>
      </div>
    </header>

    <div v-if="error" class="alert alert--bad" style="margin-bottom:16px">
      <span>{{ error }}</span>
    </div>

    <!-- ── 账号卡：背景图打底，头像压在上面 ── -->
    <section class="card" style="padding:0;overflow:hidden">
      <div :style="{
        height: '96px',
        background: prof && prof.cover ? 'url(' + prof.cover + ') center/cover no-repeat' : 'var(--accent-soft)',
        borderBottom: '1px solid var(--border)'
      }"></div>
      <div style="display:flex;gap:16px;align-items:flex-start;padding:0 24px 20px;margin-top:-28px">
        <img v-if="prof && prof.avatar" :src="prof.avatar" alt="头像"
          style="width:64px;height:64px;border-radius:50%;border:3px solid var(--surface);object-fit:cover;flex:0 0 auto" />
        <div style="min-width:0;flex:1;padding-top:32px">
          <div class="row">
            <strong style="font-size:15px">{{ prof ? prof.nickname : '—' }}</strong>
            <span class="pill pill--accent" v-if="live.onAir">
              <i class="dot dot--live"></i>直播中
            </span>
          </div>
          <p class="muted" style="margin:4px 0 0;font-size:13px;line-height:1.6">
            {{ prof && prof.signature ? prof.signature : '（没有简介）' }}
          </p>
        </div>
      </div>
      <div class="kpi" style="border-left:0;border-right:0;border-bottom:0;border-radius:0">
        <div class="kpi__cell">
          <div class="kpi__k">粉丝</div>
          <div class="kpi__v">{{ prof ? fmt(prof.followerCount) : '—' }}</div>
        </div>
        <div class="kpi__cell">
          <div class="kpi__k">获赞</div>
          <div class="kpi__v">{{ prof ? fmt(prof.totalFavorited) : '—' }}</div>
        </div>
        <div class="kpi__cell">
          <div class="kpi__k">作品播放（近 20 条）</div>
          <div class="kpi__v">{{ fmt(totals.play) }}</div>
        </div>
        <div class="kpi__cell">
          <div class="kpi__k">评论（近 20 条）</div>
          <div class="kpi__v kpi__v--accent">{{ fmt(totals.comment) }}</div>
        </div>
      </div>
    </section>

    <!-- ── 作品 + 评论 ── -->
    <div class="grid grid--rail" style="margin-top:24px">
      <section class="card card--fill">
        <div class="card__head">
          <h2 class="card__title">作品</h2>
          <span class="card__meta">{{ works.length }} 条 · 点一行看评论</span>
        </div>

        <div v-if="!works.length" class="empty">
          {{ loading ? '正在读…' : '没有作品' }}
        </div>
        <table v-else class="tbl">
          <thead>
            <tr>
              <th>作品</th>
              <th class="num hide-sm">发布</th>
              <th class="num">播放</th>
              <th class="num">赞</th>
              <th class="num">评论</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in works" :key="w.plainId" class="clickable"
              :class="{ sel: w.plainId === selId }" @click="openComments(w)">
              <td>
                <div class="row" style="flex-wrap:nowrap;gap:10px">
                  <img v-if="w.cover" :src="w.cover" alt=""
                    style="width:34px;height:34px;border-radius:4px;object-fit:cover;flex:0 0 auto" />
                  <div style="min-width:0">
                    <div class="cell-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px">
                      {{ w.title || '（无标题）' }}
                    </div>
                  </div>
                </div>
              </td>
              <td class="num hide-sm dash">{{ day(w.createTime) }}</td>
              <td class="num">{{ fmt(w.stats.play) }}</td>
              <td class="num">{{ fmt(w.stats.digg) }}</td>
              <td class="num">{{ fmt(w.stats.comment) }}</td>
              <td class="num">
                <Btn size="sm" variant="quiet" icon="doc" title="在后台打开编辑页"
                  @click.stop="openEditor(w)">编辑</Btn>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="card__foot">
          <span style="font-size:12px;color:var(--muted)">
            近 20 条合计：播放 {{ fmt(totals.play) }} · 赞 {{ fmt(totals.digg) }} · 评论 {{ fmt(totals.comment) }}
          </span>
        </div>
      </section>

      <!-- 评论面板 -->
      <section class="card card--fill">
        <div class="card__head">
          <h2 class="card__title">评论区</h2>
          <span class="card__meta" v-if="cm">{{ cm.total }} 条</span>
        </div>

        <p v-if="sel" class="muted" style="margin:0 0 12px;font-size:12px;line-height:1.5;
          overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">
          {{ sel.title }}
        </p>

        <div v-if="cmError" class="alert alert--bad">{{ cmError }}</div>
        <div v-else-if="cmLoading" class="empty">正在读评论…</div>
        <div v-else-if="!cm || !cm.comments.length" class="empty">
          这条作品还没有评论
        </div>

        <div v-else style="display:flex;flex-direction:column;gap:14px;max-height:460px;overflow-y:auto">
          <div v-for="c in cm.comments" :key="c.id" style="display:flex;gap:10px">
            <img v-if="c.avatar" :src="c.avatar" alt=""
              style="width:28px;height:28px;border-radius:50%;object-fit:cover;flex:0 0 auto" />
            <div style="min-width:0;flex:1">
              <div class="row" style="gap:6px">
                <span style="font-size:12px;font-weight:500">{{ authorName(c) }}</span>
                <span class="muted" style="font-size:11px">{{ when(c.createTime) }}</span>
                <span v-if="c.isAuthor" class="pill pill--accent" style="height:18px">作者</span>
              </div>
              <p style="margin:3px 0 0;font-size:13px;line-height:1.55;word-break:break-word">{{ c.text }}</p>
              <div class="row" style="gap:10px;margin-top:5px">
                <span class="muted" style="font-size:11px">赞 {{ c.digg }}</span>
                <span class="muted" style="font-size:11px" v-if="c.replyCount">回复 {{ c.replyCount }}</span>
                <button class="btn btn--quiet btn--sm" style="height:22px;padding:0 6px;font-size:11px"
                  @click="startReply(c)">回复</button>
              </div>

              <!-- 回复框 -->
              <div v-if="replyTo && replyTo.id === c.id" style="margin-top:8px">
                <textarea class="textarea" v-model="replyText" maxlength="100"
                  placeholder="回一句（最多 100 字）" style="min-height:64px"></textarea>
                <div class="row" style="margin-top:8px">
                  <span class="muted" style="font-size:11px">{{ replyText.length }}/100</span>
                  <span class="spacer"></span>
                  <Btn size="sm" variant="quiet" @click="cancelReply">取消</Btn>
                  <Btn v-if="!pending" size="sm" :loading="sending" :disabled="!replyText.trim()" @click="askSend">
                    发送
                  </Btn>
                </div>

                <!-- dry-run：把要发的原样摆出来 -->
                <div v-if="pending" class="alert alert--warn" style="margin-top:8px;display:block">
                  <div style="margin-bottom:4px">确认要发这条吗？</div>
                  <div class="mono" style="font-size:11px;word-break:break-all;opacity:.85">
                    item_id: {{ pending.will.item_id }}<br/>
                    comment_Id: {{ pending.will.comment_Id }}<br/>
                    text: {{ pending.will.text }}
                  </div>
                  <div class="row" style="margin-top:8px">
                    <Btn size="sm" variant="primary" :loading="sending" @click="doSend">确认发送</Btn>
                    <Btn size="sm" variant="quiet" @click="pending = null">再看看</Btn>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- ── 直播 ── -->
    <section class="card" style="margin-top:24px">
      <div class="card__head">
        <h2 class="card__title">直播</h2>
        <span class="card__meta">
          {{ live.onAir ? '正在直播 · ' + live.onAir.title : '未开播' }} · 近 90 天 {{ live.sessions.length }} 场
        </span>
      </div>

      <div v-if="!live.sessions.length" class="empty">近 90 天没有直播记录</div>
      <table v-else class="tbl">
        <thead>
          <tr>
            <th>场次</th>
            <th class="num hide-sm">开始</th>
            <th class="num hide-sm">时长</th>
            <th class="num">观看</th>
            <th class="num">峰值</th>
            <th class="num">点赞</th>
            <th class="num">评论</th>
            <th class="num">涨粉</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in live.sessions" :key="s.roomId">
            <td>
              <div class="cell-name" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                {{ s.title || '（无标题）' }}
              </div>
              <div class="cell-sub" v-if="String(s.playStatus) === '2'" style="color:var(--accent)">直播中</div>
            </td>
            <td class="num hide-sm dash">{{ s.startTime || '—' }}</td>
            <td class="num hide-sm dash">{{ s.durationText || '—' }}</td>
            <td class="num">{{ fmt(s.watch) }}</td>
            <td class="num">{{ fmt(s.pcu) }}</td>
            <td class="num">{{ fmt(s.like) }}</td>
            <td class="num">{{ fmt(s.comment) }}</td>
            <td class="num">{{ fmt(s.newFollow) }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>`,
}
