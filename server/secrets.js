// 页面「设置」里填的连接信息（密钥、接口地址），存在 data/secrets.json：只有本机账号能读，不进 git。
// 接口只返回末 4 位，不把密钥本身发给页面。环境变量仍然认，页面上没填时才用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'secrets.json');
export const IMAGE_DEFAULTS = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-image-1' };

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function write(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  fs.chmodSync(FILE, 0o600);
}

// 图片生成（任何 OpenAI 兼容的 /images/generations 接口）
export function imageConfig() {
  const s = read().image || {};
  return {
    baseUrl: (s.baseUrl || process.env.IMAGE_BASE_URL || IMAGE_DEFAULTS.baseUrl).replace(/\/$/, ''),
    apiKey: s.apiKey || process.env.IMAGE_API_KEY || '',
    model: s.model || process.env.IMAGE_MODEL || IMAGE_DEFAULTS.model,
  };
}

// Claude Code 的长期令牌（claude setup-token 生成）；不填就用本机 claude 的登录状态
export const claudeToken = () => read().claude?.token || process.env.CLAUDE_CODE_OAUTH_TOKEN || '';

const tail = (k) => (k ? k.slice(-4) : null);

// 给页面看的：有没有配、末 4 位、非密钥的设置
export function publicConfig() {
  const img = imageConfig();
  return {
    image: { configured: !!img.apiKey, tail: tail(img.apiKey), baseUrl: img.baseUrl, model: img.model },
    claude: { tokenSet: !!claudeToken(), tail: tail(claudeToken()) },
  };
}

// apiKey 不传（或传空）表示保留原来的 key，只改地址和模型
export function setImage({ baseUrl, apiKey, model } = {}) {
  const d = read();
  const cur = d.image || {};
  const url = String(baseUrl ?? cur.baseUrl ?? '').trim();
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw Object.assign(new Error('接口地址要以 http:// 或 https:// 开头'), { status: 400 });
  d.image = { baseUrl: url || undefined, apiKey: String(apiKey || '').trim() || cur.apiKey, model: String(model ?? cur.model ?? '').trim() || undefined };
  write(d);
  return publicConfig();
}

export function clearImage() {
  const d = read();
  delete d.image;
  write(d);
  return publicConfig();
}

export function setClaudeToken(token) {
  const t = String(token || '').trim();
  if (!/^[A-Za-z0-9_\-.]{20,400}$/.test(t)) throw Object.assign(new Error('令牌格式不对：在终端运行 claude setup-token，把最后打印出的那一串完整粘贴过来'), { status: 400 });
  const d = read();
  d.claude = { token: t };
  write(d);
  return publicConfig();
}

export function clearClaudeToken() {
  const d = read();
  delete d.claude;
  write(d);
  return publicConfig();
}
