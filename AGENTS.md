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
- **行尾一律 LF**（2026-11-03 起，规则写在根目录 `.gitattributes`）。
  仓库里原先一半 LF 一半 CRLF，编辑器一保存就整文件重写：`server.mjs` 曾出现
  「2086 行变更、真实改动只有 10 行」的假 diff，`git blame` 直接失效。
  `.bat` / `.cmd` / `.vbs` 是例外，必须留 CRLF（cmd.exe 对换行敏感）。
  🔴 **判断行尾别信 `grep -c $'\r'` 和 `awk '/\r$/'`**：这个 Git Bash 里
  grep 会把空模式匹配到所有行（恒等于总行数）、awk 读取时自动剥掉 CR
  （恒等于 0），两边给的答案都是错的，曾据此误判为「全仓库 CRLF」并转错方向。
  要看真实字节用 `node -e` 读 buffer 数 `\r\n`，或 `od -c`。
- **下划线前缀 = 临时件**：`tools/_*.mjs` 是随手写的试错脚本（硬编码时间戳 ID、
  只跑一次），已写进 `.gitignore`，不进仓库。有留存价值的要升级成正式工具
  —— `tools/pub-cover.mjs` 就是从一堆 `_pubvert*.mjs` 里长出来的 —— 别原样提交。

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

## 发布留档（`release/`，2026-11-03 定）

出片确认发布后，把这一期的**全部信息**收进项目根的 `release/`，和 `video/out/`
（可再生的中间产物）分开。**`release/` 已进 `.gitignore`**，不进仓库。

```
release/
├── daily/    日报周报（大肥鱼日记系列）
│   └── day<数字>-<一句话总结>/
└── github/   项目推荐（GitHub Picks 系列）
    └── day<数字>-github-<项目名>/
```

### 目录名 = 文件名（`day<数字>-<一句话总结>`）

- `day0-广工红烧鱼报到`
- `day1-七天账本`
- `day1-github-dsh-Go` —— 项目类中间多一段 `github-`，后面直接跟项目名

### 发布标题 ≠ 文件名（`DAY<数字>｜<一句话总结>`）

- `DAY1｜播了七天，我赚了五十碗饭`
- `DAY1｜dsh-Go｜安卓手机跑 Ubuntu`

`｜` 是全角竖线，Windows 文件名合法，但**文件名里不用它**（列表里会错位）。

### 每个目录只留 7 样

| 文件 | 说明 |
|---|---|
| `<目录名>.mp4` | 成片 |
| `voice.mp3` | 配音整轨（分段合成的要先拼成一条，见 `tools/tts-join.mjs`） |
| `cover.png` | 16:9，片头 / 通用 |
| `cover-4x3.png` | 抖音「设置横封面」 |
| `cover-3x4.png` | 抖音「设置竖封面」，信息流主位 |
| `voice.md` | 口播全文 + 发布包 + 关键数据 |
| `plan.md` | 策划全文（唯一事实源） |

**中间产物（`.0 .1 .2` 后缀）留在 `video/out/`，不进 `release/`。**
确认发布之后要清理：`release/` 里只允许上面这 7 类，多一个都算没整理完。

### 内容口径

- **项目推荐 ≈ 60s**（不必刚好，30~90s 都算正常）。
  标题 = **项目名 + 超短一句话**，下面才展开细节，语态按大肥鱼来。
  🔴 **不讲项目缺点**（旧版结尾那句「缺点：只有安卓」以后不要了）。
- **日报周报**：更个人化的口吻，可以俏皮、可以乱讲，别写成运营报告。

### 封面统一（`video/templates/cover-paper/`）

日报和项目推荐**共用一套纸墨风封面**，别再各搞一套：

- 左上：`DAY <n>` 实心琥珀徽章；项目视频后面再跟一行 kicker「GITHUB 项目推荐」
- 中间：大标题 + 琥珀短线 + 副标题
- 右下：大肥鱼立绘（硬投影，0 模糊）
- 左下：一行数据小标（要有一个「具体到不可能」的数）

一条命令出三张：`node tools/cover-film.mjs --day 1 --big 七天账本 --sub 五十碗饭 ...`
三张**各自排版、不能互相裁**（抖音横封面是 4:3，竖封面是 3:4，见 `MEMORY.md`）。

> 🔴 模板 `index.html` 的**第一行必须是 `<!doctype html>`**。
> 把注释块写在 doctype 前面，浏览器会把整段 CSS 当正文画到封面上 —— 三张全废。

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
- 🔴 **只回 2026-10-01 之后发布的视频**（`SINCE = '2026-10-01'`，写死在脚本顶部）。
  更早的是老视频，评论都是陈年旧账，不回。
  **每轮都要重新看有没有新视频**，并且**所有符合条件的视频全扫**，不是只看最新一条。
  `createTime` 拿不到的（`work_list` 那边没给）**不能丢** —— 刚发的新视频最容易
  在 work_list 里缺席，一丢就正好复现「最新视频的评论没人回」。按新视频处理，排在前面先扫。
  每轮最多扫 `MAX_VIDEOS = 30` 条作品兜底。
