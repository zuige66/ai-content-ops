/* ═══════════════════════════════════════════════════════════════
 * api.js —— 后端接口的唯一入口
 *
 * 路由一个没改，只是把 fetch 收口到这一层：
 *   · 统一解析 JSON，非 JSON 的返回直接说清楚（后端崩了常返回 HTML）
 *   · HTTP 错误和 { ok:false } 都当错误抛，调用方只管 try/catch
 *   · 错误文案优先用后端给的 error 字段，它比 "HTTP 500" 有用
 * ═══════════════════════════════════════════════════════════════ */

async function req(path, opt) {
  const res = await fetch(path, opt)
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return data
}

const get = (path) => req(path)
const post = (path, body) => req(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
})

export const api = {
  /* 状态与自检 */
  status: () => get('/status'),
  doctor: () => get('/ctl/doctor'),

  /* 控制面：这个进程自己怎么样（端口/pid/运行时长/队列/浏览器实例） */
  ctlStatus: () => get('/ctl/status'),
  ctlLog: (n = 200) => get(`/ctl/log?n=${n}`),

  /* 视频版式清单：从后端拿，前端不硬编码 —— 加新类型只改 video/types.mjs */
  types: () => get('/video/types'),

  /* 本地成片库：video/out 里出过的所有片子 */
  videoList: () => get('/video/list'),

  /* 同步动作（不排队）：写文案几秒、出封面十来秒 */
  script: (b) => post('/video/script', b),
  cover: (b) => post('/video/cover', b),

  /* 排队动作 */
  makeVideo: (b) => post('/video/make', b),
  pipeline: (b) => post('/pipeline/run', b),

  /* 任务 */
  steps: (id) => get(`/jobs/${id}/steps`),
  preview: (id) => get(`/video/preview/${id}`),
  confirm: (id, ok) => post(`/jobs/${id}/confirm`, { confirm: ok }),

  /* 日志 */
  logs: (p) => get(`/logs/${p}`),

  /* 登录 */
  loginStart: (p) => post(`/login/${p}/start`),
  loginCheck: (p) => get(`/login/${p}/check`),

  /* 抖音账号数据（只读，读的是本地缓存） */
  dyProfile: () => get('/douyin/profile'),
  dyWorks: (limit = 20) => get(`/douyin/works?limit=${limit}`),
  dyComments: (item, cursor = 0) => get(`/douyin/comments?item=${encodeURIComponent(item)}&cursor=${cursor}`),
  dyLive: (days = 90) => get(`/douyin/live?days=${days}`),
  /* 唯一会真去打抖音的入口 */
  dyRefresh: () => post('/douyin/refresh'),
  dyCache: () => get('/douyin/cache'),

  /* 抖音写操作：先 dry-run，确认后再发 */
  dyReply: (b) => post('/douyin/reply', b),
  dyOpenEditor: (b) => post('/douyin/edit/open', b),
}
