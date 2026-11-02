/* tools/make-pick.mjs —— 按脚本 JSON 直接出一支片
 * ═══════════════════════════════════════════════════════════════
 * 走 server 的 /video/make 要排队、轮询、还得等控制台刷新；
 * 调模板调一版要重出七八次的时候，那个流程太重。
 * 这里直接调 makeVideo，日志打在终端上，出完就结束。
 *
 * 用法：
 *   node tools/probe/make-pick.mjs video/scripts/_script_dsh-go.json
 *   node tools/probe/make-pick.mjs video/scripts/_script_dsh-go.json --template review
 * ═══════════════════════════════════════════════════════════════ */
import fs from 'node:fs'
import path from 'node:path'
import { makeVideo } from '../../video/make.mjs'
import { ROOT } from '../../core/log.mjs'

const args = process.argv.slice(2)
const file = args.find(a => a.endsWith('.json'))
const get = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }
if (!file) {
  console.error('用法：node tools/probe/make-pick.mjs video/scripts/_script_xxx.json')
  process.exit(1)
}

const s = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
/* 图片路径按项目根解析：脚本里写的是相对根目录的路径，
 * 换成绝对路径再交给 make.mjs，免得它按 cwd 解析出错。 */
const shots = (s.shots || []).map(x => ({
  ...x,
  img: x.img ? path.resolve(ROOT, x.img) : '',
}))

const t0 = Date.now()
const res = await makeVideo({
  id: 'pick-' + Date.now(),
  kind: 'video',
  params: {
    template: get('template') || 'review',
    title: s.title,
    episode: s.episode,
    series: s.series,
    repo: s.repo,
    /* 🔴 coverText 是封面 intro 的唯一来源（格式「第一行|第二行」）。
     * 漏传的话 make.mjs 拿不到 big，cover 就是 null，模板会安静地跳过
     * 整个封面场景 —— 成片看起来"正常"，只是没有片头。 */
    coverText: s.coverText,
    shots,
  },
}, {
  step: (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`),
})

console.log('\n成片：' + res.mp4)
console.log(`时长 ${res.dur.toFixed(1)}s　关键帧 ${res.keyframes.length} 张`)
console.log('配音原文：' + res.narration)
