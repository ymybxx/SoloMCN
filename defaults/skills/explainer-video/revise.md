# 解说视频：修改视频

## 1. 找到要改的地方

1. `item.video.project` 是 HyperFrames 项目目录（相对当前工作目录），`item.video.mp4` 是当前版本。读项目的 `BRIEF.md`、`STORYBOARD.md`，了解这条视频。
2. 意见里带了时间点（例如 `[61.2 秒]`）：运行 `npx hyperframes timeline --json` 找到那个时间点所在的分镜和元素。时间点指的是**当前版本的成片**。没带时间点：按描述的内容（文字、画面）在 `compositions/frames/` 和 `index.html` 里找。
3. 改之前先截一张图看清现状：`npx hyperframes snapshot --at <时间点>`。

## 2. 只改提到的地方

这是对已有项目的**定点修改**，按 `/hyperframes` 的"对现有项目的具体修改"处理：直接改，不跑完整的生成流程，不重新规划分镜。

- 改动前读 `/hyperframes-core`，涉及动画读 `/hyperframes-animation`，涉及声音读 `/hyperframes-audio`
- 只动和意见有关的文件和元素，其他分镜、配音、音乐保持原样
- 意见要求补真实画面（价格、规则、产品页、帖子、演示视频）时，按 `references/assets.md` 做：先用 `get_item` 的 `assets`，不够就用 `npx hyperframes capture` 截公开网页或取页面视频，网址和日期记后台 notes，不加成画面脚注
- 意见要求改台词或配音时，只重新合成受影响的那几句，并同步时长和字幕。配音按 `/voice-over` 技能做，用和原片相同的方式和音色（看项目里的 `audio_meta.json` 或备注）；意见是「听不懂」「配音不自然」之类的，按 `/voice-over` 里的顺序换一种方式整段重配，再重新对齐字幕

## 3. 只重做改动的那几秒

整条重新渲染要十几分钟，小改不值得。先判断改动影响到哪里：

- **只换了声音、时长没变**（改一个读音、换一句配音、调音量）：画面不用重渲。把新的整条音轨混好（配音、配乐、音效），用 ffmpeg 直接替换旧成片的音轨（`-map 0:v -map 1:a -c:v copy`）。有解说员时，嘴型跟着配音，只重画那一句所在的那段角色层（`presenter.mjs` 只重画变了的部分），再叠到不带解说员的底片（`renders/video-base.mp4`）上。
- **只改了一两个镜头的画面、时长没变**：只渲染这几个镜头（`npx hyperframes render -c compositions/frames/<那一镜>.html -o renders/part-<n>.mp4`），按 STORYBOARD 的起点替换进旧成片的对应时段（ffmpeg 按帧切开、拼回，再套上原来的音轨）；拼接处前后各截一帧确认没有跳帧、黑帧。
- **时长变了，或者改动散在全片**：整条重新渲染。

拿不准就整条渲染，宁可慢也不要拼出接缝。notes 里写明是局部重做还是整条渲染。

## 4. 检查和渲染新版本

1. 改完运行 `npx hyperframes lint` 和 `npx hyperframes check`，再对改过的时间点截图确认效果。
2. 输出成**新文件**，不要覆盖旧版本：看 `renders/` 里已有哪些，取下一个版本号，例如 `renders/video-v2.mp4`（整条渲染用 `npx hyperframes render --quality high --output renders/video-v2.mp4`）。

然后回到 revise-video 的登记和汇报。