- 🔴 **评论必须翻页读**（2026-11-03）：`/douyin/comments` 默认一页只给 20 条，
  热门视频 `webTotal` 能到 61、页面显示 63，`hasMore` 一直是 true。
  原来只读第一页 → 第二页的评论**从来没被检查过**。
  现在按 zuige 的要求读到 **`MAX_COMMENTS_PER_VIDEO = 300` 条**（或 `hasMore=false`）为止，
  一页 20 条（`COMMENT_PAGE`）。日志会打「评论 N 条」，到上限时提示「剩余下轮」。
  ⚠️ 抖音的 `cursor` 有时原地不动，翻出重复页必须**立刻 break**，否则死循环。
- 每轮**总共最多回 50 条**（`MAX_TOTAL`），不是按视频均分。
  但选谁回是**按视频轮流取**（round-robin），每条视频上限 `MAX_PER_VIDEO = 20` ——
  顺序取满的话一个大爆款就吃掉全部额度，后面的视频一条都轮不到，
  表现就是「新视频没人回」。视频内部**先回最新的**。
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
  ⚠️ **这张图只能走私信发**。评论区的 `multi_publish` 只收文字（`aweme_id`/`text`/
  `reply_to_comment_ids` 三个参数），网页版表情面板只有抖音官方小黄脸、没有自定义表情包分类
  —— 所以「在评论里回一张红烧鱼图」技术上做不到，别再试了。
