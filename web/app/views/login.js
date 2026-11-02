/* ═══════════════════════════════════════════════════════════════
 * views/login.js —— 平台登录
 *
 * 这个屏幕要回答的一个问题：**两个平台的登录态现在还有效吗？**
 * 所以左边一张卡一件事，状态徽标和账号名放在卡头，二维码是主体。
 *
 * 状态放在模块作用域：切到别的页面再切回来，正在轮询的定时器
 * 不会被打断（跟原来的行为一致）。
 * ═══════════════════════════════════════════════════════════════ */

const { reactive, computed } = Vue
import { api } from '../core/api.js'
import { store, refresh, toast } from '../store.js'

const PLATFORMS = [
  { id: 'douyin', name: '抖音', way: '二维码原图', hint: '用抖音 App 扫这张码（512×512 原图，失效会自动换新的）' },
  { id: 'bili', name: 'B站', way: '窗口截图', hint: '浏览器窗口已经弹出（桌面上找一下）；这张图就是窗口实时画面' },
]

/* 登录现场：每个平台一份，互不干扰 */
const ctx = reactive({
  douyin: { active: false, msg: '', ts: 0, timer: null, busy: false },
  bili: { active: false, msg: '', ts: 0, timer: null, busy: false },
})

async function startLogin(p) {
  const c = ctx[p]
  c.busy = true
  try {
    const r = await api.loginStart(p)
    if (r.already) { c.msg = r.why || '已经登录过了'; return }
    c.active = true
    c.msg = '浏览器已弹出，等二维码…'
    c.ts = Date.now()
    clearInterval(c.timer)
    c.timer = setInterval(() => pollLogin(p), 2500)
  } catch (e) {
    c.msg = String(e.message || e)
    toast(`启动登录失败：${c.msg}`, 'bad')
  } finally {
    c.busy = false
  }
}

async function pollLogin(p) {
  const c = ctx[p]
  try {
    const r = await api.loginCheck(p)
    c.ts = Date.now()
    if (r.loggedIn) {
      clearInterval(c.timer)
      c.timer = null
      c.active = false
      c.msg = `登录成功：${r.who?.name || '已登录'}，登录态已存本机`
      toast(`${p === 'douyin' ? '抖音' : 'B站'} 登录成功`, 'ok')
      refresh()
    } else {
      c.msg = r.why || '还在等扫码…'
    }
  } catch {
    /* 抖一下别断轮询，下一轮再说 */
  }
}

function stopPoll(p) {
  clearInterval(ctx[p].timer)
  ctx[p].timer = null
  ctx[p].active = false
  ctx[p].msg = '已停止轮询（浏览器窗口还开着，可以继续扫）'
}

async function checkLogin(p) {
  const c = ctx[p]
  try {
    const r = await api.loginCheck(p)
    c.msg = r.loggedIn ? `已登录：${r.who?.name || ''}` : (r.why || '未登录')
    if (r.loggedIn) refresh()
  } catch (e) {
    c.msg = String(e.message || e)
  }
}

export const LoginView = {
  name: 'LoginView',
  setup() {
    const cards = computed(() => PLATFORMS.map((p) => {
      const st = store.platforms[p.id] || {}
      const c = ctx[p.id]
      return {
        ...p,
        st,
        c,
        loggedIn: Boolean(st.loggedIn),
        who: st.who?.name || '',
        qrSrc: `/login/${p.id}/qr?ts=${c.ts}`,
      }
    }))

    return { cards, startLogin, checkLogin, stopPoll, store }
  },
  template: `
  <div>
    <header class="head">
      <div class="head__main">
        <h1>平台登录</h1>
        <p class="head__sub">
          扫码授权，登录态只存这台机器。抖音用二维码原图，B站截浏览器窗口。
        </p>
      </div>
    </header>

    <div class="grid grid--2">
      <section v-for="c in cards" :key="c.id" class="card">
        <div class="card__head">
          <h2 class="card__title">{{ c.name }}</h2>
          <span class="pill" :class="c.loggedIn ? 'pill--ok' : 'pill--bad'">
            {{ c.loggedIn ? '已登录' : '未登录' }}
          </span>
          <span class="card__meta">{{ c.loggedIn ? (c.who || '账号名未取到') : '—' }}</span>
        </div>

        <!-- 码在左，说明和动作在右 -->
        <div class="login">
          <div v-if="c.c.active" class="qr">
            <img :src="c.qrSrc" :alt="c.name + ' 登录二维码'">
            <span v-scan class="qr__scan"></span>
          </div>

          <div v-else-if="c.loggedIn" class="qr__empty">
            <Icon name="check"/>
            <span>登录态有效<br>要换账号就重新扫码</span>
          </div>

          <div v-else class="qr__empty">
            <Icon name="qr"/>
            <span>还没开始登录<br>点右边「开始登录」</span>
          </div>

          <div class="login__side">
            <div class="kv">
              <div class="kv__row"><span class="kv__k">登录方式</span><span class="kv__v">{{ c.way }}</span></div>
              <div class="kv__row"><span class="kv__k">登录态</span><span class="kv__v">本机 profile</span></div>
              <div class="kv__row"><span class="kv__k">失效后</span><span class="kv__v">重扫一次</span></div>
            </div>

            <p class="field__help" style="line-height:1.6;margin:0">
              {{ c.c.msg || (c.c.active ? c.hint : (c.loggedIn
                ? '这个号已经能直接干活了。'
                : '点「开始登录」，浏览器会弹出登录页。')) }}
            </p>

            <div class="login__acts">
              <Btn icon="qr" :loading="c.c.busy" @click="startLogin(c.id)">开始登录</Btn>
              <Btn variant="quiet" @click="checkLogin(c.id)">查状态</Btn>
              <Btn v-if="c.c.active" variant="quiet" @click="stopPoll(c.id)">停止轮询</Btn>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 扫码卡住了怎么办 —— 这三条是真会遇到的情况 -->
    <section class="card mt4">
      <div class="card__head">
        <h2 class="card__title">扫码扫不上</h2>
        <span class="card__meta">按遇到的顺序排</span>
      </div>
      <div class="grid grid--3">
        <div>
          <p style="margin:0;font-size:13px;font-weight:500">抖音一直转圈</p>
          <p class="field__help" style="margin:4px 0 0;line-height:1.6">
            多半是被判成机器人在过滑块。把弹出的窗口切到前台，手动滑一下就好，
            不用重新点「开始登录」。
          </p>
        </div>
        <div>
          <p style="margin:0;font-size:13px;font-weight:500">B站找不到窗口</p>
          <p class="field__help" style="margin:4px 0 0;line-height:1.6">
            窗口是独立开的，不在浏览器标签里。看任务栏，或者用右边这张实时截图扫。
          </p>
        </div>
        <div>
          <p style="margin:0;font-size:13px;font-weight:500">明明登过了还是未登录</p>
          <p class="field__help" style="margin:4px 0 0;line-height:1.6">
            平台把登录态踢了。点「查状态」确认一次，还是未登录就重扫 —— 检查结果有 30 秒缓存。
          </p>
        </div>
      </div>
    </section>

    <p class="mt4" style="font-size:12px;color:var(--muted);line-height:1.7">
      二维码每 2.5 秒刷新一次，过期的码会被新的顶掉，不用手动重开。
    </p>
  </div>`,
}
