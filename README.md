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
item_id:    @ivRu6bNMRknwts1d6LL...（加密串）
comment_Id: @ivRu6bNMRknwts1d6LL...
text:       谢谢支持，下次直播再聊～
```

再点「确认发送」才真发。

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
node video/preview.mjs _script_day0.json
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
const s = require('./_script_day0.json');
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
  app/views/        五个页面各一个文件
  styles/           设计令牌 + 组件样式
  vendor/           Vue / 字体（本地化，不连 CDN）

sessions/           各平台浏览器 profile（登录态）🔒 不进仓库
logs/               logs/douyin、logs/bili、logs/video —— NDJSON 全留痕 🔒
state/              任务快照、抖音数据缓存、调试截图 🔒
video/out/          成片与中间产物 🔒
```

---

## 现状

- ✅ 主题 → 文案 → 成片 全链路（竖屏 88s / 横屏 85s 各跑通过，一条龙约 110 秒）
- ✅ 抖音登录 + 账号数据 + 评论回复 + 编辑入口
- ✅ 抖音投稿两段式（dry-run 实测通过，含上传等待与按钮预检）
- ✅ 本地成片库 + 磁盘清理
- ⏳ B 站登录待真实扫码验证；投稿 RPA 选择器要拿真实页面微调
- ⏳ 投稿还差：AI 生成内容声明勾选、B 站分区、定时发布
- ⏳ 视频侧还差：BGM、响度归一化