- **图片评论（isImage）或没有正文的评论：只回一个颜文字**（2026-11-03 定）。
  颜文字是纯文字符号，能过接口也能正常显示，实测 `(๑˃̵ᴗ˂̵)` / `(´・ω・)` /
  `(｡･ω･｡)ﾉ` 都完整保留。
  🔴 **这一类不交给 LLM**，脚本里直接按 `KAOMOJI` 列表轮着取一个：
  ① LLM 看不见图，硬编一句必然变成「这张图好搞笑」这种睁眼说瞎话；
  ② 也省一次调用。
  普通文字评论的回复**俏皮但不强制加颜文字**，规则在 system prompt 第 2 条；
  颜文字**和方括号官方表情 `[看]` 二选一**，最多一个，不许堆。
  🔴 颜文字清单里**不能出现反引号**（`(´･ω･`)` 那版直接截断模板字符串报 SyntaxError），
  要写成 `(´・ω・)`。
- 定时任务：`tools/scheduler.mjs` 常驻进程，**不再是每天 4 个固定点**（2026-11-03 改）。
  · **工作日 17 轮**：`12:15 13:30 18:15`，之后每小时 `:15` 到次日 `08:15`
    （19:15…23:15、00:15…08:15）。
    `08:15~12:15`、`13:30~18:15` 这两段**故意空着**——那是 DeepSeek 高峰（价格翻倍），
    zuige 明确说「不用补」。
  · **节假日 24 轮**：全天每小时 `:15`，由 `core/offpeak.mjs` 的 `isHoliday()` 判。
    ⚠️ 周末我按同一逻辑一起算进去了（DeepSeek 周末全天平峰，没有要避的高峰），
    zuige 原话只说「节假日」。若只想节假日生效，把 `targetsForNow()` 里的
    `isWorkday` 换成 `isHoliday`。
  · `targetsForNow()` **每拍重算**，不能在启动时算死——跨天时工作日表/节假日表会切换。
  **不再用 WorkBuddy 的 automation**（要它开着、每次开一个会话）。开机自启是
  `start-scheduler.vbs`（已放进 Startup 文件夹，里面写死了 node 绝对路径，升级 WorkBuddy 要改）。
  🔴 **agent 没法自己拉起常驻进程**：`wscript.exe`、`Start-Process` 都被安全策略拦
  （LOLBin）。定时器挂了只能人双击那个 vbs，或者重启。
- 临时别回用 `--off`，恢复用 `--on`（写 `state/auto-reply-enabled.json`）。
- 🔴 **模型定死 flash**：`config.json` 的 `llm.model` 显式写了
  `deepseek-official/deepseek-flash`，会覆盖 `llm.from` 指向的
  `D:\Workplace\zhibo\llm.json`（那份是直播项目共用的，那边随时可能被改）。
  每轮日志会打出 `LLM xxxms / N tokens / deepseek-official/deepseek-flash`，怀疑跑错模型就看这一行。

## 🔴 creator 评论接口的 `is_author` 和 `replyCount` 都是坏字段（2026-11-02 / 03 实测）

同一个含义（这条评论已经被我回复过）两种取值：

| 作品 | 已回的评论 `is_author` |
|---|---|
| 最新视频「抖音第一条」 | **false** |
| 老视频「孩子高考成绩出来了」 | **true** |

网页端 `/aweme/v1/web/comment/list/` 里这帮人全是 `is_author:false`（评论者确实不是我），
连我自己发的回复也是 `false` —— 拿它判断「谁回的」必错。

`replyCount` 同样不可信：2026-11-03 实测 5 条评论都已被我回复，其中 4 条
`replyCount` 仍是 **0**，只有 1 条变成 1（而那个 1 是**别人**回的「可以」）。
即「creator 侧的 replyCount 不算我自己的回复」。
所以 `replyCount === 0` **不能**当成「我没回过」。

所以 `tools/auto-reply.mjs` 改成**比昵称**：启动先 `GET /douyin/profile` 拿
`profile.nickname`（当前 `zuige大肥鱼`），然后
`isMine(x) = x.user === MY_NAME`，拿不到昵称才退回 `isAuthor`。
日志里会打「（我是「zuige大肥鱼」）」，一眼能看出判据是否生效。

真正的幂等靠 `state/auto-reply-state.json` 的 `repliedComments`（永久记账），
`replyCount > 0` 只用来决定「值不值得多打一次 `/douyin/replies`」。

排查「某条评论为什么没回」用 `node tools/peek-comments.mjs <plainAwemeId>` ——
只读，直接打 www 域接口，能看到「评论人 → 谁回了什么」的真实关系。


## 抖音聊天页的坑（dm.mjs）

- 入口是 `www.douyin.com/chat`（旧的 `/messages` 已 404）。
- 🔴 **展开「陌生人消息」分组会把列表滑出视口**：`conversationConversationListwrapper`
  带上 `transform: matrix(1,0,0,1,-303,0)` 卡住不回来，所有会话跑到 x≈-303。
  元素"存在"但点不到（click 等到超时），而 `el.click()` 又能"点成功"但 React 不响应。
  处理：`ensureLayout()` 直接把 transform 清成 none，清不掉才 reload。
- 🔴🔴 **`MessageListlist` 的 children 是「新在上、旧在下」**（2026-11-03 血的教训）。
  原来写 `rows.slice(-n)` 取到的是**最旧的 n 条**，调用方再取 `real[real.length-1]`
  当"最新一条"，等于把最旧那条当成最新 —— 判断整个反过来：
  刚回完还认为对方在等回复 → **每轮重发一遍**。实测 00:24~00:33 给同一个人连发 4 条。
  正确写法：`rows.slice(0, n).reverse()`，返回"旧→新"给调用方。
- 🔴 **正文只在 `[class*="contentBox"]` 里**。`child.innerText` 会把时间头粘进正文
  （实测拿到「刚刚 又来问红烧鱼…」「13分钟前 66怎么鱼给我回了」），
  后果是指纹每轮都变、幂等失效、LLM 读到脏原文。
- 🔴 **打开长会话要先滚到底再读**。抖音不保证停在最新位置，视口停在中途时
  `list.children` 只有旧消息。`readThread` 里往上找 6 层、谁溢出滚谁。
- 🔴 **展开陌生人分组会多出一个 `conversationStrangerConversationListtransition` 容器**，
  `position:absolute` 且 rect 和整个会话列表**完全重合**、`pointer-events:auto`，
  把 mouse.click 全吃掉。表现是「坐标算对了、elementFromPoint 也命中了、但点了没反应」，
  `locator.click()` 直接 actionability 超时。解法：把它 `pointer-events` 设 `none`。
  React 重渲染会冲掉内联样式，所以每次 `ensureLayout()` 都补一刀。
- 🔴 **会话多起来（展开后 11 个）后，第 8 位往后会掉出视口**，算出的坐标点不到。
  `findBox` 里先 `scrollIntoView({block:'center'})` 再取坐标。
- 🔴 **必须用 `page.mouse.click()`，不能用 `el.click()`**。后者只让标题变，右侧消息区不加载。
- 🔴 **点完要核对 `curConversation` 的名字**。这个页面偶尔右键头切了、消息区还停在上一个人，
  继续读会把别人的话当新消息（甚至回错人）。`openSession` 里最多试 3 次，对不上就抛错。
  单个会话点不开**不许拖垮整轮** —— `auto-reply.mjs` 里是 try/catch 跳过。
- 🔴 **系统提示不算「对方说话」**（`isSystemText`）。时间分隔条有两种形态，都要排掉。
  「已确认聊天，对方可继续发送消息」这类**状态播报也要滤掉** —— 漏了会让
  `lastIsOther` 判成 true，去回一条空气。
- 🔴 **发送成功不能只看"输入框是否清空"**：
  ① 空输入框的 `innerText` 是一个零宽空格 `\u200b`，`.trim()` 剥不掉；
  ② 选 `[contenteditable="true"]` 会先匹配到别的编辑框，要用 `.messageEditorinputArea`；
  ③ 抖音渲染异步，**发完 10 秒内消息列表都可能不刷新** —— 得重开一次会话再确认，
  否则每条都误报失败（日志看着像环境坏了）。现在 `sendText` 就是"轮询 + 重开会话"。
- 🔴 **私信发图别点附件按钮**（弹 Windows 文件对话框，Playwright 卡死），
  直接 `setInputFiles` 到隐藏的 `input[type=file]`，再点「发送（n）」确认条。
- 排查工具：`node tools/peek-dm.mjs [昵称]` —— 列会话 / 展开某个会话的真实对话，
  只读。私信出问题先跑它，别靠猜。

