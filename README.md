<div align="center">

# SoloMCN

**把 Claude Code 变成你的短视频团队：从全网热点到多平台发布，一个人运营一个账号矩阵。**

[English](README.en.md) · MIT License · Powered by [Claude Code](https://claude.com/claude-code)

</div>

![SoloMCN 工作台](docs/images/hero.png)

## 它能做什么

一条 AI 短视频从无到有，SoloMCN 全程接管，你只需要在关键处点头：

```
全网热榜 ─→ Claude 精选 ─→ 按账号出题 ─→ 调研（带出处）─→ 分镜脚本 ─→ AI 预审
                                                                    │
      数据复盘 ←─ 一键发到抖音 / 小红书 / B站 / YouTube ←─ 封面和文案 ←─ 成片（配音、字幕、动画）
```

- **一个人就是一个 MCN**：多个账号、每个账号多个系列，人群、风格、配音、视觉都按系列配置。选题、脚本、成片都贴着系列走，账号之间不撞车。
- **大脑是 Claude Code**：所有 AI 环节都由你本机的 Claude Code 在后台跑，用你自己的 Claude 订阅，**不用另外申请任何 AI 的 API key**。每一步做了什么，页面上实时可见，跑到一半还能插话。
- **调研有出处**：写脚本前，Claude 先上网查真实的价格、能力、步骤和反方观点，每条都有来源；同时把能当画面的网页截图、官方视频收集成素材，成片里用的是真东西。
- **真能发出去**：一键发到抖音、小红书、B站、YouTube。用你自己扫码登录的浏览器，按页面状态一步步操作。不想自动发的平台，勾「手动发」，工作台把视频、封面、标题、正文、话题都备好，复制粘贴就行。
- **现成视频也能发**：选一个本机视频（不复制、不占空间），Claude 会先「看」一遍（截画面、听语音），再写各平台的发布文案。
- **能改的「岗位说明」**：每个环节是一个 Claude Code 技能（`.claude/skills/`），用中文写成。想换选题口味、脚本风格、视频做法，直接改技能文件。

## 截图

| 账号选题 | 调研和素材 |
|---|---|
| ![账号选题](docs/images/ideas.png) | ![调研](docs/images/research.png) |
| **分镜脚本** | **发布** |
| ![脚本](docs/images/script.png) | ![发布](docs/images/publish.png) |

## 快速开始

需要 macOS，并装好这几样：

| 需要 | 安装 |
|---|---|
| [Claude Code](https://claude.com/claude-code) | 装好后在终端运行 `claude` 登录一次（用你的 Claude 订阅） |
| Node.js 22.9+ | `brew install node` |
| Python 3.11+ | macOS 自带，或 `brew install python` |
| Postgres | `brew install postgresql@18 && brew services start postgresql@18`（数据库会自动建好） |
| ffmpeg | `brew install ffmpeg` |
| Google Chrome | 发布时用 |

然后：

```bash
git clone https://github.com/ymybxx/SoloMCN.git
cd SoloMCN
npm run setup     # 装 Node 依赖和热点服务的 Python 环境
npm start
```

打开 http://127.0.0.1:5178 ，剩下的都在页面里配：

1. **账号矩阵**：改成你自己的账号和系列（首次启动带了 4 个示例账号），各平台点「扫码绑定」。
2. **设置 → 连接**（都是可选的）：
   - Claude 长期令牌：在终端运行 `claude setup-token` 生成，粘贴进来，后台运行更稳。不填就用本机 `claude` 的登录。
   - 图片生成：填 OpenAI 的 key（或任何兼容接口的地址和 key），封面就由 AI 画；不填就从成片里截一帧当封面。
3. 回到 **选题雷达**，点「让 Claude 精选」，开始第一轮。

视频由 [HyperFrames](https://github.com/heygen-com/hyperframes) 生成，第一次生成视频前装一下它的 Claude Code 技能：

```bash
npx hyperframes skills update faceless-explainer
```

配音用 HyperFrames 的配音：登录（`npx hyperframes login`）后用托管配音，没登录用本地语音，都不需要另外的 key；都不可用时做成字幕版。

## 怎么运作

```
public/            页面（原生 HTML/CSS/JS，无构建步骤）
server/
  index.js         HTTP 服务和接口
  agent.js         在后台调起 Claude Code（claude -p）跑技能，实时转发每一步
  mcp.js           给 Claude 用的工作台工具（读账号、读素材、写精选、存脚本……）
  publish/         各平台的浏览器发布（抖音、小红书、B站、YouTube）
  assets.js        调研时截网页、存视频素材
  watch.js         「看」本机视频：抽帧拼图、语音转文字
hot-service/       热点数据服务（Python）：抖音、微博、B站、知乎、百度、头条热榜和 Hacker News
.claude/skills/    每个环节的 Claude 技能：精选、出题、调研、写脚本、预审、做视频、改视频、复盘
data/              你的数据（账号、内容、登录状态、密钥），不进 git
videos/            生成的视频项目，不进 git
```

- **数据只在你本机**：账号和内容存在 `data/db.json`；各平台的登录状态存在 `data/publish/` 下每个账号单独的 Chrome 配置里；密钥存在 `data/secrets.json`（只有你的系统账号能读）。
- **每个功能用什么模型、想多深**在「设置」里选（Opus、Sonnet、Haiku 等系列和思考强度），新模型发布后自动跟上。
- **技能也能在 Claude Code 里手动跑**：在项目目录打开 Claude Code，输入 `/curate-topics` 之类。

## 使用前请知道

- 各平台的自动发布是用你登录的浏览器模拟人工操作。平台规则和风控会变，使用者自行承担账号风险；重要账号建议用「手动发」。
- 技能里只保留一条红线：不编造事实、数据和真人言论。其他创作上的取舍交给你。
- 素材、截图、音乐的版权和各平台的内容规范，请自行判断。

## 路线图

- [ ] **AI 员工团队**：把每个环节做成可配置的「员工」——素材员、选题编辑、编剧、剪辑、运营——各有岗位说明、工作方向和预算，员工之间用工单协作。
- [ ] 定时自动跑：每天自动精选、出题，等你审批。
- [ ] 各平台数据自动回收，复盘闭环。
- [ ] 更多平台：快手、视频号、TikTok。

## 致谢

热榜的做法参考了 [TrendRadar](https://github.com/sansan0/TrendRadar)、[newsnow](https://github.com/ourongxing/newsnow) 和 [DailyHotApi](https://github.com/imsyy/DailyHotApi)；视频生成用的是 [HyperFrames](https://github.com/heygen-com/hyperframes)（Apache-2.0）。

## License

[MIT](LICENSE)
