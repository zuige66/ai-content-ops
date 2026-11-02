# AGENTS.md

给接手的 AI / 协作者看的约定。改代码前先读这一页。

## 设计原则

**Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.**

这条对视频模板尤其重要。屏幕上的每一个字都要挣得它的位置：

- 能用版面关系表达的，不要加说明文字。标注线指过去比写「下图是……」有用。
- 副标题只回答「这是什么」，不重复主标题已经说过的话。
- 图注、单位、编号、来源这类**信息性**小字可以留；「点击查看」「更多内容」这类**指路性**文字一律删掉。
- 一个画面里不要同时出现两种以上的强调色。

## 目录（根目录只放入口，别的都有归处）

```
zhibo-auto/
├── server.mjs            唯一入口：控制台 + HTTP API
├── config.json           本机配置（不进 git）／config.example.json 模板
├── AGENTS.md  README.md
├── core/                 基础设施：browser / jobs / shell / llm / log
├── douyin/  bili/        平台适配，一平台一目录，互不 import
├── video/
│   ├── series/           ★ 系列设定（一次定死）
│   ├── plans/            ★ 单期策划 md + _TEMPLATE.md
│   ├── scripts/          ★ _script_*.json（从策划派生）
│   ├── templates/<类型>/  自包含模板页，一类一个目录
│   ├── out/              成片与中间产物（不进 git）
│   └── *.mjs             出片链路：make / cover / preview / pipeline / types
├── web/                  控制台前端（无打包，原生 ES module）
├── tools/                常驻工具（自动回复、定时器、素材、抠图）
│   └── probe/            一次性探测脚本（页面改版后重跑用，别当常驻工具）
├── .workbuddy-ai/        skill 池 + 工作日志（不进 git）
│   ├── skills/           github-picks（原生）＋ video-shotcraft（外部引入）
│   └── memory/           按天的排查与决策日志
├── state/ logs/ .run/    运行时产物（不进 git）；.run/trash/ 是当天挪走的杂物
└── sessions/             浏览器登录态（不进 git，含 cookie）
```

三条规矩：

- **新东西先找家**：能归到上面某一格的，不许再往根目录扔。
- **一个文件只有一个身份**：是设定就进 `series/`，是策划就进 `plans/`，
  是机器读的就进 `scripts/`。同一份内容不许有两个副本。
- **`out/` 里的一切都可再生**。删了不心疼，所以不许有任何手工修改过的成片。

- **调试留痕有固定去处**：一次性探测脚本进 `tools/probe/`（挪位要同步把
  `from '../core/...'` 改成 `../../`），临时文件和废弃截图进 `.run/trash/`。
  🔴 **`state/` 下的 png 不许按类型归堆**：`qr-douyin.png`、`edit-open.png`、
  `verify-creator.png` 都是代码里写死的活路径，挪一次登录/编辑就挂。
  真要按类型拆，先把路径收敛到 `core/paths.mjs`，再动文件。
- **`state/` 的边界**：只有**代码会读写**的文件留在 `state/` 根下
  （`jobs.json`、`breaker-*.json`、`auto-reply-state.json`、`loc-*.json`、
  `probe-*.json` 这些是活路径）。纯历史截图、废弃的 probe 落盘进
  `state/debug/` —— 那里没有任何代码引用，删了不心疼。

## 视频策划（这是闸，不是建议）

**没有策划 md，不许生成视频。**

- 系列设定在 `video/series/<系列>.md`，一次性定死，每期不再重新讨论。
- 单期策划在 `video/plans/<系列>-<期号>-<slug>.md`，从 `_TEMPLATE.md` 复制，八块填满。
- 策划 `status` 不是 `approved` 之前，**不许跑 TTS、不许录屏、不许出片**。
  写完就停下等人点头，别顺手往下做。
- `_script_*.json` 从策划**派生**，口播文本原样搬运，不改写。
  单一事实源是 md，JSON 只是产物——两边不一致时以 md 为准，回去改 JSON。
- 流程细节见 skill：`.workbuddy-ai/skills/github-picks/SKILL.md`。

## 视频

- 设计规范（配色 token、构图、内容策略）在 `video/DESIGN.md`，模板不许自创样式。
- 视频类型登记在 `video/types.mjs`（`diary` 日记体 / `talk` 鱼说 / `review` 项目展示）。
  加类型只改这一处，别把画幅和字数上限散落到各处。
- **横屏 1920×1080 是默认画幅。** `diary` 的竖屏是历史遗留，新做的模板和封面
  一律横屏，不许再出竖屏——竖屏录一遍等于白跑 TTS 和录屏。
