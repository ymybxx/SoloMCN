<div align="center">

# SoloMCN

**Turn Claude Code into your short-video team: from trending topics to multi-platform publishing, one person runs a whole channel network.**

[中文](README.md) · MIT License · Powered by [Claude Code](https://claude.com/claude-code)

</div>

![SoloMCN workbench](docs/images/hero.png)

## What it does

SoloMCN takes an AI short video from nothing to published. You only approve at the key steps:

```
Trending lists ─→ Claude curation ─→ Ideas per channel ─→ Sourced research ─→ Storyboard script ─→ AI precheck
                                                                                          │
   Analytics ←─ One-click publish to Douyin / Xiaohongshu / Bilibili / YouTube ←─ Cover & copy ←─ Finished video
```

- **A one-person MCN.** Several channels, each with several series. Audience, tone, voice and visual style live on the series, so ideas, scripts and videos stay on-brand and channels don't overlap.
- **Claude Code is the brain.** Every AI step runs through the Claude Code on your machine, on your own Claude subscription. **No extra AI API key required.** You watch each step live and can interject mid-run.
- **Research with sources.** Before writing, Claude looks up real prices, capabilities, steps and counter-arguments, each with a source, and captures web pages and official videos as footage for the edit.
- **It actually publishes.** One click to Douyin, Xiaohongshu, Bilibili and YouTube, using a browser you logged into yourself and driven by page state. For platforms you'd rather post by hand, tick "manual" and get the video, cover, title, description and tags ready to copy and paste.
- **Bring your own video.** Pick a local file (not copied). Claude "watches" it (frames plus speech-to-text) and writes the copy for each platform.
- **Editable job descriptions.** Each step is a Claude Code skill in `.claude/skills/`, written in plain language. Change the taste, the script style or how videos are made by editing the skill.

## Screenshots

| Ideas per channel | Research & footage |
|---|---|
| ![Ideas](docs/images/ideas.png) | ![Research](docs/images/research.png) |
| **Storyboard script** | **Publishing** |
| ![Script](docs/images/script.png) | ![Publish](docs/images/publish.png) |

## Quick start

macOS, plus:

| Need | Install |
|---|---|
| [Claude Code](https://claude.com/claude-code) | Install it and run `claude` once to log in with your Claude subscription |
| Node.js 22.9+ | `brew install node` |
| Python 3.11+ | Comes with macOS, or `brew install python` |
| Postgres | `brew install postgresql@18 && brew services start postgresql@18` (the database is created for you) |
| ffmpeg | `brew install ffmpeg` |
| Google Chrome | Used for publishing |

Then:

```bash
git clone https://github.com/ymybxx/SoloMCN.git
cd SoloMCN
npm run setup     # Node dependencies and the Python env for the trends service
npm start
```

Open http://127.0.0.1:5178 and configure everything in the app:

1. **Channels** (账号矩阵): replace the 4 sample channels with your own, and scan the QR code to bind each platform.
2. **Settings → Connections** (all optional):
   - Claude long-lived token: run `claude setup-token` and paste it for more reliable background runs. Without it, the local `claude` login is used.
   - Image generation: an OpenAI key (or any compatible endpoint and key) lets AI draw covers. Without it, covers are taken from a frame of the video.
3. Go to the **Topic radar** and click "Let Claude curate".

Videos are rendered with [HyperFrames](https://github.com/heygen-com/hyperframes). Before your first video, install its Claude Code skill:

```bash
npx hyperframes skills update faceless-explainer
```

Voice-over uses HyperFrames: hosted voices after `npx hyperframes login`, or a local voice otherwise. No extra key either way; if neither works the video is captions-only.

## How it works

```
public/            UI (plain HTML/CSS/JS, no build step)
server/
  index.js         HTTP server and API
  agent.js         Runs Claude Code (claude -p) skills in the background and streams each step
  mcp.js           Workbench tools for Claude (read channels and trends, save picks, scripts…)
  publish/         Browser publishing for Douyin, Xiaohongshu, Bilibili, YouTube
  assets.js        Captures web pages and videos as footage during research
  watch.js         "Watches" local videos: frame sheets plus speech-to-text
hot-service/       Trends service (Python): Douyin, Weibo, Bilibili, Zhihu, Baidu, Toutiao and Hacker News
.claude/skills/    One skill per step: curate, ideas, research, script, precheck, make video, revise, review
data/              Your data (channels, content, logins, keys), never committed
videos/            Generated video projects, never committed
```

- **Your data stays local.** Content lives in `data/db.json`, platform logins in per-channel Chrome profiles under `data/publish/`, keys in `data/secrets.json` (readable only by your user).
- **Pick the model and effort per feature** in Settings (Opus, Sonnet, Haiku…). New model versions are picked up automatically.
- **Run skills by hand** in Claude Code: open the project and type `/curate-topics` and so on.

## Before you use it

- Publishing drives your own logged-in browser. Platform rules change; you are responsible for your accounts. Use "manual" for accounts you care about most.
- The skills keep one hard rule: never fabricate facts, numbers or quotes from real people. Everything else is your call.
- You are responsible for rights to footage, screenshots and music, and for each platform's content rules.

## Roadmap

- [ ] **AI staff**: each step becomes a configurable "employee" (scout, editor, writer, video editor, operator) with a job description, direction and budget, working together through tickets.
- [ ] Scheduled runs: daily curation and ideas waiting for your approval.
- [ ] Automatic analytics collection from each platform.
- [ ] More platforms: Kuaishou, WeChat Channels, TikTok.

## Credits

Trending-list approach inspired by [TrendRadar](https://github.com/sansan0/TrendRadar), [newsnow](https://github.com/ourongxing/newsnow) and [DailyHotApi](https://github.com/imsyy/DailyHotApi). Videos are rendered with [HyperFrames](https://github.com/heygen-com/hyperframes) (Apache-2.0).

## License

[MIT](LICENSE)
