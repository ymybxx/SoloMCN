// 首次打开时的环境检查：哪些还没装好，页面上提示怎么处理，不让人跑到一半才报错。
// 结果缓存一分钟；页面上点「重新检查」会强制刷新。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeBin, cliEnv } from './cli.js';
import { CHROME } from './publish/browser.js';
import { claudeToken } from './secrets.js';

const run = promisify(execFile);
const which = (cmd) => run('which', [cmd]).then(() => true, () => false);

export function createSetupCheck({ hotUrl }) {
  let cache = null;

  async function claudeState() {
    const bin = claudeBin();
    // claudeBin() 找不到时会退回字面上的 'claude'，这时再确认一下 PATH 里有没有
    if (bin === 'claude' && !(await which('claude'))) return { id: 'claude', ok: false, title: 'Claude Code 没装', fix: '所有 AI 环节都靠它。在终端运行：curl -fsSL https://claude.ai/install.sh | bash' };
    if (claudeToken()) return { id: 'claude', ok: true, title: 'Claude Code（长期令牌）' };
    try {
      const { stdout } = await run(bin, ['auth', 'status'], { env: cliEnv(), timeout: 15_000 });
      if (JSON.parse(stdout).loggedIn) return { id: 'claude', ok: true, title: 'Claude Code 已登录' };
    } catch {}
    return { id: 'claude', ok: false, title: 'Claude Code 没登录', fix: '在终端运行 claude，按提示用你的 Claude 订阅账号登录；想更稳，运行 claude setup-token，把令牌粘贴到「设置 → 连接」' };
  }

  async function check(force = false) {
    if (!force && cache && Date.now() - cache.at < 60_000) return cache;
    const [claude, ffmpeg, ffprobe, hot] = await Promise.all([
      claudeState(),
      which('ffmpeg'),
      which('ffprobe'),
      fetch(hotUrl + '/health', { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false),
    ]);
    const items = [
      claude,
      ffmpeg && ffprobe
        ? { id: 'ffmpeg', ok: true, title: 'ffmpeg' }
        : { id: 'ffmpeg', ok: false, title: '缺 ffmpeg', fix: '做视频、裁封面都要用。在终端运行：brew install ffmpeg' },
      fs.existsSync(CHROME)
        ? { id: 'chrome', ok: true, title: 'Google Chrome' }
        : { id: 'chrome', ok: false, title: '缺 Google Chrome', fix: '发布到各平台时要用。在终端运行：brew install --cask google-chrome' },
      fs.existsSync(path.join(os.homedir(), '.claude', 'skills', 'faceless-explainer'))
        ? { id: 'hyperframes', ok: true, title: 'HyperFrames 技能' }
        : { id: 'hyperframes', ok: false, title: '缺做视频用的 HyperFrames 技能', fix: '在项目目录运行：npx hyperframes skills update faceless-explainer' },
      hot
        ? { id: 'hot', ok: true, title: '热点数据服务' }
        : { id: 'hot', ok: false, title: '热点数据服务没启动', fix: '在项目目录运行 npm run setup 装好 Python 环境，再重新 npm start' },
    ];
    cache = { at: Date.now(), ok: items.every((x) => x.ok), items };
    return cache;
  }

  return { check };
}
