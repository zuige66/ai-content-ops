/* core/offpeak.mjs —— DeepSeek 峰谷时段判断
 * ═══════════════════════════════════════════════════════════════
 * 依据（2026-08-17 起生效的峰谷定价，不再是老的「错峰 5 折」）：
 *   高峰 = 工作日 09:00–12:00、14:00–18:00（北京时间），价格翻倍
 *   平峰 = 其余所有时间 + 周末 + 中国法定节假日，执行原价
 *
 * 🔴 保守原则：节假日表是硬编码的，**认不出来的日子一律按高峰处理**。
 *    宁可少跑一轮（下一轮再回），也不要多花一倍的钱。
 *    官方节假日以国务院每年 11 月前后公布的下一年安排为准，跨年要更新。
 */

/* 2026 年中国法定节假日（含调休上班日）。跨年记得补下一年的。 */
const HOLIDAYS_2026 = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21',
  // 清明
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋 + 国庆
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
])

/* 调休上班日：本来是周末，但要上班 —— 这天照样按「工作日」算峰谷 */
const MAKEUP_WORKDAYS_2026 = new Set([
  '2026-02-14', '2026-02-28',   // 春节调休
  '2026-04-26',                 // 劳动节调休
  '2026-09-19',                 // 中秋调休
  '2026-10-10',                 // 国庆调休
])

/* 2027 年中国法定节假日。
 *
 * 依据：新华社 / 国务院办公厅 2026-11-02 公布的 2027 年放假安排
 *   （光明网、新浪财经、腾讯新闻同日转载）。逐条核对过，不是推算：
 *
 *   元旦   1/1(五) ~ 1/3(日)  3 天，不调休
 *   春节   2/5(五) ~ 2/13(六) 除夕逢周五、顺连周末，连休 9 天
 *   清明   4/3(六) ~ 4/5(一)  3 天，不调休
 *   劳动   4/30(五) ~ 5/4(二) 5 天，调休 1 天
 *   端午   6/9(三)            仅 1 天，不调休（逢周三只放当日）
 *   中秋   9/15(三)           仅 1 天，不调休（同上）
 *   国庆   10/1(五) ~ 10/7(四) 7 天，调休 2 天
 *
 * 我上一版是按惯例预排的，和官方结果有 3 处不一样，已改正：
 *   · 春节原先排到 2/12 就结束 —— 官方连休到 2/13(六)
 *   · 端午 / 中秋原先各排了 3 天 —— 官方逢周三只放 1 天
 *   · 劳动节原先排 5/1~5/5 —— 官方是 4/30 起
 */
const HOLIDAYS_2027 = new Set([
  // 元旦
  '2027-01-01', '2027-01-02', '2027-01-03',
  // 春节（除夕 2/5 周五 → 顺连周末，连休 9 天到 2/13 周六）
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  // 清明
  '2027-04-03', '2027-04-04', '2027-04-05',
  // 劳动节（4/30 周五起，5 天）
  '2027-04-30', '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04',
  // 端午（周三，仅当天）
  '2027-06-09',
  // 中秋（周三，仅当天）
  '2027-09-15',
  // 国庆
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05',
  '2027-10-06', '2027-10-07',
])

/* 调休上班日：本来是周末，但要上班 —— 这天照样按「工作日」算峰谷。
 *
 * 官方公告只说「劳动节调休 1 天、国庆调休 2 天」，没点名具体哪几天；
 * 这里是按「假期块吃掉了哪些周末」倒推的，**官方点名后要核对**：
 *   劳动节 4/30~5/4 吃掉 5/1(六) 5/2(日) → 补 1 天，取 5/8(六)
 *   国庆   10/1~10/7 吃掉 10/2(六) 10/3(日) → 补 2 天，取 9/26(日) + 10/9(六)
 * 算错的后果只是某一天按高峰跑了（多花一倍钱），不会漏跑，风险可控。 */
const MAKEUP_WORKDAYS_2027 = new Set([
  '2027-05-08',                 // 劳动节调休（待官方点名核对）
  '2027-09-26', '2027-10-09',   // 国庆调休（待官方点名核对）
])

/* 按年份索引，认不出的年份自动落进"保守按工作日"分支（见 isWorkday） */
const HOLIDAYS = new Map([[2026, HOLIDAYS_2026], [2027, HOLIDAYS_2027]])
const MAKEUP_WORKDAYS = new Map([[2026, MAKEUP_WORKDAYS_2026], [2027, MAKEUP_WORKDAYS_2027]])

/** 这张表覆盖到哪一年为止 —— /status 和日志里用它提醒补表 */
export const HOLIDAY_TABLE_YEARS = [...HOLIDAYS.keys()].sort()

/** 北京时间的「年月日 + 星期 + 小时分钟」，不看系统时区 */
export function beijingNow(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hour12: false,
  })
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]))
  const day = `${p.year}-${p.month}-${p.day}`
  const wdMap = { 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6, 周日: 7 }
  return {
    day,
    weekday: wdMap[p.weekday] || 0,
    hh: Number(p.hour),
    mm: Number(p.minute),
    text: `${day} ${String(p.hour)}:${String(p.minute)}`,
  }
}

/** 今天是「上班日」吗（周末要排除，调休上班日要算进来） */
export function isWorkday(d = new Date()) {
  const { day, weekday } = beijingNow(d)
  const year = Number(day.slice(0, 4))
  const holidays = HOLIDAYS.get(year)
  const makeup = MAKEUP_WORKDAYS.get(year)
  /* 表里没有这一年 → 认不出节假日，**保守按工作日**（该跑平峰就跑，别白等） */
  if (makeup && makeup.has(day)) return true
  if (holidays && holidays.has(day)) return false
  if (!weekday) return true            // 认不出星期几就当成上班日（保守）
  return weekday <= 5
}

/** 今天是不是**法定节假日**（不含周末）。
 *
 *  scheduler 用它决定「按工作日那张表跑，还是全天每小时一遍」。
 *  ⚠️ 注意别的调用方想要的可能是「今天算不算放假」= isWorkday() 的反面，
 *     那个包含周末；这里只认节假日表，两者语义不同，别混用。 */
export function isHoliday(d = new Date()) {
  const { day } = beijingNow(d)
  const year = Number(day.slice(0, 4))
  const holidays = HOLIDAYS.get(year)
  return Boolean(holidays && holidays.has(day))
}

/** 现在是不是 DeepSeek 的高峰（贵）时段 */
export function isPeak(d = new Date()) {
  if (!isWorkday(d)) return false       // 周末/节假日全天平峰
  const { hh } = beijingNow(d)
  if (hh >= 9 && hh < 12) return true
  if (hh >= 14 && hh < 18) return true
  return false
}

export function isOffPeak(d = new Date()) { return !isPeak(d) }

/** 给人看的一句话说明，日志里用 */
export function describe(d = new Date()) {
  const b = beijingNow(d)
  const year = Number(b.day.slice(0, 4))
  const holidays = HOLIDAYS.get(year)
  const makeup = MAKEUP_WORKDAYS.get(year)
  const wd = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'][b.weekday] || '?'
  const tag = !holidays
    ? '无节假日表·按工作日算'
    : holidays.has(b.day) ? '法定节假日'
      : makeup && makeup.has(b.day) ? '调休上班日'
        : b.weekday >= 6 ? '周末' : '工作日'
  return `${b.text}（${wd}·${tag}）${isPeak(d) ? '高峰时段·贵' : '平峰时段·原价'}`
}
