---
name: explainer-video
description: 做法：解说视频（HyperFrames 动态图文 + 配音，系列配了角色时加解说员）。没有指定其他做法的内容默认用它。写脚本、生成视频、修改视频时读这里对应的文件；调研按流程技能的通用做法。
metadata:
  kind: craft
---

# 解说视频

用 HyperFrames（`/faceless-explainer`）把分镜脚本做成动态图文视频：真实素材当主画面，配音按 `/voice-over`，配乐用曲库或代码合成，系列配了解说员时由她出镜。

各环节看这里的哪个文件：

| 环节 | 文件 |
|---|---|
| 调研 | 没有单独的文件，按 research-topic 的通用做法 |
| 写脚本：开头 3 秒抛主题和钩子、讲得小白能懂 | `script.md`（格式仍按 write-script） |
| 生成视频：建项目、按 faceless-explainer 做、画面质量 | `video.md` |
| 修改视频 | `revise.md` |

用到时再读的附录：

- `references/presenter.md`：解说员怎么留位置、写参数、叠上去
- `references/review.md`：渲染前审片、渲染后体检
- `references/bgm.md`：代码合成配乐和音效
- `references/assets.md`：调研收集的截图、视频片段和实践素材怎么用

程序在 `scripts/`：`presenter.mjs`（解说员）、`synth-bgm.mjs`（配乐）、`review-sheets.mjs`（审片拼图）、`film-check.mjs`（成片体检）。
