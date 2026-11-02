/* core/naming.mjs —— 产物目录与截图的命名规则（唯一事实源）
 * ═══════════════════════════════════════════════════════════════
 * 为什么要单独一个模块：以前产物目录叫 `j1793621565753`、`pick-1793614810011`
 * 这种纯时间戳，人看一眼完全不知道是什么，抖音和 B 站的产物还混在同一个
 * `video/out/publish/` 下面。这里把「目录怎么起名、截图怎么起名」收敛到一处，
 * 改规则只改这个文件。
 *
 * 两条设计原则：
 *   1. **目录名先讲清"是哪一期、什么标题"，时间戳只用来排序去重。**
 *      人能一眼认出「这是 dsh-Go 那期、B站的、7 月 2 日投的」。
 *   2. **平台分开。** 抖音和 B 站的投稿产物各自一个根目录，不混。
 *
 * 目录形态（都是中文可读）：
 *   video/out/<成片>/
 *     2026-11-02_dsh-Go_第01期_横屏29s/
 *
 *   video/out/publish/douyin/
 *     2026-11-02_dsh-Go_抖音_预演/          ← dry-run 阶段的截图
 *   video/out/publish/bili/
 *     2026-11-02_dsh-Go_B站_预演/
 *
 * 截图形态（按流程编号，名字说明这一步在看什么）：
 *   01-打开投稿页.png
 *   02-已上传.png
 *   03-表单填好-预演.png
 *   03b-封面已设.png
 *   03c-位置已标.png
 *   03d-定时已设.png
 *   03e-AI声明已选.png
 *   03f-分区已选.png
 *   04-点发布前.png
 *   05-已发布.png
 *   99-失败-未登录.png
 * ═══════════════════════════════════════════════════════════════ */

/* Windows 文件名禁用字符 + 控制字符 */
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g
/* 保留设备名，Windows 上不能当文件名 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** 把任意标题清成安全的文件名片段 */
export function safeName(s, { max = 40 } = {}) {
  let t = String(s || '')
    .replace(BAD_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    /* 句尾标点去掉，目录名带句号很怪 */
    .replace(/[。！？，、；：]+$/g, '')
    .trim()
  if (RESERVED.test(t)) t = '_' + t
  /* 按字符切，别把中文切成半个 */
  if (t.length > max) t = t.slice(0, max).trim()
  return t || '未命名'
}

/** 日期：本地时区的 YYYY-MM-DD（不要 UTC，跨零点会差一天） */
export function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 时间：HHMM，给同一天同一标题的重复产物做区分 */
export function timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * 成片目录名。
 * 例：`2026-11-02_dsh-Go_第01期_横屏29s`
 *
 * @param {{title?:string, typeName?:string, width?:number, height?:number,
 *          dur?:number, episode?:number, when?:Date}} o
 */
export function filmDirName({ title, typeName = '', width = 0, height = 0, dur = 0, episode = 0, when = new Date() } = {}) {
  const bits = [dateStamp(when), safeName(title, { max: 32 })]
  if (episode) bits.push(`第${String(episode).padStart(2, '0')}期`)
  if (width && height) bits.push(width >= height ? '横屏' : '竖屏')
  if (dur) bits.push(`${Math.round(dur)}s`)
  return bits.filter(Boolean).join('_')
}

/**
 * 投稿产物目录名。
 * 例：`2026-11-02_dsh-Go_抖音_预演` / `2026-11-02_dsh-Go_B站_已发`
 *
 * @param {{platform:string, title?:string, stage?:string, when?:Date}} o
 */
export function publishDirName({ platform, title, stage = '预演', when = new Date() } = {}) {
  const pName = platform === 'bili' ? 'B站' : platform === 'douyin' ? '抖音' : String(platform || '未知')
  return [dateStamp(when), safeName(title, { max: 32 }), pName, safeName(stage, { max: 8 })].join('_')
}

/**
 * 目录名唯一化：同名就加 `_2`、`_3`。
 * 用 mkdir 的排他语义判断"占没占"，不要先 exists 再 mkdir（中间有竞态）。
 *
 * @param {string} baseDir 父目录
 * @param {string} name    想要的目录名
 * @param {(p:string)=>void} [mkdir] 建目录的函数，默认 fs.mkdirSync
 * @returns {string} 最终用的完整路径
 */
export function uniqueDir(baseDir, name, mkdir) {
  const fs = mkdir ? null : null // 保持签名简单，交给调用方传
  let i = 1
  let candidate = name
  while (true) {
    const full = `${baseDir}/${candidate}`
    try {
      if (mkdir) { mkdir(full); return full }
      /* 默认行为在 core 里不引 fs，避免这个模块被前端 import 时炸掉；
       * 后端调用方都会传 mkdir。 */
      throw new Error('uniqueDir 需要调用方传入 mkdir')
    } catch (e) {
      if (e && (e.code === 'EEXIST' || /已存在|EEXIST/.test(String(e.message)))) {
        i += 1
        candidate = `${name}_${i}`
        continue
      }
      throw e
    }
  }
}

/* ── 投稿截图命名 ─────────────────────────────────────────────
 * 统一在这里列出来，避免每个平台各起一套（以前抖音叫 03d-schedule.png、
 * B站叫 03f-category.png，同一个概念两个名字）。 */
export const SHOTS = {
  open: '01-打开投稿页.png',
  uploaded: '02-已上传.png',
  dryRun: '03-表单填好-预演.png',
  cover: '03b-封面已设.png',
  location: '03c-位置已标.png',
  schedule: '03d-定时已设.png',
  aiDeclare: '03e-AI声明已选.png',
  category: '03f-分区已选.png',
  beforePublish: '04-点发布前.png',
  published: '05-已发布.png',
  // 失败留痕
  failNotLoggedIn: '99-失败-未登录.png',
  failNotReady: '99-失败-页面没就绪.png',
  failUpload: '99-失败-上传没启动.png',
  failCover: '99-失败-封面没设上.png',
  failLocation: '99-失败-位置没标上.png',
  failSchedule: '99-失败-定时没设上.png',
  failCategory: '99-失败-分区没选上.png',
  failAi: '99-失败-AI声明没选上.png',
  failSms: '99-失败-要短信验证码.png',
  failSmsTimeout: '99-失败-验证码超时.png',
}

/** 从 SHOTS 取名字，取不到就用兜底名 */
export function shotName(key, fallback) {
  return SHOTS[key] || fallback || `${key}.png`
}
