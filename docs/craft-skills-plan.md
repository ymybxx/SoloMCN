# 技能整理：全部用标准 Skill

## 一、出发点

Claude Code 自己就支持技能，而且自带三层渐进加载：

| 什么时候进上下文 | 内容 |
|---|---|
| 一直在 | 每个技能的名字和一句简介（每个几十字） |
| Claude 判断要用时 | 这个技能的 `SKILL.md` 正文 |
| 正文里指到、真用到时 | 同一文件夹里的其他文件（`references/*.md`、`scripts/`） |

所以平台不另造加载机制，不算工作包，也不另设工具箱。**所有规则都是标准技能**，Claude 按标准方式自己读。平台只做标准技能做不到的事：同步出厂版本、显示变化、开关、记录 Claude 的改动。规则写在文件里，不写进平台代码，Claude 能发挥多少就发挥多少。

用户只要懂一句：**技能就是一个文件夹，`SKILL.md` 是入口，其他文件是它的附录。**

## 二、现在的问题

| 问题 | 例子 |
|---|---|
| 流程技能没分层 | make-video 一个文件 4 万字，HyperFrames、画质、解说员、配乐、原片剪辑全在里面，出片时整篇读进上下文 |
| 同一种做法散在四处 | 原片剪辑在调研、写脚本、出片、修改四个技能里各写一段，加一种风格要改四处 |
| 共用程序没有家 | 配音程序有两份（`voice-over/scripts/`、`lab-shared/tools/`），`tools/img.mjs` 没有说明，调研装的 ghidra 只有调研知道 |
| 更新看不出变化 | 出厂更新只提示「有新版本」 |
| 经验沉淀不下来 | 踩过的坑只留在那次对话里 |

## 三、结构：只有一种东西，技能文件夹

```
.claude/skills/
│
│  ── 流程：每个环节一个，只写通用步骤 ──
├─ make-video/
│    SKILL.md               几千字：读内容 → 看用哪种做法 → 做 → 登记 → 汇报
│    references/            画质.md、审片和体检.md、真实素材.md ……用到才读
├─ research-topic/  write-script/  revise-video/  ……   同样是短正文 + references/
│
│  ── 做法：一种内容一个，按环节分文件 ──
├─ stage-montage/           原片剪辑：一键换装、舞台混剪
│    SKILL.md               简介 + 「调研看 research.md，写脚本看 script.md ……」
│    research.md  script.md  video.md  revise.md
│    scripts/               montage.mjs、lockfx.swift、pose.swift、array.swift
├─ explainer-video/         解说视频：HyperFrames、解说员、配乐
│    SKILL.md  video.md  revise.md  scripts/
│
│  ── 工具：多处会用的程序，也是技能 ──
├─ voice-over/              配音合成：SKILL.md 写用法和坑，scripts/ 放程序
├─ image-gen/               生图
└─ transcribe/              语音回听（whisper，写明模型装在哪）
```

- 流程、做法、工具在格式上没有区别，区别只在简介怎么写。Claude 按简介自己找。技能页按这三类分组显示，方便看。
- 流程技能的 SKILL.md 里写一句：「这条内容用的是哪种做法（看系列说明，或者已有做法技能的简介），就读那个做法里本环节的文件。做法没写这个环节，就按这里的通用步骤来。」
- 做法需要哪些工具，在它自己的文件里写「配音用 voice-over」，不需要专门声明。
- 加一种新风格，就新建一个技能文件夹。Claude 实践中装了新工具，就写一个小技能，下次直接用。
- 解说视频的出片大约只读 make-video 正文和 explainer-video/video.md，原片剪辑的规则一个字都不会读进来。

## 四、平台只做这几件事

1. **同步**：出厂版本和用户版本三方合并。现在只合并 SKILL.md，要改成整个文件夹的所有文件都合并。没改过的技能自动跟上出厂版本。
2. **看变化**：任何文件的任何改动都能逐行对比，不管是出厂更新、自己改的还是 Claude 改的。出厂更新附一句「这次改了什么」。
3. **开关**：
   - 每个技能一个「启用」。关掉后不装进 `.claude/skills`，不占上下文。
   - 全局一个「允许 Claude 改进技能」，默认开。
4. **记录 Claude 的改动**：每次运行前给 `.claude/skills` 存一份快照，跑完后对比。有改动就在动态里记一条：哪次运行、改了哪些文件、为什么（取自 Claude 的汇报）。每条都能看对比、能一键撤回。Claude 用普通编辑工具直接改，不需要专门接口。Claude 不能删除技能，删除只能用户来点。
5. **资料归资料**：音色库、读音表、账号、系列放在 `data/`，密钥放在设置页。技能里不写具体账号、具体人、具体 key。

