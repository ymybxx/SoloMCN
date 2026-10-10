#!/usr/bin/env bash
# SoloMCN 一键安装（macOS）：
#   curl -fsSL https://raw.githubusercontent.com/ymybxx/SoloMCN/main/install.sh | bash
# 装好缺的软件（Homebrew、Node、Python、ffmpeg、Chrome、Claude Code），下载 SoloMCN，装依赖，然后启动。
# 已经装好的都会跳过，可以重复运行。装到哪：默认 ~/SoloMCN，用 SOLOMCN_DIR 指定别的目录。
set -euo pipefail

REPO="${SOLOMCN_REPO:-https://github.com/ymybxx/SoloMCN.git}"
BRANCH="${SOLOMCN_BRANCH:-main}"
DIR="${SOLOMCN_DIR:-$HOME/SoloMCN}"
PORT="${PORT:-5178}"
export PORT
say() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok() { printf '  ✓ %s\n' "$1"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "目前只支持 macOS"

say "Homebrew"
if ! command -v brew >/dev/null 2>&1; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "  没装 Homebrew，现在安装（会让你输一次开机密码，这是 Homebrew 自己的要求）"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)" && break; done
fi
command -v brew >/dev/null 2>&1 || die "Homebrew 没装上，装好后重新运行这条命令"
ok "Homebrew"

say "Node、Python、ffmpeg、git"
# Node 要 22.9 以上，Python 要 3.11 以上（macOS 自带的 3.9 太旧）
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=9)?0:1)'; }
py_ok() { for p in python3.13 python3.12 python3.11 python3.14 python3; do command -v "$p" >/dev/null 2>&1 && "$p" -c 'import sys;sys.exit(0 if sys.version_info>=(3,11) else 1)' 2>/dev/null && return 0; done; return 1; }
node_ok || brew install node
py_ok || brew install python
command -v ffmpeg >/dev/null 2>&1 || brew install ffmpeg
command -v git >/dev/null 2>&1 || brew install git
ok "node $(node -v)、ffmpeg、git"

say "Google Chrome（发布到各平台时用）"
if [ -d "/Applications/Google Chrome.app" ]; then ok "已经装了"; else brew install --cask google-chrome && ok "Google Chrome"; fi

say "Claude Code"
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi
command -v claude >/dev/null 2>&1 || die "Claude Code 没装上，见 https://code.claude.com/docs/en/setup"
ok "$(claude --version 2>/dev/null | head -1)"

say "下载 SoloMCN 到 $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only || echo "  （更新失败，先用现有版本）"
else
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"
ok "$DIR"

say "装项目依赖"
SOLOMCN_INSTALLER=1 node scripts/setup.mjs

say "检查 Claude Code 登录"
if claude auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  ok "已登录"
else
  printf '  还没登录 Claude Code：现在会打开登录，用你的 Claude 订阅账号登录，登录好后输入 /exit 退出，安装会接着进行。\n'
  claude </dev/tty || true
fi

say "启动"
printf '  工作台地址：http://127.0.0.1:%s（以后启动：cd %s && npm start）\n' "$PORT" "$DIR"
[ -n "${SOLOMCN_NO_OPEN:-}" ] || (sleep 4 && open "http://127.0.0.1:$PORT") >/dev/null 2>&1 &
exec npm start