- 出片链路：`video/make.mjs` —— TTS → Playwright 录模板页 → ffmpeg 合成。
- 模板在 `video/templates/<名字>/`，每个模板一个自包含的 `index.html`，
  动画结束后设 `window.__DONE__ = true`，录屏脚本靠它判断收工。
- 录屏只认**确定的时间轴**：不要依赖真实网络、随机数要固定种子，
  否则同一份代码两次录出来不一样，没法比对。

## 投稿

- 抖音走**真人浏览器接管**（CDP），不是 Playwright 自带实例 —— 后者必弹短信验证码。
  开关：`config.chrome.liveMode`。体检：`GET /browser/live`。
- 投稿是两段式：先 dry-run 填表截图，人确认后才点发布。别绕过这个闸。
- 想少被打扰就用 `scheduleAt` 定时发布，一次上传管一天。

## 红线

- 不动已发布的作品。
- 不把密钥写进仓库。
- 改抖音页面选择器前先 `GET /browser/probe?find=<文字>` 探一下，别凭猜。
- **回复评论只认数字 comment id**（`7703250197081523002` 这种）。creator 评论列表给的是
  加密串（`@ivRu…==`），拿去发回复一律「参数不合法」；数字 id 要从 www 域评论接口拿。
  接口和坑见 README「回复评论」那节，别把旧参数抄回去。

## 自动回复

- `tools/auto-reply.mjs` 是唯一的自动回复入口，评论 + 私信一起处理。
- **只在 DeepSeek 平峰时段跑**（工作日 9-12 / 14-18 之外 + 周末 + 法定节假日）。
  判断在 `core/offpeak.mjs`；节假日表硬编码、认不出的日子按高峰算（宁少跑不多花钱）。
  2026-08-17 起没有"错峰 5 折"了，是峰谷定价 —— 高峰期价格直接翻倍。
- 脚本**不许自己 launchPersistent**：server 占着 `sessions/douyin`，再起一个必报
  `Target page, context or browser has been closed`。评论全走 HTTP 接口。
- **私信里只有真人说的话算数**。时间条和系统提示（"只能发送一条文字消息"
  "暂不支持该消息类型"）都不算 —— 不过滤会给没开口的陌生人发消息，
  而私信对陌生人**只能发一条**，发错补不回来。
- 消息左右归属用 `isFromMe` 类名判断，别按坐标猜（满宽卡片会把坐标法带偏）。
- **私信发图不要点附件按钮**：会弹 Windows 系统文件对话框，Playwright 卡死、
  截图超时。直接 `setInputFiles` 到隐藏的 `input[type=file]`，再点「发送（n）」确认条。
- 表情包素材放 `assets/stickers/`，当前 `sticker-01-hongshaoyu.png`（大肥鱼笑脸，408×409）。
- 定时任务：`tools/scheduler.mjs` 常驻进程，每天 08:00 / 13:00 / 19:00 / 23:00 各跑一轮。
  **不再用 WorkBuddy 的 automation**（要它开着、每次开一个会话）。开机自启是
  `start-scheduler.vbs`（已放进 Startup 文件夹，里面写死了 node 绝对路径，升级 WorkBuddy 要改）。
- 临时别回用 `--off`，恢复用 `--on`（写 `state/auto-reply-enabled.json`）。

## 抖音聊天页的坑（dm.mjs）

- 入口是 `www.douyin.com/chat`（旧的 `/messages` 已 404）。
- 🔴 **展开「陌生人消息」分组会把列表滑出视口**：`conversationConversationListwrapper`
  带上 `transform: matrix(1,0,0,1,-303,0)` 卡住不回来，所有会话跑到 x≈-303。
  元素"存在"但点不到（click 等到超时），而 `el.click()` 又能"点成功"但 React 不响应。
  处理：`ensureLayout()` 直接把 transform 清成 none，清不掉才 reload。
- 🔴 **必须用 `page.mouse.click()`，不能用 `el.click()`**。后者只让标题变，右侧消息区不加载。
- 🔴 **点完要核对 `curConversation` 的名字**。这个页面偶尔右键头切了、消息区还停在上一个人，
  继续读会把别人的话当新消息（甚至回错人）。`openSession` 里最多试 3 次，对不上就抛错。
- 🔴 **系统提示不算「对方说话」**（`isSystemText`）。时间分隔条有两种形态，都要排掉。
- 🔴 **私信发图别点附件按钮**（弹 Windows 文件对话框，Playwright 卡死），
  直接 `setInputFiles` 到隐藏的 `input[type=file]`，再点「发送（n）」确认条。
