/* core/agent-api.mjs —— 给 AI 用的接口清单
 * ═══════════════════════════════════════════════════════════════
 * 目的：任何 agent（包括别的会话、别的模型）接上来，先 GET /agent
 * 就知道这个后端能干什么、要传什么、有没有副作用，不用翻代码。
 *
 * sideEffect 三档，写清楚是为了让 agent 自己决定要不要先问人：
 *   read    只读，随便调
 *   dry-run 会起浏览器/花 token，但**不产生对外可见的结果**
 *   write   真的会动线上账号，必须两段式（先 dry-run 再 confirm）
 * ═══════════════════════════════════════════════════════════════ */

const r = (method, path, desc, extra = {}) => ({ method, path, desc, sideEffect: 'read', ...extra })

export const MANIFEST = {
  name: 'zhibo-auto 控制台',
  version: 1,
  note: '所有接口返回 JSON。{ok:false} 表示业务失败，error 字段是人话。写操作一律两段式：不带 confirm 只回显，带 confirm 才真发。',

  endpoints: [
    /* ── 自检与状态 ── */
    r('GET', '/status', '各平台登录态（抖音/B站）。会起无头 Chrome，首次约 10-30 秒', { sideEffect: 'dry-run' }),
    r('GET', '/doctor', '环境自检：ffmpeg / chrome / 目录'),
    r('GET', '/ctl/status', '这个进程自己的状态：端口、pid、运行时长、队列、浏览器实例'),
    r('GET', '/agent', '就是这份清单'),

    /* ── 视频生产 ── */
    r('GET', '/video/types', '可用的视频版式（diary 日记 / talk 口播），含 id/name/tag/desc'),
    r('POST', '/video/script', '只写文案，不渲染。几秒返回，改一版不心疼', {
      sideEffect: 'dry-run',
      body: { topic: '主题，一句话（必填）', durSec: '时长秒数，45-120', day: 'Day 号', template: 'diary | talk' },
      returns: { script: '{ title, journalTitle, coverText, tags[], day, segments[], narration }' },
    }),
    r('POST', '/video/cover', '只出封面，3-5 秒。可以反复试字', {
      sideEffect: 'dry-run',
      body: { big: '封面大字，6-10 字（必填）', sub: '副标题', day: 'Day 号' },
      returns: { url: '/media/cover/xxx.png' },
    }),
    r('POST', '/video/make', '出片（排队，90 秒的片子约 2 分钟）', {
      sideEffect: 'dry-run',
      body: {
        template: 'diary | talk', title: '标题', narration: '旁白文案',
        segments: 'diary 用：段落数组，元素 {text} 或 {card:{title,big,small}}',
        lines: 'talk 用：字符串数组', day: 'Day 号', journalTitle: '日记名',
      },
      returns: { jobId: '拿这个轮询进度' },
    }),
    r('POST', '/pipeline/run', '一条龙：主题 → 文案 → 出片（排队）', {
      sideEffect: 'dry-run',
      body: { topic: '必填', durSec: '秒', day: 'Day 号', template: 'diary | talk' },
      returns: { jobId: '轮询 /jobs/:id/steps' },
    }),
    r('GET', '/jobs/:id/steps', '任务进度。status: running | awaiting-confirm | done | failed'),
    r('GET', '/video/preview/:id', '任务产物：mp4 / 封面 / 关键帧 / 文案'),
    r('GET', '/video/list', '本地成片库：video/out 里所有出过的片子。missing=true 表示任务记录还在但文件被删了'),
    r('GET', '/video/gc', 'video/out 清理预览：空壳目录、散落截图、原始录屏、过期投稿截图，以及能省多少 MB。默认不删'),
    r('POST', '/video/gc', '执行清理。{apply:true} 真删；raw:true 连 page@*.webm 原始录屏一起删；publish:true 清投稿截图', {
      sideEffect: 'write',
      body: { apply: 'true 才真删', raw: '连原始录屏一起删', publish: '清 publish/ 下的投稿截图' },
    }),

    /* ── 抖音读取（全部读本地缓存，不打抖音） ── */
    r('GET', '/douyin/profile', '头像 / 简介 / 背景 / 粉丝数 / 获赞 / 城市。带 cachedAt'),
    r('GET', '/douyin/works?limit=20', '作品列表 + 每条播放/赞/评论/分享/收藏 + 加密 id'),
    r('GET', '/douyin/comments?item=<id>', '某条作品的评论。item 收明文或加密 id'),
    r('GET', '/douyin/live?days=90', '直播场次（观看/峰值/点赞/评论/涨粉）+ 是否在播'),
    r('GET', '/douyin/cache', '缓存现状：哪几份数据、什么时候抓的'),
    r('POST', '/douyin/refresh', '真去抖音抓一遍并落盘。平时不用调，服务启动会自动跑一次', { sideEffect: 'dry-run' }),

    /* ── 抖音写（两段式） ── */
    r('POST', '/douyin/reply', '回复评论。不带 confirm 只回显 payload，带 confirm:true 才真发', {
      sideEffect: 'write',
      body: { itemId: '作品 id（明文或加密）', commentId: '评论 id', text: '回复内容', confirm: 'true 才真发' },
    }),
    r('POST', '/douyin/edit/open', '弹出真实后台编辑页（不代改，update_v2 入参未验证）', {
      sideEffect: 'dry-run',
      body: { itemId: '作品 id，可空' },
    }),

    /* ── 投稿 ── */
    r('POST', '/publish', '投稿。第一段只填表+截图，停在发布按钮前；确认后才真发', {
      sideEffect: 'write',
      body: {
        platform: 'douyin | bili（必填）',
        id: '成片目录名（/video/list 里的 id），或 video: 绝对路径',
        title: '标题', desc: '正文', tags: '标签数组',
        location: '地点全名，如「广东工业大学（大学城校区）」。只有抖音支持，尽力而为、失败不阻塞',
        scheduleAt: '定时发布 "YYYY-MM-DD HH:mm"（抖音，2 小时后 ~ 14 天内）。给了就由抖音到点自己发 —— 想少弹验证码就靠它',
        headed: 'true 才弹窗口。抖音投稿默认走真人浏览器接管（CDP），不需要这个',
      },
      returns: { jobId: '先 /jobs/:id/steps 等到 awaiting-confirm，再 /jobs/:id/confirm' },
    }),
    r('POST', '/jobs/:id/confirm', '确认闸：{confirm:true} 才继续执行写操作', {
      sideEffect: 'write',
      body: { confirm: 'true' },
    }),

    /* ── 登录与日志 ── */
    r('POST', '/login/:platform/start', '起扫码登录（platform: douyin | bili）', { sideEffect: 'dry-run' }),
    r('GET', '/login/:platform/check', '查扫码结果'),
    r('GET', '/logs/:platform', '业务日志（douyin / bili / video / core）'),
  ],

  /* 典型串联，省得 agent 自己拼 */
  recipes: {
    出一条片并看结果: [
      'POST /pipeline/run {topic, durSec, day, template}',
      'GET /jobs/<jobId>/steps  → 等 status=done',
      'GET /video/preview/<jobId> → 拿 mp4 和封面',
    ],
    投稿抖音: [
      'GET /video/list → 选一条 present=true 的 id',
      'POST /publish {platform:"douyin", id, title, desc, tags}',
      'GET /jobs/<jobId>/steps → 等到 status=awaiting-confirm',
      'GET /jobs/<jobId>/steps 里看 screenshots 截图确认表单',
      'POST /jobs/<jobId>/confirm {confirm:true}',
    ],
    回复一条评论: [
      'GET /douyin/works → 拿 plainId',
      'GET /douyin/comments?item=<plainId> → 拿 comment.id',
      'POST /douyin/reply {itemId, commentId, text}  ← 只回显',
      'POST /douyin/reply {itemId, commentId, text, confirm:true}  ← 真发',
    ],
  },
}
