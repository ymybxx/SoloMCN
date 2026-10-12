---
name: transcribe
description: 工具：语音转文字（本机 whisper.cpp）。回听配音有没有念错、给素材里的说话配字幕、对齐台词时间时用。
metadata:
  kind: tool
---

# 语音转文字

用本机的 whisper.cpp，不联网、不花钱。

## 在哪

- 程序：`whisper-cli`（一般在 `/opt/homebrew/bin/whisper-cli`）。没有的话这台电脑没装，告诉用户运行 `brew install whisper-cpp`，这次跳过回听。
- 模型：工作台根目录下的 `data/programs/whisper/`，用多语言模型（文件名里没有 `.en`），中文推荐 `ggml-medium.bin`（1.5 GB）或 `ggml-small.bin`（480 MB）。目录里没有就下载到这里：
  `curl -L -o data/programs/whisper/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin`

## 怎么用

1. 先转成 16 kHz 单声道 wav：`ffmpeg -y -i <输入> -ar 16000 -ac 1 /tmp/x.wav`
2. 转文字：`whisper-cli -m <模型> -l zh -f /tmp/x.wav -oj -of <输出前缀>`，结果在 `<输出前缀>.json`，每段有起止时间和文字。英文内容用 `-l en`，混着说用 `-l auto`。
3. 只抽查几句时，用 ffmpeg 先截出那几秒（`-ss <起> -t <长>`）再转，快很多。

## 坑

- 模型下了一半（文件太小、加载报错）就删掉重下。
- 背景音乐很响时识别会乱，回听配音时用没混音乐的单句配音文件。
