#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tools/tts-day1.py —— 给 Day1 视频批量合成配音

为什么单独写一个：
  直播间那条链路（zhibo/tools/tts.py）是「一句一合成、按句缓存」，
  它服务的是弹幕实时回复。视频这边需要的是「整片一条时间轴」：
  每段都要拿到**确切时长**，才能把画面切点钉在配音上。

  所以这里复用它的音色和参数，但把结果整理成 Remotion 要的形状：
  out/day1/voice/seg-NN.mp3  +  out/day1/voice/timing.json

timing.json 结构：
  {
    "voice": "...", "rate": "-8%", "total": 56.3,
    "segments": [
      {"i":1, "text":"...", "file":"seg-01.mp3", "dur":3.17, "start":0.0, "end":3.17}
    ]
  }

🔴 start 是累加的，**按 0.18s 留一口气** —— 一句接一句没有间隙，听着像赶集。
"""
import io
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ZHIRO = r"D:\Workplace\zhibo"
TTS = os.path.join(ZHIRO, "tools", "tts.py")
PY = os.path.join(ZHIRO, ".venv", "Scripts", "python.exe")

OUT = os.path.join(ROOT, "video", "out", "day1", "voice")
SCRIPT = os.path.join(ROOT, "video", "scripts", "_script_day1.json")
# 🔴 timing.json 写到 Remotion 工程的 src/ 里，不写 public/。
#    mp3 走 staticFile（public/），时间轴走 import（src/）——
#    src 里的 JSON 能被 tsc 检查到（tsconfig include 只覆盖 src），
#    public 里的一份既没类型检查又要多存一份副本。
TIMING_DIR = os.path.join(
    ROOT, ".workbuddy-ai", "skills", "video-shotcraft", "template", "src", "aifl"
)

VOICE = "zh-CN-XiaoyiNeural"   # 大肥鱼直播用的那条声线，别换
RATE = "-8%"
GAP = 0.18                      # 段间留白（秒）


def synth(text, dest):
    """调 zhibo 的 tts.py 合成一句，拷到 dest，返回时长"""
    r = subprocess.run(
        [PY, TTS, "--text", text, "--voice", VOICE, "--rate", RATE],
        capture_output=True, text=True, encoding="utf-8",
    )
    if r.returncode != 0:
        raise RuntimeError(f"tts.py 失败：{r.stderr[:300]}")
    line = [l for l in r.stdout.strip().splitlines() if l.strip().startswith("{")]
    if not line:
        raise RuntimeError(f"tts.py 没输出 JSON：{r.stdout[:300]}")
    j = json.loads(line[-1])
    if not j.get("ok"):
        raise RuntimeError(f"tts.py 报错：{j}")
    src = j["file"]
    with open(src, "rb") as f:
        data = f.read()
    with open(dest, "wb") as f:
        f.write(data)
    return float(j["dur"])


def main():
    os.makedirs(OUT, exist_ok=True)
    with io.open(SCRIPT, encoding="utf-8") as f:
        script = json.load(f)

    segs = script["segments"]
    talk = [(i + 1, s["text"]) for i, s in enumerate(segs) if "text" in s]
    print(f"要合成 {len(talk)} 句，音色 {VOICE}")

    out = []
    cursor = 0.0
    for n, (i, text) in enumerate(talk, 1):
        name = f"seg-{n:02d}.mp3"
        dest = os.path.join(OUT, name)
        dur = synth(text, dest)
        out.append({
            "n": n, "seg": i, "text": text, "file": name,
            "dur": round(dur, 3),
            "start": round(cursor, 3),
            "end": round(cursor + dur, 3),
        })
        print(f"  {n:2d}/{len(talk)}  {dur:5.2f}s  {text}")
        cursor += dur + GAP

    total = round(cursor - GAP, 3)
    timing = {"voice": VOICE, "rate": RATE, "gap": GAP, "total": total, "segments": out}

    # 两处落盘：
    #   video/out/day1/voice/timing.json —— 给人看/给别的脚本用
    #   template/src/aifl/timing.json    —— 给 Remotion import
    tp = os.path.join(OUT, "timing.json")
    with io.open(tp, "w", encoding="utf-8") as f:
        json.dump(timing, f, ensure_ascii=False, indent=2)

    os.makedirs(TIMING_DIR, exist_ok=True)
    tp2 = os.path.join(TIMING_DIR, "timing.json")
    with io.open(tp2, "w", encoding="utf-8") as f:
        json.dump(timing, f, ensure_ascii=False, indent=2)

    print(f"\n总时长 {total}s")
    print(f"  {tp}")
    print(f"  {tp2}")


if __name__ == "__main__":
    main()
