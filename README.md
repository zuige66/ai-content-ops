# 大肥鱼 · 自媒体自动化控制台

> 在本地跑一个网页控制台，把「一句话主题」变成带配音、带皮套的成片，
> 再发到抖音和 B 站。**所有对外操作都停在你点确认之前。**

不依赖任何云服务，不买 GPU，不用剪辑软件。一条 90 秒视频的边际成本约等于一次
LLM 调用的 token（约 1100），录制、配音、合成全在本机跑。

---

## 目录

1. [它是什么 / 不是什么](#1-它是什么--不是什么)
2. [准备环境](#2-准备环境)
3. [跑起来](#3-跑起来)
4. [界面导览](#4-界面导览)
5. [做第一条视频](#5-做第一条视频)
6. [发到抖音](#6-发到抖音)
7. [管你的抖音账号](#7-管你的抖音账号)
8. [让 AI 来操作](#8-让-ai-来操作)
9. [磁盘会越来越胖](#9-磁盘会越来越胖)
10. [常见问题](#10-常见问题)
11. [红线](#11-红线)
12. [目录结构](#12-目录结构)

---

## 1. 它是什么 / 不是什么

**能做的**

| 能力 | 说明 |
|---|---|
| 出视频 | 给一个主题 → LLM 写文案 → edge-tts 配音 → 网页动画录屏 → ffmpeg 合成 mp4 + 封面 + 关键帧 |
| 两种版式 | `diary` 竖屏日记体（1080×1920）、`talk` 横屏鱼说（1920×1080） |
| 投稿 | 抖音 / B 站，**两段式**：先填表截图，你确认后才真点发布 |
| 管抖音号 | 账号资料、作品数据、评论区、直播数据；回复评论；一键弹出后台编辑页 |
| 给 AI 用 | 所有能力都有 HTTP 接口，`GET /agent` 自描述，AI 能自己发现和调用 |

**不做的**

- 不碰群控、不做协议刷量、不批量养号
- 不改账号资料（头像/简介/背景）：抖音 web 端**没有**这类接口，只有 App 能改
- 不代改已发布作品：`update_v2` 的入参没验证过，猜字段可能把封面/可见性洗掉，所以只帮你打开后台页面

---

## 2. 准备环境

### 必须有的

| 项 | 要求 | 怎么确认 |
|---|---|---|
| **Node.js** | ≥ 22 | `node -v` |
| **Chrome** | 装了就行（没装会自动降级 Edge） | 打开 Chrome 看一眼 |
| **Python** | 3.9+，且装了 `edge-tts` | `pip install edge-tts` |
| **一个 LLM** | OpenAI 兼容接口，有 `baseUrl` + `apiKey` + `model` | 见下面「配置 LLM」 |

ffmpeg **不用装**：`npm install` 会带上 `ffmpeg-static`，自带二进制。
启动后打 `http://127.0.0.1:18090/doctor` 能看到版本号。

### 配置 TTS（配音）

配音走 [edge-tts](https://github.com/rany2/edge-tts)，微软的免费接口，不需要 key。
你需要一个脚本，约定是这样的：

```bash
python <你的脚本> --text "<要念的文本>" --voice zh-CN-XiaoyiNeural \
  --rate=-8% --out <输出.mp3> --timing-out <时间戳.json>
```

结束时往 **stdout 打一行 JSON**：

```json
{"ok": true, "file": "xxx.mp3", "dur": 84.6, "marks": [{"text":"抖音第一条","offset":0,"duration":2.3}]}
```

`marks` 是逐句时间戳，用来对齐气泡出场。没有也能跑（只是动画不跟着念的节奏走）。

<details>
<summary>懒得自己写？最小可用的 tts.py（30 行）</summary>

```python
import argparse, asyncio, json, os
import edge_tts

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--voice", default="zh-CN-XiaoyiNeural")
    ap.add_argument("--rate", default="-8%")
    ap.add_argument("--out", required=True)
    ap.add_argument("--timing-out", default="")
    a = ap.parse_args()

    marks, comm = [], edge_tts.Communicate(a.text, a.voice, rate=a.rate)
    with open(a.out, "wb") as f:
        async for ch in comm.stream():
            if ch["type"] == "audio":
                f.write(ch["data"])
            elif ch["type"] == "WordBoundary":
                marks.append({
                    "text": ch["text"],
                    "offset": ch["offset"] / 1e7,
                    "duration": ch["duration"] / 1e7,
                })

    # 时长按 48kbps 定码率估算，误差 < 1%，够定字幕停留
    dur = os.path.getsize(a.out) * 8 / 48000
    if a.timing_out:
        with open(a.timing_out, "w", encoding="utf-8") as f:
            json.dump({"marks": marks}, f, ensure_ascii=False)

    print(json.dumps({"ok": True, "file": a.out, "dur": dur, "marks": marks}, ensure_ascii=False))

asyncio.run(main())
```

</details>

### 配置 LLM（写文案）

key 不写进仓库。建一个 `llm.json` 放在任何地方：

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "model": "gpt-4o-mini"
}
```

然后在 `config.json` 里让 `llm.from` 指向它。
任何 OpenAI 兼容的服务都行（DeepSeek、通义、Kimi、本地 Ollama…）。

---

## 3. 跑起来

```bash
git clone https://github.com/zuige66/ai-content-ops.git
cd ai-content-ops
npm install
npm start
```

第一次 `npm start` 会自动把 `config.example.json` 复制成 `config.json`，
但里面全是 `<占位符>` —— **打开改掉这几项**，否则出片会失败：

```jsonc
{
  "tts": {
    "python": "D:/xxx/.venv/Scripts/python.exe",   // ← 你的 python
    "script": "D:/xxx/tools/tts.py"                // ← 上面那个 TTS 脚本
  },
  "llm": { "from": "D:/xxx/llm.json" },            // ← 你的 llm.json
  "video": { "petImage": "D:/xxx/pet.png" }        // ← 皮套立绘，没有就留空
}
```

改完重启，浏览器打开 **http://127.0.0.1:18090**。

Windows 用户也可以直接**双击 `start-backend.bat`**：它会自己找 node、自己开浏览器；
端口被占时不会报错吓人，而是直接打开已经在跑的那个控制台。

想换端口：`set AUTO_PORT=18100` 再启动，或改 `config.json` 的 `port`。

---

## 4. 界面导览

左侧五个页面，按干活顺序排的：

| 页面 | 干什么 |
|---|---|
| **平台登录** | 抖音 / B 站扫码。二维码直接显示在页面上，手机扫 |
| **视频工坊** | 选题 → 审文案 → 出片。还有「本地成片」库，所有出过的片子都在这儿 |
| **抖音账号** | 账号资料、作品表、评论区、直播数据。回复评论、打开编辑页 |
| **任务中心** | 所有排队/在跑/等确认/失败的任务。**发布确认按钮在这里** |
| **运行日志** | 按平台分开的日志（抖音 / B站 / 视频 / 服务进程） |

顶部那排标签页跟浏览器一样：开过的页面会留着，可以关，`sessionStorage` 记住。

---

## 5. 做第一条视频

### 最快的路：一条龙

1. 进「视频工坊」
2. 选版式：`日记体`（竖屏，日更叙事）或 `鱼说`（横屏，观点输出）
3. 主题写一句话，比如「第一次被评论区骂了，说我是假的 AI」
4. 时长拖到 90 秒，Day 填当天日期
5. 点 **「一条龙出片」**

然后去泡杯茶。约 2 分钟，进度条会实时走五个阶段：

```
文案 → 配音 → 录制 → 合成 → 封面
```

> 这五个阶段的名字不是编的，是从后端 `step()` 的真实日志里匹配出来的。

### 想自己把关：分两步

**先只写文案**（点「写文案」，4 秒）：

- 文案、标题、日记名、封面大字、标签全部填进表单，**可以随便改**
- 改文案不花渲染时间，改十版也不心疼

**再出片**（点「出片」，约 2 分钟）：

- 配音时长决定画面时长，不是固定 90 秒
- 产物在 `video/out/<jobId>/`：`video.mp4` + `cover.png` + 4 张关键帧

### 出过的片子去哪了

「视频工坊」最下面有 **本地成片**，列出 `video/out` 里所有出过的片子。
每条带封面、大小、时间、关键帧数，点「▶ 播放」直接看。

> 以前这块只显示"当前这一个任务"，关掉页面就再也找不回来 —— 现在不会了。

如果某条显示灰色 **「文件已删」**：说明任务记录还在、但 mp4 被删了。
点「重新扫」刷新列表，或者用脚本重出（见下面「重出旧片」）。

---

## 6. 发到抖音

### 前置：先登录

「平台登录」→ 抖音 → 扫码。

> 走的是 **creator.douyin.com**（创作者平台），不是 `login.douyin.com`。
> 后者是头条联合登录页，默认停在「手机登录」，那个「扫码登录」标签页
> 用脚本点不动 —— 页面自己拦了，别跟它较劲。而且投稿本来就要创作者平台的登录态。

### 投稿是两段式

```bash
# 第一段：上传 + 填表 + 截图，停在「发布」按钮前
curl -X POST http://127.0.0.1:18090/publish \
  -H "content-type: application/json" \
  -d '{"platform":"douyin","id":"<成片目录名>","title":"标题","desc":"正文","tags":["标签1"]}'
```

`id` 从 `GET /video/list` 里拿（就是成片目录名，比如 `j1793519566884`）。

也可以直接给绝对路径：`"video": "D:/.../video.mp4"`。

然后轮询进度：

```bash
curl http://127.0.0.1:18090/jobs/<jobId>/steps
```

状态会从 `running` 走到 **`awaiting-confirm`**。这时去 `video/out/publish/<jobId>/`
看三张截图：

| 文件 | 看什么 |
|---|---|
| `01-open.png` | 上传页打开了吗、登录态还在吗 |
| `02-uploaded.png` | 视频真传上去了吗（右侧应该有预览和时长） |
| `03-dry-run.png` | 文案填对了吗、话题有没有重复 |

**确认没问题，才点第二段**：

```bash
curl -X POST http://127.0.0.1:18090/jobs/<jobId>/confirm \
  -H "content-type: application/json" -d '{"confirm":true}'
```

控制台的「任务中心」里也有对应按钮，不用敲命令。

> 🔴 **从 dry-run 到点确认之间别重启服务**。浏览器页面存在内存里，重启就丢了，
> 那个任务会永远卡在 `awaiting-confirm`。要撤销用 `{"confirm":false}`。

---

## 7. 管你的抖音账号

进「抖音账号」页。第一眼看到的是账号卡：背景图、头像、简介、粉丝/获赞/播放/评论。

右上角 **「刷新」** 是唯一会真去抖音抓数据的按钮。平时页面上显示的
都是本地缓存（`state/cache/douyin/`），副标题会写「数据抓取于 3 小时前」，
所以你知道数据新不新。服务重启时也会自动抓一次。

### 看数据

| 区块 | 内容 |
|---|---|
| 作品表 | 6 列：封面、标题、发布日期、播放、赞、评论。点一行看这条的评论 |
| 评论区 | 正文、点赞数、回复数、时间、是不是作者自己、评论者头像和昵称 |
| 直播表 | 近 90 天每场：开始时间、时长、观看、峰值、点赞、评论、涨粉 |

> 有些作品播放数是 `0`，不是抓错了 —— 抖音对图文类作品本来就不给播放数。

### 回复评论

点评论下面的「回复」→ 打字 → 点「发送」。

**第一次不会发出去**，只把要发的原样摆给你看：

```
aweme_id:            7703140636089699634
reply_to_comment_ids: 7703250197081523002
text:                广工的水养出来的嘛
```

再点「确认发送」才真发。

> 🔴 **2026-11-02 接口换过一次，旧参数全废。**
> 以前记的 `POST /aweme/v1/creator/comment/reply/` + form `{comment_Id, item_id, text}`
> 现在一律回「参数不合法」。真接口是：
>
> ```
> POST creator.douyin.com/aweme/janus/creator/comment/aweme/v1/web/comment/multi_publish/
> query: aweme_id=<明文数字>&text=<文本>&reply_to_comment_ids=<数字>&channel_id=618&aid=2906&device_platform=webapp
> body : {"aweme_id":"…","text":"…","reply_to_comment_ids":"…","channel_id":618}
> ```
>
> 三个坑：
> 1. `reply_to_comment_ids` 要**数字 id**（`7703250197081523002`），不是 creator 列表里的加密串（`@ivRu…==`）。数字 id 只能从 www 域 `/aweme/v1/web/comment/list/` 拿，且**必须在作品页里发请求** —— 在 www 首页发会得到 200 + HTML 风控页。
> 2. 参数 query 和 JSON body 各放一份，缺一边可能被判参数不合法。
> 3. 表情面板只有 188 个抖音官方 emoji（`kan` / `fanu` / `weixiao`…），**没有自定义表情包，也没有图片上传**。`multi_publish` 名字里带 multi，但图片评论（`image_list`）目前只有手机 APP 能发。

### 发表情包：评论做不到，私信可以

两条路能力完全不同，别混为一谈：

| 场景 | 文字 | 官方 emoji | 自定义表情包 / 图片 |
|---|---|---|---|
| **视频评论回复** | ✅ | ✅ 188 个 | ❌ 接口只收 text |
| **私信** | ✅ | ✅ | ✅ jpg/png/gif/mp4 |

评论这边，别人发来的是**图片评论**（`image_list`，creator 侧正文为空），
回复接口只收文字，表情面板只有官方 emoji —— 想要表情包对轰只能手机 APP 手动发。

**所以自动回复对图片评论的处理方式是「用可爱颜文字回敬」**（2026-11-02 定）：
颜文字是纯文字符号，能过接口、抖音也完整显示。实测这几条都没掉字：

```
你也发图呀 (๑˃̵ᴗ˂̵)
回你一个表情包 (´・ω・)
收到你的图啦 (｡･ω･｡)ﾉ
```

规则在 `tools/auto-reply.mjs` 的 system prompt 第 2、5 条：句末带**一个**颜文字，
和方括号官方表情 `[看]` **二选一**，且不许假装看见了图里的内容。
⚠️ 颜文字清单里不能有反引号 —— `(´･ω･`)` 会把模板字符串截断，写成 `(´・ω・)`。

私信那边能发图：输入区背后有个 `input[type=file] accept=".jpg,.jpeg,.png,.gif,.mp4"`，
把文件塞进去会弹出「发送给 XX / 文件名 / 大小 / 取消 / 发送（1）」的确认条，
点「发送」就出去了。`douyin/dm.mjs` 的 `sendImage()` 就是这么做的 ——
**不要点附件按钮**，那会弹出 Windows 系统文件对话框，Playwright 卡在那儿，
连截图都会超时。

### 自动回复（平峰时段跑）

`tools/auto-reply.mjs` 把评论和私信一起处理，只在 DeepSeek 平峰时段真干活。

```bash
node tools/auto-reply.mjs            # 按当前时段判断，平峰才跑
node tools/auto-reply.mjs --dry      # 只生成草案，一条都不发
node tools/auto-reply.mjs --yes      # 真发
node tools/auto-reply.mjs --no-dm    # 这轮不回私信
node tools/auto-reply.mjs --force    # 忽略时段（调试用，高峰会花双倍钱）
node tools/auto-reply.mjs --off      # 总开关关掉
node tools/auto-reply.mjs --on       # 总开关打开
```

> 🔴 **2026-08-17 起 DeepSeek 不再有"错峰 5 折"，改成了峰谷定价。**
> 工作日 09:00–12:00、14:00–18:00（北京时间）价格**翻倍**，其余时间、周末、
> 法定节假日执行原价。判断逻辑在 `core/offpeak.mjs`，节假日表硬编码，
> **认不出来的日子一律按高峰处理**（宁可少跑一轮，不多花钱）。跨年要补下一年的表。

> 🔴 **模型定死 flash。** `config.json` 的 `llm.model` 显式写了
> `deepseek-official/deepseek-flash`，它会覆盖 `llm.from` 指向的
> `D:\Workplace\zhibo\llm.json` —— 那份是直播项目共用的，那边改了什么这边都会跟着变，
> 所以在本地钉死。每轮日志会打 `LLM 944ms / 2658 tokens / deepseek-official/deepseek-flash`，
> 怀疑跑错模型就看这一行，别猜。

幂等靠 `state/auto-reply-state.json`：

- 已回过的评论 id 永久记账，不重复回
- 私信存每个会话的「消息指纹」（只看真人说的话），指纹没变就不打扰
- 只留最近 3000 条评论记录，防止文件膨胀（2026-11-03 从 400 提高：
  现在每轮最多 50 条、一天十几轮，400 只够七八轮，太早被挤掉的 id 下一轮要重查一遍）

#### 每轮回哪些（2026-11-03 zuige 定的规矩）

| 项 | 值 | 常量 |
|---|---|---|
| 视频范围 | 只回 **2026-10-01 之后**发布的 | `SINCE = '2026-10-01'` |
| 扫几条视频 | **所有符合条件的全扫**，每轮最多 30 条兜底 | `MAX_VIDEOS = 30` |
| 单视频读评论 | 最多 **300 条**（一页 20，翻页读全） | `MAX_COMMENTS_PER_VIDEO = 300` |
| 单轮总回复 | 最多 **50 条**，不分视频均分 | `MAX_TOTAL = 50` |
| 单视频上限 | 20 条（防一个大爆款吃光额度） | `MAX_PER_VIDEO = 20` |

- **每轮都重新看有没有新视频**，不是只在跑之前查一次。
- 选谁回是**按视频轮流取**（round-robin）。顺序取满的话一个大爆款就吃掉全部 50 条，
  后面的视频一条都轮不到 —— 表现就是「新视频没人回」。视频内部**先回最新的**。
- `createTime` 拿不到的（`work_list` 那边没给）**不丢**，按新视频处理排最前面 ——
  刚发的新视频最容易在 work_list 里缺席，一丢就正好复现「最新视频没人回」。
- 抖音的 `cursor` 有时原地不动，翻出重复页必须**立刻 break**，否则死循环。

> 🔴 **2026-11-03：私信连发 4 条事故。** 根因是 `MessageListlist` 的 children
> 是**新在上、旧在下**，而 `readThread` 用 `rows.slice(-n)` 取的是最旧的 n 条，
> 调用方再把最后一条当"最新"—— 判断完全颠倒，导致"我刚回完"被读成"对方在等我"，
> 于是每轮重发一遍。已改成 `slice(0,n).reverse()`。
> 同批修掉的还有：时间戳粘进正文、打开会话不滚到底、系统提示「已确认聊天」没滤掉、
> 展开陌生人分组后多出的透明容器吃点击、以及"发送成功"误判。
> 细节见 `AGENTS.md` 的「抖音聊天页的坑」。排查用 `node tools/peek-dm.mjs 昵称`。

三条硬规则：

1. **不算「对方说话」的东西**：时间分隔条、以及抖音的系统提示
   （「只能发送一条文字消息」「暂不支持该消息类型」…）。第一版没过滤，
   结果给两个根本没开口的陌生人各发了一条私信 —— 私信只能发一次，补不回来。
2. **私信限一条**：页面上写着「对方回复或关注你之前，只能发送一条文字消息」。
   所以最后一条如果是「我」，且这个会话被标记限一条，这一轮就不发。
3. **不自己 launchPersistent**：server 已经占着 `sessions/douyin`，脚本再起一个
   必然报 `Target page, context or browser has been closed`。评论全程走 HTTP
   （`/douyin/refresh`、`/douyin/works`、`/douyin/comments`、`/douyin/replies`、
   `/douyin/reply`），白拿 server 的熔断器和 60 秒限速。

#### 「这条评论我到底回没回」——别信 `is_author`，也别信 `replyCount`

creator 后台评论接口返回的 `is_author` 是个**坏字段**，同一个含义两种取值
（2026-11-02 实测）：

| 作品 | 已回的评论 `is_author` |
|---|---|
| 最新视频「抖音第一条」 | false |
| 老视频「孩子高考成绩出来了」 | true |

网页端更乱：那批评论的人确实不是我，`is_author` 也全是 false，连我自己发的回复都是 false。

`replyCount` 一样不可信（2026-11-03 实测）：5 条评论都已被我回复，
其中 **4 条 `replyCount` 仍是 0**，只有 1 条变成 1 —— 而那个 1 是**别人**回的「可以」。
也就是说 creator 侧的 `replyCount` 根本不把我自己的回复算进去。
**`replyCount === 0` 绝不能当成「我没回过」。**

所以脚本启动先 `GET /douyin/profile` 拿自己的 `nickname`，
判据改成 `x.user === 我的昵称`（拿不到昵称才退回 `is_author`）。
日志会打「我是「zuige大肥鱼」」，一眼能看出判据生效没有。
真正的幂等靠 `repliedComments` 那个本地账本，`replyCount > 0` 只用来决定
「值不值得多打一次 `/douyin/replies`」。

要查某条作品下「谁评论了、谁回了什么」，用只读工具：

```bash
node tools/peek-comments.mjs 7703140636089699634   # 参数是 plainId
```

它直接打 www 域的 `/aweme/v1/web/comment/list/` 和 `.../list/reply/`，
输出「评论人 → 回复人 + 回复内容」，比翻 creator 后台清楚得多。

定时任务（2026-11-03 改，不再是每天 4 个固定点）：

| 日子 | 排点 | 轮数 |
|---|---|---|
| 工作日 | `12:15` `13:30` `18:15`，之后每小时 `:15` 到次日 `08:15` | 17 |
| 法定节假日 / 周末 | 全天每小时 `:15` | 24 |

工作日那两段空档（`08:15~12:15`、`13:30~18:15`）**是有意留的** ——
那是 DeepSeek 高峰（工作日 9-12、14-18 价格翻倍），zuige 明确说不用补。
周末按节假日算，是因为 DeepSeek 周末全天平峰、没有要避开的高峰。
只想节假日生效的话，把 `scheduler.mjs` 里 `targetsForNow()` 的 `isWorkday`
换成 `isHoliday`（`core/offpeak.mjs` 已导出）。

兜底：即使排点错了，高峰时段触发到也只会打印「跳过」并退出，零 LLM 费用。

#### 定时器放在系统后台，不依赖 WorkBuddy

`tools/scheduler.mjs` 是常驻进程，自己看表，到点 spawn 一次 `auto-reply.mjs`。

```bash
node tools/scheduler.mjs            # 前台跑（调试）
node tools/scheduler.mjs --once     # 立刻跑一轮然后退出
```

开机自启：`start-scheduler.vbs` 已复制到
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\zhibo-auto-scheduler.vbs`。
VBS 里写死了 node 的绝对路径（WorkBuddy 自带的那份），**升级 WorkBuddy 后路径会变，要改**。

为什么不用 Windows 计划任务：`schtasks` 从 bash 调用会被安全策略拦
（"Invoking cmd.exe from Bash bypasses all command validation"），
`wscript` 也被当成 LOLBin 拦。所以只用 node 常驻进程 + 启动文件夹。

> 🔴 **后果：AI 没法自己把定时器拉起来。** `wscript.exe` 和 PowerShell 的
> `Start-Process` 都会被安全策略拒掉（LOLBin / 绕过校验）。定时器挂了只有两条路：
> **双击** `start-scheduler.vbs`，或者**重启**（它在启动文件夹里，登录时自动起）。
> 用 `node tools/scheduler.mjs` 起的那个进程活不过当前会话。

定时器自己的状态在 `state/scheduler-state.json`（记「今天这个点跑过了」，
重启进程不会重复跑），日志在 `logs/scheduler/<日期>.ndjson`。

定时器**顺带守护控制台服务**：每 30 秒探一次 `:18090`，挂了就拉起来
（拉起后 90 秒内不再探，给它预热抖音数据的时间 —— 约 15 秒）。
为什么需要：server 是评论发送的唯一出口（熔断器 + 60 秒限速都在里面），
实测它会被系统清理掉（跑满 6 小时后 exit 127），挂了 auto-reply 就干不了活。

#### 陌生人私信：不做自动回复

抖音把没互关的人折叠在「陌生人消息」分组里，这个分组**跟未读绑定** ——
点进去读过一次就收起来、入口消失，想再进只能等新消息。加上：

- 展开后左栏子项被分组头遮挡（子项 y≈88 落在分组 60~126 里），坐标点永远点到分组头
- 展开那一瞬间列表会带 `transform: matrix(1,0,0,1,-303,0)` 滑出视口，卡住不回来

所以 `auto-reply.mjs` 只做 `reportStrangers()`：能读到就把会话列进结果推给人，
**不自动发**。抖音对陌生人「只能发一条文字」，发错补不回来，交给手机处理更稳。

### 改作品

点作品行的「编辑」或右上角「在后台编辑」，会弹出一个**真实的有头浏览器**
停在创作者后台的内容管理页，你在那儿点「编辑作品」改。

为什么不让 AI 直接改：`POST /web/api/media/aweme/update_v2` 的入参结构
在 108 个 JS bundle 里都没找到调用点。猜字段名有风险 —— 少传一个就可能把
已发布作品的封面或可见性洗掉。所以这一步留给人。

---

## 8. 让 AI 来操作

接一个 agent 上来，第一件事打这个：

```bash
curl http://127.0.0.1:18090/agent
```

返回 25 个接口的清单，每个带 `sideEffect` 标记：

| 标记 | 含义 | 数量 |
|---|---|---|
| `read` | 只读，随便调 | 14 |
| `dry-run` | 有成本（起浏览器/花 token）但不产生对外结果 | 8 |
| `write` | 真会动线上账号，**必须两段式** | 3 |

还带三条现成的串联配方（出一条片 / 投稿 / 回评论），AI 照着走就行。

**推荐给 AI 的工作流**：

```
GET  /agent                          # 先看有什么
GET  /video/list                     # 看有哪些成片
POST /publish {platform, id, ...}    # 投稿第一段
GET  /jobs/<id>/steps                # 等到 awaiting-confirm
        ↑ 到这里必须停下来问人
POST /jobs/<id>/confirm {confirm:true}
```

---

## 9. 磁盘会越来越胖

`video/out` 会攒四类垃圾，一不留神就几百 MB：

| 来源 | 体积 |
|---|---|
| Playwright 原始录屏 `page@*.webm` | 一个片子 **45MB** |
| 失败任务的空壳目录 | 0 |
| 散落的调试截图 | 几十 KB |
| 投稿截图（每投一次 3 张） | 每份 0.5MB |

**新出的片子已经自动删录屏了**（想留原片调试模板：`config.json` 里加
`"video": {"keepRawRecording": true}`）。

清历史垃圾：

```bash
# 先预览，告诉你删什么、能省多少
curl "http://127.0.0.1:18090/video/gc?raw=1&publish=1"

# 确认了再真删
curl -X POST http://127.0.0.1:18090/video/gc \
  -H "content-type: application/json" -d '{"apply":true,"raw":true}'
```

默认**只预览不删**。`raw:true` 才连录屏一起删，`publish:true` 才清投稿截图。

---

## 10. 常见问题

<details>
<summary><b>启动报 <code>EADDRINUSE</code></b></summary>

端口 18090 被占了，多半是已经有一个在跑。换端口：

```bash
set AUTO_PORT=18100 && npm start
```
</details>

<details>
<summary><b>出片失败：<code>TTS 失败：Cannot connect to host speech.platform.bing.com</code></b></summary>

edge-tts 连不上微软的接口，一般是网络问题。**隔一分钟重试基本就好**。
如果长期不行，检查代理设置，或换一个 TTS 实现（接口约定见第 2 节）。
</details>

<details>
<summary><b>出片失败：<code>模板报错</code> / 黑屏</b></summary>

先不录视频，用预览脚本出 3 张截图，6 秒就能看到版式对不对：

```bash
node video/preview.mjs video/scripts/_script_day0.json
```

比录一条 100 秒的片子快 20 倍。
</details>

<details>
<summary><b>抖音数据一直是旧的</b></summary>

设计如此 —— 只有**服务重启**和**点右上角刷新**才重新抓。
不想等重启就点刷新，或者：

```bash
curl -X POST http://127.0.0.1:18090/douyin/refresh
```
</details>

<details>
<summary><b>投稿卡在 <code>awaiting-confirm</code> 不动</b></summary>

dry-run 之后重启过服务，浏览器页面丢了。撤销掉重新发起：

```bash
curl -X POST http://127.0.0.1:18090/jobs/<id>/confirm \
  -H "content-type: application/json" -d '{"confirm":false}'
```
</details>

<details>
<summary><b>重出旧片（比如 day0）</b></summary>

脚本还在的话，直接走接口，不用碰 UI：

```bash
node -e "
const s = require('./video/scripts/_script_day0.json');
fetch('http://127.0.0.1:18090/video/make', {
  method: 'POST', headers: {'content-type':'application/json'},
  body: JSON.stringify({
    template: 'diary', title: s.title, journalTitle: s.journalTitle,
    day: s.day, segments: s.segments,
    petImage: 'D:/你的/pet.png'
  })
}).then(r => r.json()).then(console.log)
"
```
</details>

<details>
<summary><b>评论区显示「作品列表里没有这个 id」</b></summary>

评论接口只认**加密 id**（`@ivRu...==` 这种），不认明文数字。
用明文去调会返回 200 但 `total=0`，不报错 —— 很容易误判成"这个号没评论"。
后端会自动换，但只认最近 20 条作品，更早的要先翻作品列表。
</details>

---

## 11. 红线

这些是**设计如此**，不是没做完：

- **发布默认 dry-run**：填完表单截图，停在发布按钮前，人确认才真发
- **写操作前先验登录态**，平台限速（抖音 60s / B站 10s），写后复检，掉号当天熔断
- **评论三重闸**：config 开关 + confirm + 白名单（只回自己视频下），默认全关
- **登录态/日志/成品全在 .gitignore**：`sessions/` 里就是 cookie，别提交
- 不碰群控、不做协议刷量

---

## 12. 目录结构

```
server.mjs          HTTP 服务：静态页 + 业务接口 + 控制 API（一个文件搞定）
start-backend.bat   Windows 一键启动

core/               任务队列 / 分平台日志 / 写操作熔断 / 子进程 / 浏览器封装 / LLM 客户端
                    agent-api.mjs = 给 AI 的接口清单

video/              script（主题→文案）/ make（TTS+录屏+合成）/ pipeline（一条龙）
                    library（成片库）/ gc（清理）/ templates（版式模板）

douyin/             登录 / 会话体检 / 投稿 RPA / 评论 / insight（读数据）/ manage（写）
bili/               同构一套

web/                控制台前端（原生 ES module，无打包步骤）
  app/views/        六个页面各一个文件
  styles/           设计令牌 + 组件样式
  vendor/           Vue / 字体（本地化，不连 CDN）

tools/              常驻工具：自动回复、定时器、素材、抠图、成片复审
tools/probe/        一次性探测脚本（抖音页面改版后重跑；相对引用是 ../../）

.workbuddy-ai/      skill 池与工作日志 🔒 不进仓库
  skills/           github-picks（原生）＋ video-shotcraft（外部引入，见其 README）
  memory/           按天的排查与决策日志

sessions/           各平台浏览器 profile（登录态）🔒 不进仓库
logs/               logs/douyin、logs/bili、logs/video —— NDJSON 全留痕 🔒
state/              任务快照、抖音数据缓存、调试截图 🔒
video/out/          成片与中间产物 🔒
.run/               pid 与控制台日志；.run/trash/ 放当天挪走的杂物 🔒
```

---

## 现状

> 下面这版是 2026-11-02 按 `state/jobs.json` 实测数据写的，不是"感觉做完了"。
> 任务分布：`pipeline` 成功 3 / 失败 0，`video` 成功 4 / 失败 2，
> `publish` 成功 3 / 失败 19（其中 16 条是人工撤销，1 条 upload 页 `goto` 超时 60s）。

- ✅ 主题 → 文案 → 成片 全链路（竖屏 88s / 横屏 85s 各跑通过，一条龙约 110 秒）
- ✅ 抖音登录 + 账号数据 + 评论回复 + 编辑入口
- 🟡 抖音投稿两段式：dry-run 机制在，但选择器/导航不稳（19/22 次没走通）
- ✅ 本地成片库 + 磁盘清理
- ⏳ **发布这一环在界面上没有入口**：`web/app` 里零处调用 `/publish`，
  目前只能靠脚本/AI 建 job，再去任务中心点确认
- ⏳ **策划台与视频工坊没接上**：策划 md 里的钩子与口播不会流进工坊，
  工坊只吃一个 `topic` 让 LLM 重写；`/pipeline/run` 也不校验策划 `approved`
- ⏳ B 站登录待真实扫码验证；投稿 RPA 选择器要拿真实页面微调
- ⏳ 投稿还差：AI 生成内容声明勾选、B 站分区
- ⏳ 视频侧还差：BGM、响度归一化（方法见 `.workbuddy-ai/skills/video-shotcraft/references/music-beat-sync.md`）