6. **合并交给 Claude**：开着自我进化，技能迟早都会被 Claude 改过，出厂更新不能每次都让用户合并。出厂有新版时由 Claude 做三方合并（保留实践里改出来的经验，吸收出厂的改进），动态里记一条「已合并出厂更新」，能看对比、能撤回。只有 Claude 判断两边真的冲突、取舍不了时才问用户。
7. **定期整理**：整理本身也是一个技能（tidy-skills）：合并同类、删过时的、把变长的 SKILL.md 细节挪进附录、检查简介是否还写得清楚。平台在空闲时定期跑，结果同样进动态。
8. **事实由平台给，不让 Claude 猜**：这条内容属于哪个系列、系列用哪种做法、上一版在哪，这些是资料。平台调用时带上一句（「本系列用 stage-montage」），不写死流程，只是不让 Claude 每次靠简介去猜。

不再做的：工作包、`.claude/crafts/`、`.claude/toolbox/`、`tools:` 声明、`improve_craft` / `register_tool`。

## 五、上限和选得准不准

按官方文档（code.claude.com/docs/en/skills.md）：

| 限制 | 数字 | 对我们的影响 |
|---|---|---|
| 简介 | 每个技能常驻，超过 1536 字会被截断 | 十几个技能、每个一两百字，常驻合计两三千字，不是问题 |
| 正文 | 用过之后一直留在这次对话里 | 官方建议 SKILL.md 控制在 500 行以内，细节放附录 |
| 上下文压缩后 | 每个技能只保留前 5000 token，所有技能合计 25000 token，旧的可能整个丢掉 | make-video 现在 4 万字，压缩后后半段会被截掉。这是现在就存在的问题，分层后正文几千字，不会被截 |

选得准不准，分三种情况：

- **流程**：不用猜。平台调用时消息开头写 `/make-video`，直接加载这个技能；
- **做法**：不用猜。平台在调用时带上「本系列用 stage-montage」；系列选了自动时，由 Claude 在写脚本时按简介选一次，记到卡片上，后面环节照用；
- **工具**：大多不用猜。做法文件里直接写「配音用 voice-over」。只有 Claude 自己临时需要什么时才按简介找，所以简介要写清「做什么，什么时候用」，定期整理时会检查。

## 六、改进提示

开着「允许 Claude 改进技能」时，每次运行的提示里多一段：

> 遇到技能里没写到的坑、写错的地方，或者找到明显更好的做法，直接改对应技能的文件。做法的坑改做法，工具的坑改工具，通用流程的问题改流程技能。要改，不要只往后追加：同主题的合并，过时的删掉；SKILL.md 保持简短，细节放附录。最后在汇报里写一句改了什么、为什么。

这段同时取代调研里单独的「经验本」（`videos/lab-shared/NOTES.md`）。

## 七、迁移

| 现在在哪 | 搬到哪 |
|---|---|
| make-video「原片剪辑」一节 + montage 等脚本 | stage-montage/video.md + scripts/ |
| research-topic 里「B 站素材」「换装素材标准」 | stage-montage/research.md |
| write-script 里「剪辑方案」格式 | stage-montage/script.md |
| revise-video 里原片修改部分 | stage-montage/revise.md |
| make-video 里 HyperFrames、解说员、配乐 | explainer-video/（+ presenter、synth-bgm 脚本） |
| make-video 里画质、审片、体检、真实素材 | make-video/references/ |
| `lab-shared/tools/tongyi-tts.mjs`（重复的一份） | 删掉，统一用 voice-over |
| `tools/img.mjs` | image-gen 技能 |
| whisper 用法、模型位置 | transcribe 技能 |
| `voice-over/voices.json`（音色库） | `data/voices.json` |
| 读音（比如 tulpa） | 资料：账号或系列的读音表，配音时自动套用 |
| `lab-shared/NOTES.md` | 拆回对应技能后停用 |
| 服务端写死的 `make-video/scripts/montage.mjs` 路径（素材体检） | 指向 stage-montage/scripts |
| 调研沙盒里复制的一份技能 | 改成直接读 `.claude/skills`，各环节读的是同一份 |
| revise-video「改一处就整条重渲染」（改个读音要 10 分钟） | 各做法的 revise.md 写明：时长不变的小改（换一句配音、改一条字幕、改一刀）只重做那几秒，再拼回原片 |

已有的内容卡片和视频都不用动。

## 八、做完怎么验收

- 苏新皓换装这条：按新结构重新「生成视频」，成片和第十九版一致；
- 一条普通解说视频：运行记录里读到的文件不包含任何原片剪辑的内容；
- 关掉 stage-montage：`.claude/skills` 里没有这个目录；
- Claude 在一次运行里改了技能：动态里出现一条带原因的改动，能看对比、能撤回；
- 出厂更新一个被 Claude 改过的技能：Claude 自动合并，动态里能看到合并结果和对比，不弹合并框；
- 出厂更新一个多文件技能：技能页能看到每个文件改了什么。
