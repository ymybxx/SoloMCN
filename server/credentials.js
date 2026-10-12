// 你在平台上配过的钥匙和登录，每次运行都直接交给 Claude：放进环境变量（登录导出成 cookie 文件，给 yt-dlp 这类工具直接用），
// 提示里列出有哪些、叫什么名字。以后多配一个，这里多导出一个，技能里按名字用，平台不用为它写专门的工具。
import fs from 'node:fs';
import path from 'node:path';
import { imageConfig, claudeToken } from './secrets.js';

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// B站存的是一整串请求头里的 cookie（k=v; k2=v2），yt-dlp 要的是 Netscape 格式的 cookie 文件
function netscape(header, domain) {
  const lines = ['# Netscape HTTP Cookie File', '# 由 SoloMCN 从渠道里的登录导出，每次运行前重写'];
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    lines.push([domain, 'TRUE', '/', 'TRUE', '2147483647', part.slice(0, i).trim(), part.slice(i + 1).trim()].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export function credentials(root) {
  const env = {};
  const notes = [];
  const out = path.join(root, 'data', 'credentials');
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });

  const token = claudeToken();
  // Claude Code 不会把自己的登录变量传给它执行的命令，换个名字给，命令里开 Claude Code 时再接上
  if (token) { env.SOLOMCN_CLAUDE_TOKEN = token; notes.push('SOLOMCN_CLAUDE_TOKEN：你的 Claude 订阅登录。要看 Claude 怎么回答、让 Claude Code 跑一个任务时，在命令行里 `CLAUDE_CODE_OAUTH_TOKEN=$SOLOMCN_CLAUDE_TOKEN claude -p …`'); }

  const img = imageConfig();
  if (img.apiKey) { Object.assign(env, { IMAGE_API_KEY: img.apiKey, IMAGE_BASE_URL: img.baseUrl, IMAGE_MODEL: img.model }); notes.push(`IMAGE_API_KEY、IMAGE_BASE_URL、IMAGE_MODEL：生图服务（${img.baseUrl}，模型 ${img.model}），OpenAI 兼容的图片接口`); }

  const local = readJson(path.join(root, '.claude', 'settings.local.json'))?.env || {};
  if (local.DASHSCOPE_API_KEY) { env.DASHSCOPE_API_KEY = local.DASHSCOPE_API_KEY; notes.push('DASHSCOPE_API_KEY：通义（阿里云百炼），配音用'); }

  const yt = readJson(path.join(root, 'hot-service', 'data', 'youtube-key.json'))?.key;
  if (yt) { env.YOUTUBE_API_KEY = yt; notes.push('YOUTUBE_API_KEY：YouTube 官方数据接口'); }
  const ytCookies = path.join(root, 'data', 'youtube-cookies.txt');
  if (fs.existsSync(ytCookies)) { env.YOUTUBE_COOKIES_FILE = ytCookies; notes.push('YOUTUBE_COOKIES_FILE：YouTube 的登录（cookie 文件），`yt-dlp --cookies $YOUTUBE_COOKIES_FILE`'); }

  const bili = readJson(path.join(root, 'data', 'bilibili-cookies.json'));
  if (bili?.cookie) {
    const f = path.join(out, 'bilibili.txt');
    fs.writeFileSync(f, netscape(bili.cookie, '.bilibili.com'), { mode: 0o600 });
    Object.assign(env, { BILIBILI_COOKIE: bili.cookie, BILIBILI_COOKIES_FILE: f });
    notes.push(`BILIBILI_COOKIES_FILE、BILIBILI_COOKIE：B站的登录（账号 ${bili.uname || '已登录'}${bili.vip ? '，大会员' : ''}），下 1080P 以上用 \`yt-dlp --cookies $BILIBILI_COOKIES_FILE\`，自己发请求时把 BILIBILI_COOKIE 放进 Cookie 请求头`);
  }
  return { env, prompt: notes.length ? `你可以直接用的钥匙和登录（已经在环境变量里，命令里按名字引用）：\n- ${notes.join('\n- ')}` : '' };
}
