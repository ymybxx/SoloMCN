---
name: voice-over
description: 给视频配音：把旁白和角色台词合成成音频文件，标好时长，交给做视频的流程对齐字幕。做视频（make-video）、改视频（revise-video）时调用，也可以单独用来试音色。配了通义（阿里云百炼）的 key 就用通义，没配就用 macOS 自带的中文语音，都不需要工作台配置。
metadata:
  kind: tool
---

# 配音

把台词合成成 wav 文件，每段一个，并给出每段的时长，交给做视频的流程登记进 `audio_meta.json`、对齐字幕。全程无人值守时，不提问、不等回复，用得上哪种方式就用哪种，在制作备注里写清楚。

## 1. 选哪种方式（用第一个能用的）

1. **通义语音**（中文最自然，有很多音色）：环境变量 `DASHSCOPE_API_KEY` 有值就用它。
   - 批量：把旁白写成 `编号<TAB>台词` 的 tsv，运行 `node <本技能目录>/scripts/tongyi-tts.mjs --voice <音色> --lines voice/lines.tsv --outdir voice`
   - 单句：`node <本技能目录>/scripts/tongyi-tts.mjs --voice <音色> --text "台词" --out voice/line-01.wav`
   - 每句输出一行 JSON，含时长 `seconds` 和每个句子的结束时间 `sentences[].end_s`，用它们对齐字幕。
   - 语速用 `--speed`（默认 1.0，0.9–1.15 之间调），一般不用改。
2. **HyperFrames 托管配音**：没有通义 key、HyperFrames 已登录（`npx hyperframes auth status`）而且还有额度时，用 `/faceless-explainer` 里的托管配音。
3. **macOS 系统中文语音**（免费、本地、发音准）：`say -v "<音色>" -r <语速> -o voice/line-<编号>.aiff "<台词>"`，再用 `ffmpeg -i …aiff -ar 48000 -ac 1 …wav` 转成 wav，用 `ffprobe` 读时长。语速 `-r` 默认约 180，语气急的角色可以调到 200–220。
4. **都不行**：做成无配音、字幕承载台词的版本，在备注里写明原因。

不要用 HyperFrames 自带的本地 Kokoro 念中文：中文发音错得很多，基本听不懂；纯英文台词可以用。

## 2. 选音色

- 先用内容所属系列（或账号）设定的音色：`get_item` 返回的 `account.voice`。
- 没设定就按人设从本技能目录下的 `voices.json` 挑：`engine` 是 `tongyi` 的要有通义 key 才能用，`macos` 的随时能用。设定的是通义音色、但现在没有 key，就挑一个性别和年龄接近的系统语音。
- 多个角色各用一个声音，全片保持一致；旁白用最稳的那个。
- 只用合成音色，不克隆、不模仿任何真人的声音。

## 3. 合成之后

- 用 `ffprobe` 读每个文件的时长，按 `/faceless-explainer` 里处理已有配音文件的方式登记进 `audio_meta.json`（文件放在项目里，标明来源），再跑时长同步和字幕。
- **特定词怎么念**：系列设定里写了的（一般在「主角和语气」里，比如「Cursor 念作 克尔瑟」），合成时照它把台词改写成好念的说法；字幕仍显示原文。
- 设定里没写、但念错的词（英文缩写、数字、多音字、品牌名），同样改写成好念的说法再合成那一句，在 notes 和汇报里提一句「可以在系列设定里写上：X 念作 Y」，以后就不用每次再试。
- 回听抽查几句：按 `/transcribe` 把配音转成文字，和台词对一遍。
- 通义念英文单词：全大写（CURSOR）会一个字母一个字母念，首字母大写（Cursor）才当成一个词念。
- 在制作备注里写明：用了哪种方式、哪些音色，退到下一种方式的原因。

## 4. 配置通义的 key（给用户看的）

这个技能不经过工作台的设置。要用通义，在项目的 `.claude/settings.local.json`（不进 git）里加：

```json
{ "env": { "DASHSCOPE_API_KEY": "你的通义 key" } }
```

想所有项目都用，就写在 `~/.claude/settings.json` 里。也可以直接在 Claude Code 里说「帮我配一下通义配音的 key」。key 在阿里云百炼控制台申请。
