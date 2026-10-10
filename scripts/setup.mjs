#!/usr/bin/env node
// 装好运行需要的项目依赖：Node 依赖、热点服务的 Python 环境、做视频用的 HyperFrames 技能。
// 系统软件（Node、Python、ffmpeg、Chrome、Claude Code）由 install.sh 负责装；这里只检查，缺了给出提示。
// 可以重复运行：已经装好的会跳过或更新。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOT = path.join(ROOT, 'hot-service');
const VENV_PY = path.join(HOT, '.venv', 'bin', 'python');
const ok = (m) => console.log(`  ✓ ${m}`);
const warn = (m) => console.log(`  ! ${m}`);
const step = (m) => console.log(`\n▸ ${m}`);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 失败（退出代码 ${r.status}）`);
};
const has = (cmd) => spawnSync('which', [cmd]).status === 0;

// macOS 自带的 python3 是 3.9，太旧；按顺序找一个 3.11 以上的
function findPython() {
  for (const c of ['python3.13', 'python3.12', 'python3.11', 'python3.14', 'python3']) {
    if (!has(c)) continue;
    try {
      const [maj, min] = execFileSync(c, ['-c', 'import sys;print(*sys.version_info[:2])'], { encoding: 'utf8' }).trim().split(' ').map(Number);
      if (maj === 3 && min >= 11) return c;
    } catch {}
  }
  return null;
}

try {
  step('Node 依赖');
  run('npm', ['install', '--no-fund', '--no-audit']);
  ok('npm install');

  step('热点服务的 Python 环境');
  const py = findPython();
  if (!py) throw new Error('没找到 Python 3.11 或更新的版本：运行 brew install python 后再试');
  if (!fs.existsSync(VENV_PY)) run(py, ['-m', 'venv', '.venv'], { cwd: HOT });
  run(VENV_PY, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', '-r', 'requirements.txt'], { cwd: HOT });
  ok(`hot-service/.venv（${py}）`);

  step('做视频用的 HyperFrames 技能');
  // SOLOMCN_SKIP_HF：离线或测试时跳过（不去更新已经装好的 HyperFrames 技能）
  const hf = process.env.SOLOMCN_SKIP_HF ? { status: 0 } : spawnSync('npx', ['-y', 'hyperframes', 'skills', 'update', 'faceless-explainer'], { stdio: 'inherit', cwd: ROOT });
  if (hf.status === 0) ok(process.env.SOLOMCN_SKIP_HF ? 'faceless-explainer（跳过）' : 'faceless-explainer');
  else warn('HyperFrames 技能没装上，做视频前在项目目录运行：npx hyperframes skills update faceless-explainer');

  step('检查其他软件');
  has('ffmpeg') && has('ffprobe') ? ok('ffmpeg') : warn('缺 ffmpeg：做视频、裁封面都要用，运行 brew install ffmpeg');
  fs.existsSync('/Applications/Google Chrome.app') || process.env.CHROME_PATH ? ok('Google Chrome') : warn('缺 Google Chrome：发布到各平台时要用，运行 brew install --cask google-chrome');
  has('claude') ? ok('Claude Code') : warn('缺 Claude Code：所有 AI 环节都靠它，见 https://claude.com/claude-code');

  // 一键安装（install.sh）调用时不提示：它接下来会检查登录、自动启动
  if (!process.env.SOLOMCN_INSTALLER) console.log(`\n装好了。运行 npm start，打开 http://127.0.0.1:${process.env.PORT || 5178}`);
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exit(1);
}
