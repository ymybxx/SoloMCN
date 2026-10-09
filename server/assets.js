// 调研时收集的真实素材：打开公开网页截图，需要时把页面里的视频文件也存下来，做视频时直接用。
// 用一个干净的无界面 Chrome（不用任何平台账号的登录配置），文件存在 videos/_assets/<内容 id>/，页面通过 /media/ 能直接看。
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { chromium } from 'playwright-core';
import { CHROME } from './publish/browser.js';

const MAX_FULL_HEIGHT = 5000; // 整页截图最多截这么高（CSS 像素），太长的页面只截前面
const MAX_VIDEO_BYTES = 80 * 1024 * 1024;
const MAX_VIDEOS = 2;
const VIDEO_EXT = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// 只截公网页面：本机和内网地址不截
function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('网址不对');
  }
  if (!/^https?:$/.test(u.protocol)) throw badRequest('只支持 http / https 网址');
  const h = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(h) || h.endsWith('.local') || h.endsWith('.localhost')) {
    throw badRequest('不能截本机或内网地址');
  }
  return u;
}

async function downloadVideo(src, file) {
  const res = await fetch(src, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!res.ok || !VIDEO_EXT[type]) return null;
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_VIDEO_BYTES) return null;
  const out = file + VIDEO_EXT[type];
  let seen = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    seen += c.length;
    if (seen > MAX_VIDEO_BYTES) body.destroy(new Error('too large'));
  });
  try {
    await pipeline(body, fs.createWriteStream(out));
  } catch {
    fs.rmSync(out, { force: true });
    return null;
  }
  return out;
}

// 页面上有没有验证码、人机验证：整页是验证墙，或者有一个可见的验证弹窗。有就不截（不去绕过或破解验证）
const BLOCKED = () => {
  const hint = /安全验证|拖动下方滑块|完成拼图|人机验证|请完成验证|访问验证|滑动验证|captcha|verify you are human|are you a robot|checking your browser|just a moment/i;
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 40 && r.height > 40 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  if ([...document.querySelectorAll('[id*="captcha" i], [class*="captcha" i], iframe[src*="captcha" i], iframe[src*="challenge" i]')].some(visible)) return true;
  for (const el of document.querySelectorAll('body *')) {
    const pos = getComputedStyle(el).position;
    if ((pos === 'fixed' || pos === 'absolute') && visible(el) && hint.test((el.innerText || '').slice(0, 300))) return true;
  }
  const t = (document.body?.innerText || '').trim();
  return hint.test(t.slice(0, 3000)) && t.length < 2000;
};

// 藏掉盖在页面中间的悬浮层和全屏遮罩；顶部导航条、侧边小工具不动；装着大段正文的容器不动（有的网站整页就是一个 fixed 容器）
const CLEAR_OVERLAYS = () => {
  const vw = innerWidth, vh = innerHeight, cx = vw / 2, cy = vh / 2;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) continue;
    if (r.top <= 0 && r.height < 160 && r.width > vw * 0.8) continue; // 顶部导航
    if ((el.innerText || '').length > 2000) continue; // 正文容器
    const overCenter = r.left < cx && r.right > cx && r.top < cy && r.bottom > cy;
    const fullScreen = r.width > vw * 0.9 && r.height > vh * 0.9;
    if (overCenter || fullScreen) el.style.setProperty('display', 'none', 'important');
  }
  for (const el of [document.documentElement, document.body]) {
    el.style.setProperty('overflow', 'auto', 'important');
    el.style.setProperty('position', 'static', 'important');
  }
};

let queue = Promise.resolve(); // 一次只开一个 Chrome

/**
 * 截一个网页。返回 { title, url, files: [{ kind: 'image'|'video', file, part }], skippedVideos }
 * file 是相对项目根目录的路径。
 */
export function captureSource({ root, itemId, url, fullPage = true, videos = false }) {
  const u = checkUrl(url);
  const run = queue.then(() => capture(root, itemId, u, fullPage, videos));
  queue = run.catch(() => {});
  return run;
}

async function capture(root, itemId, u, fullPage, videos) {
  const rel = path.join('videos', '_assets', itemId);
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${Date.now().toString(36)}-${u.hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`;
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, locale: 'zh-CN' });
    const page = await ctx.newPage();
    const resp = await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (resp && resp.status() >= 400) throw badRequest(`网页返回 ${resp.status()}`);
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    // 被验证码、人机验证拦住的页面截了也没用：直接报失败，让调研换一个来源（不去破解验证码）
    if (await page.evaluate(BLOCKED).catch(() => false)) throw badRequest('页面被验证码或人机验证拦住了，截不到正文。换一个来源，比如同一条新闻的其他转载');
    // 关掉挡在正文前面的弹窗（下载 App、新版本提示、登录引导、遮罩），解开禁止滚动，整页截图才完整
    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(CLEAR_OVERLAYS).catch(() => {});
    await page.waitForTimeout(300);
    const title = (await page.title().catch(() => '')).slice(0, 200);
    const files = [];

    const view = path.join(rel, `${base}-view.png`);
    await page.screenshot({ path: path.join(root, view) });
    files.push({ kind: 'image', file: view, part: '首屏' });

    if (fullPage) {
      const h = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
      if (h > 1100) {
        const full = path.join(rel, `${base}-full.png`);
        await page.screenshot({ path: path.join(root, full), fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.min(h, MAX_FULL_HEIGHT) } });
        files.push({ kind: 'image', file: full, part: h > MAX_FULL_HEIGHT ? `整页（前 ${MAX_FULL_HEIGHT}px）` : '整页' });
      }
    }

    let skippedVideos = 0;
    if (videos) {
      // 页面里能直接下载的视频文件（<video> 和 og:video）；流媒体分片、blob 地址拿不到
      const srcs = await page.evaluate(() => {
        const list = [...document.querySelectorAll('video, video source')].map((v) => v.currentSrc || v.src);
        const og = document.querySelector('meta[property="og:video"], meta[property="og:video:url"]')?.content;
        return [...new Set([...list, og].filter((s) => s && /^https?:/.test(s)))];
      }).catch(() => []);
      for (const [i, src] of srcs.slice(0, MAX_VIDEOS).entries()) {
        const out = await downloadVideo(src, path.join(dir, `${base}-video${i + 1}`)).catch(() => null);
        if (out) files.push({ kind: 'video', file: path.relative(root, out), part: `页面视频 ${i + 1}`, src });
        else skippedVideos++;
      }
      skippedVideos += Math.max(0, srcs.length - MAX_VIDEOS);
    }
    return { title, url: u.href, files, skippedVideos };
  } finally {
    await browser.close().catch(() => {});
  }
}
