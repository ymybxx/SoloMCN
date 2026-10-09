<div align="center">

# SoloMCN

### 把 Claude Code 变成你的短视频团队

**不搭工作流，直接让 Claude 干活。从全网热点到抖音、小红书、B站、YouTube 发布，一个人运营一个账号矩阵，每一步都是 Claude 亲手做的。**

[English](README.en.md) · MIT License · Powered by [Claude Code](https://claude.com/claude-code)

</div>

![SoloMCN 工作台](docs/images/hero.png)

## 一种新的 AI 软件做法

过去做 AI 应用，要先搭工作流：拖节点、连线、写死每一步的提示词、接一堆 API。流程搭成什么样，AI 就只能做到什么样。

SoloMCN 反过来：**零搭建工作流，直接操纵 Claude。**

|  | 搭工作流的 AI 应用 | SoloMCN |
|---|---|---|
| 怎么定义一个环节 | 拖节点、连线、写死提示词 | 用中文写一份「岗位说明」（Claude Code 技能） |
| 遇到意外怎么办 | 流程没写到的分支就卡住 | Claude 自己判断、换方案、重试 |
| 能做到多好 | 被流程的设计卡死 | **能力就是 Claude 的上限**，模型升级，整个系统自动变强 |
| 要配什么 | 每个能力一个 API key | 一个 Claude 订阅 |
| 想改流程 | 改节点、改代码 | 改一段文字 |

工作台本身只做两件事：**给 Claude 递工具**（读写账号和素材、截网页、发布到各平台），**给你留看得见、拍得了板的地方**。真正干活的是 Claude Code：它自己上网查资料、自己写代码做视频、自己检查画面、出错了自己修。

### 真实发生过的

做这个 README 里的演示视频时：

- **配音额度用完了**：托管配音的免费额度是 0。没有人写过这个分支，Claude 自己装好本地语音，给鹦鹉、乌龟、狮子三个角色各配了一个声音，把片子做完。
- **一句话返工**：我们觉得配音听不清，在工作台里写了一句「配音听不懂，换成系统中文语音」。Claude 只重配了声音、重新对齐字幕、重新渲染，画面一帧没动，10 分钟交回新版。
- **自己做画面**：角色是它画的原创矢量图；中间穿插的 GitHub 页面、新闻报道、学者博客，是它调研时自己截下来的真网页，还加了荧光笔高亮和红圈。

这些都不是预先写好的流程，是 Claude 当场想出来的。

## 从热点到发布，全程交给 Claude

```
全网热榜 ─→ 精选主题 ─→ 按账号出题 ─→ 调研（带出处）─→ 分镜脚本 ─→ 预审
                                                                │
      数据复盘 ←─ 发到抖音 / 小红书 / B站 / YouTube ←─ 封面和文案 ←─ 成片（配音、字幕、动画）
```

每个箭头都是一次 Claude Code 运行，页面上实时看它每一步在做什么，跑到一半还能插话。你只在三处拍板：做哪个选题、成片行不行、发不发。

- **一个人就是一个 MCN**：多个账号、每个账号多个系列，人群、风格、配音、视觉按系列配置，账号之间不撞车。
- **调研有出处**：写脚本前先上网查真实的价格、能力、步骤和反方观点，每条都有来源；能当画面的网页和官方视频顺手收集成素材。
- **真能发出去**：一键发到抖音、小红书、B站、YouTube，用你自己扫码登录的浏览器，竖横两种封面分别传好。不想自动发的平台勾「手动发」，复制粘贴就行。
- **现成视频也能发**：选一个本机视频（不复制），Claude 先「看」一遍（截画面、听语音），再写各平台的文案。

## 截图

| 账号选题 | 调研和素材 |
|---|---|
| ![账号选题](docs/images/ideas.png) | ![调研](docs/images/research.png) |
| **分镜脚本** | **发布** |
| ![脚本](docs/images/script.png) | ![发布](docs/images/publish.png) |

## 快速开始

只需要一个 Claude 订阅。需要 macOS，并装好：

| 需要 | 安装 |
|---|---|
| [Claude Code](https://claude.com/claude-code) | 装好后在终端运行 `claude` 登录一次 |
| Node.js 22.9+ | `brew install node` |
| Python 3.11+ | macOS 自带，或 `brew install python` |
| Postgres | `brew install postgresql@18 && brew services start postgresql@18`（数据库会自动建好） |
| ffmpeg | `brew install ffmpeg` |
| Google Chrome | 发布时用 |

```bash
git clone https://github.com/ymybxx/SoloMCN.git
cd SoloMCN
npm run setup     # 装 Node 依赖和热点服务的 Python 环境
npx hyperframes skills update faceless-explainer   # 做视频用的 HyperFrames 技能
npm start
```

打开 http://127.0.0.1:5178 ，剩下的都在页面里：

1. **账号矩阵**：改成你自己的账号和系列（首次启动带了 4 个示例账号），各平台点「扫码绑定」。
2. **选题雷达**：点「让 Claude 精选」，开始第一轮。
3. **设置 → 连接**（可选）：
   - 粘贴 `claude setup-token` 生成的长期令牌，后台运行更稳。
   - 填 OpenAI 的 key（或兼容接口的地址和 key），封面由 AI 画；不填就从成片里截一帧。

配音不需要 key：HyperFrames 登录后用托管配音，否则用 macOS 自带的中文语音。

## 改流程 = 改一段文字

每个环节是 `.claude/skills/` 下的一份中文岗位说明：

| 技能 | 负责 |
|---|---|
| `curate-topics` | 从全网热榜里挑值得做的主题 |
| `account-ideas` | 按账号和系列的定位出选题 |
| `research-topic` | 上网调研、收集画面素材 |
| `write-script` | 写可以直接开工的分镜脚本 |
| `precheck-content` | 发布前预审 |
| `make-video` / `revise-video` | 做成片、按意见改片 |
| `review-data` | 看数据复盘 |

想让选题更毒舌、脚本更短、视频换一种画风，直接改对应的技能文件，不用碰代码。这些技能也能在 Claude Code 里手动跑：在项目目录打开 Claude Code，输入 `/curate-topics` 之类。

每个环节用什么模型、想多深，在「设置」里选（Opus、Sonnet、Haiku 等系列和思考强度）。新模型发布后自动用上最新版：**Claude 变强，SoloMCN 就变强。**

## 结构

```
public/            页面（原生 HTML/CSS/JS，无构建步骤）
server/
  agent.js         在后台调起 Claude Code（claude -p）跑技能，实时转发每一步
  mcp.js           递给 Claude 的工具：读账号和素材、写精选、存脚本、截网页……
  publish/         各平台的浏览器发布（抖音、小红书、B站、YouTube）
  assets.js        调研时截网页、存视频素材
  watch.js         「看」本机视频：抽帧拼图、语音转文字
hot-service/       热点数据服务（Python）：抖音、微博、B站、知乎、百度、头条热榜和 Hacker News
.claude/skills/    每个环节的岗位说明
data/              你的数据（账号、内容、登录状态、密钥），只在本机，不进 git
videos/            生成的视频项目，不进 git
```

## 使用前请知道

- 各平台的自动发布是用你登录的浏览器模拟人工操作。平台规则和风控会变，使用者自行承担账号风险；重要账号建议用「手动发」。
- 技能里只保留一条红线：不编造事实、数据和真人言论。其他创作上的取舍交给你。
- 素材、截图、音乐的版权和各平台的内容规范，请自行判断。

## 路线图

- [ ] **AI 员工团队**：把每个环节做成可配置的「员工」——素材员、选题编辑、编剧、剪辑、运营——各有岗位说明、工作方向和预算，员工之间用工单协作，你只管定方向。
- [ ] 定时自动跑：每天自动精选、出题，等你审批。
- [ ] 各平台数据自动回收，复盘闭环。
- [ ] 更多平台：快手、视频号、TikTok。

## 致谢

热榜的做法参考了 [TrendRadar](https://github.com/sansan0/TrendRadar)、[newsnow](https://github.com/ourongxing/newsnow) 和 [DailyHotApi](https://github.com/imsyy/DailyHotApi)；视频生成用的是 [HyperFrames](https://github.com/heygen-com/hyperframes)（Apache-2.0）。

## License

[MIT](LICENSE)
