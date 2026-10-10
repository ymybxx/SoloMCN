// 拉 YouTube 字幕用的登录（可选）：不带登录拉字幕被 YouTube 要求“登录以确认不是机器人”时，
// 热点服务会用这里导出的 cookie 再试一次。登录和发布时一样：在弹出的 Chrome 里自己登录 Google 账号，点「我已登录」。
// cookie 导出成 yt-dlp 认的 Netscape 格式，存在 data/youtube-cookies.txt（只有本机账号能读，不进 git）。
import fs from 'node:fs';
import path from 'node:path';
import { createBrowserAccounts } from './publish/browser.js';

const ACC = 'default';
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F';
const HOME = 'https://www.youtube.com/';
// 只导出 YouTube 和 Google 登录要用的 cookie
const COOKIE_SITES = ['https://www.youtube.com', 'https://youtube.com', 'https://accounts.google.com', 'https://www.google.com'];

// 登录后右上角是头像；没登录是「登录」按钮
async function loggedIn(page) {
  if (!page.url().includes('youtube.com')) return false;
  const avatar = page.locator('#avatar-btn, button#avatar-btn, ytd-topbar-menu-button-renderer #avatar-btn').first();
  return avatar.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
}

export function netscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# SoloMCN 导出，给 yt-dlp 拉字幕用，不要分享', ''];
  for (const c of cookies) {
    const sub = c.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const expires = c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push([(c.httpOnly ? '#HttpOnly_' : '') + c.domain, sub, c.path || '/', c.secure ? 'TRUE' : 'FALSE', expires, c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export function createYtLogin({ root }) {
  const acc = createBrowserAccounts({ dataDir: path.join(root, 'data'), key: 'youtube-source', name: 'YouTube', app: 'Google 账号', loginUrl: LOGIN_URL, checkUrl: HOME, loggedIn, debugPort: false });
  const cookieFile = path.join(root, 'data', 'youtube-cookies.txt');

  // 后台打开登录过的 Chrome 配置，把 cookie 导出给 yt-dlp
  async function exportCookies() {
    const ctx = await acc.openProfile(ACC, true);
    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (!(await loggedIn(page))) throw new Error('YouTube 没有登录，重新登录一次');
      const cookies = await ctx.cookies(COOKIE_SITES);
      fs.writeFileSync(cookieFile, netscape(cookies), { mode: 0o600 });
      fs.chmodSync(cookieFile, 0o600);
      return cookies.length;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // 登录窗口关掉、确认登录成功后，接着导出 cookie；页面轮询这里，直到 exported 有结果
  const exported = new Map(); // 登录 id -> 'running' | { ok, message }
  function progress(id) {
    const st = acc.loginStatus(id);
    if (!st) return null;
    if (st.status === 'done' && !exported.has(id)) {
      exported.set(id, 'running');
      exportCookies().then(() => exported.set(id, { ok: true }), (err) => exported.set(id, { ok: false, message: err.message.split('\n')[0] }));
    }
    return { ...st, exported: exported.get(id) || null };
  }

  async function check() {
    const r = await acc.check(ACC);
    if (r.ok) await exportCookies();
    else fs.rmSync(cookieFile, { force: true });
    return r;
  }

  function logout() {
    acc.unbind(ACC);
    fs.rmSync(cookieFile, { force: true });
    return { ok: true };
  }

  return {
    cookieFile,
    status: () => ({ ...acc.status(ACC), cookies: fs.existsSync(cookieFile) }),
    start: () => acc.startLogin(ACC),
    finish: () => acc.finishLogin(ACC),
    progress,
    check,
    logout,
  };
}
