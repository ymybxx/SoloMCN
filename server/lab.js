// 调研里的动手实践。
// - 实验目录：videos/lab-<内容 id>/。调研任务就在这里运行，Claude Code 的沙盒只允许它写这个目录、
//   不能读家目录、网络只放行装依赖用的几个网站（配置见 agent.js 的 labLaunch）
// - 录制实验画面：做成网页的实验（three.js、动画、可视化），工作台在沙盒外用无头 Chrome 打开、截图、录屏
// - 实践浏览器：操作线上工具（比如 3D 生成网站），每个网站一份登录状态，存在 data/lab-browser/<网站>/
// - 等人处理：碰到登录、要花钱、要填支付信息，Claude 调 ask，任务停在这里，等你在页面上处理完再继续。
//   银行卡号这类支付信息只由人在弹出的窗口里自己填，实践浏览器拒绝替 Claude 输入
// 截图、录屏都存成内容卡片上的素材（source: 'practice'），写脚本、做视频时能直接用
// - 共用工具箱：videos/lab-shared/tools/，所有内容共用（Ghidra、JDK 这类大工具装一次），tools.json 记着每个工具的用途、用法、上次使用时间
// - 经验本：videos/lab-shared/NOTES.md，调研开始时读、结束时追加以后能复用的经验（环境情况、踩过的坑），页面上能看能改
// - 空间管理：每次调研结束清掉下载缓存和解压过的安装包；定时淘汰久没用的工具、总量超上限的工具，
//   瘦身调研完一段时间或已发布内容的实验目录（只留代码、记录和实践素材）。阈值在「设置」里改
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
import { CHROME, slimProfile } from './publish/browser.js';

export const ASK_TIMEOUT_MS = 40 * 60_000; // 等人处理最多等多久
const RECORD_MAX_SEC = 30;
const SNAPSHOT_MAX = 15_000;
const IDLE_CLOSE_MS = 10 * 60_000; // 实践浏览器闲置多久自动关掉
const LAB_SKILLS = ['research-topic']; // 调研任务在实验目录里运行，要用的技能复制进去
const MEDIA_KIND = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.mp4': 'video', '.webm': 'video', '.mov': 'video' };
const LAUNCH = {
  executablePath: CHROME,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
};
export const LAB_DEFAULTS = { toolIdleDays: 30, toolCapGB: 10, labKeepDays: 7, askAboveGB: 1 };
const ARCHIVE_RE = /\.(zip|tar\.gz|tgz|tar\.xz|tar\.bz2|tbz2|dmg|pkg|7z)$/i; // 下载下来的安装包，解压后就没用了
const HEAVY_DIRS = new Set(['.venv', 'venv', 'node_modules', '.cache', 'tools', '__pycache__', 'build', 'dist', 'target', '.gradle']);
const SLIM_KEEP_MAX = 5 * 1024 * 1024; // 瘦身时单个文件超过 5MB 的删掉（实践素材 media/ 不动）

// 目录占多少空间（字节），用 du 算，比逐个文件统计快得多
function sizeOf(p) {
  try {
    return Number(execFileSync('du', ['-sk', p], { encoding: 'utf8', timeout: 60_000 }).split('\t')[0]) * 1024;
  } catch {
    return 0;
  }
}
// 目录里最近一次改动的时间（只看前两层，够判断「最近有没有用过」）
function newestMtime(p, depth = 0) {
  let t = 0;
  try {
    const st = fs.statSync(p);
    t = st.mtimeMs;
    if (st.isDirectory() && depth < 2) for (const e of fs.readdirSync(p)) t = Math.max(t, newestMtime(path.join(p, e), depth + 1));
  } catch {}
  return t;
}

const ASK_KINDS = { login: ['done', 'skip'], payment: ['done', 'skip'], spend: ['approve', 'deny'], other: ['done', 'skip'] };

const bad = (message) => Object.assign(new Error(message), { status: 400 });

// 网站的标识：域名，去掉 www.。每个网站一份登录状态
export function siteKey(input) {
  let host = String(input || '').trim().toLowerCase();
  try {
    if (host.includes('://')) host = new URL(host).hostname;
  } catch {
    throw bad('网址不对');
  }
  host = host.replace(/^www\./, '');
  if (!/^[a-z0-9.-]{1,80}$/.test(host) || !host.includes('.')) throw bad('网站要写成域名，比如 meshy.ai');
  return host;
}

// 像银行卡号的数字串（13–19 位、通过 Luhn 校验）：实践浏览器不替 Claude 输入，要人自己填
export function looksLikeCard(text) {
  const digits = String(text || '').replace(/[\s-]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// 用 Chrome 的屏幕直播逐帧抓画面（带时间戳），再用系统 ffmpeg 按真实时间拼成视频；不用另装 Playwright 的 ffmpeg
async function screencast(page, seconds, outMp4) {
  const frames = [];
  const cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ t: f.metadata.timestamp, data: f.data });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const vp = page.viewportSize() || { width: 1280, height: 720 };
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1 });
  await page.waitForTimeout(seconds * 1000);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await cdp.detach().catch(() => {});
  if (frames.length < 2) throw new Error('没录到画面（页面可能没有在动）');
  const dir = fs.mkdtempSync(outMp4 + '-frames-');
  try {
    const lines = [];
    frames.forEach((f, i) => {
      const file = path.join(dir, `${String(i).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      lines.push(`file '${file}'`, `duration ${Math.max(0.001, (frames[i + 1]?.t ?? f.t + 1 / 30) - f.t).toFixed(4)}`);
    });
    lines.push(`file '${path.join(dir, `${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`);
    fs.writeFileSync(path.join(dir, 'list.txt'), lines.join('\n'));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
      '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', outMp4], { timeout: 120_000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return frames.length;
}

export function createLab({ root, store }) {
  const profiles = path.join(root, 'data', 'lab-browser');
  const dirOf = (itemId) => path.join(root, 'videos', `lab-${itemId}`);
  const stamp = () => Date.now().toString(36);

  // 调研任务开跑前：建实验目录，把调研要用的技能复制进去（复制，不是链接：改了也只改到副本）
  function prepare(itemId) {
    const dir = dirOf(itemId);
    fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
    for (const f of ['.npmrc', '.gitconfig']) if (!fs.existsSync(path.join(dir, f))) fs.writeFileSync(path.join(dir, f), '');
    const skills = path.join(dir, '.claude', 'skills');
    fs.rmSync(skills, { recursive: true, force: true });
    for (const name of LAB_SKILLS) {
      const src = path.join(root, '.claude', 'skills', name);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(skills, name), { recursive: true });
    }
    return dir;
  }

  const ensure = (itemId) => fs.mkdirSync(path.join(dirOf(itemId), 'media'), { recursive: true });

  // 只能用实验目录里的文件（挡住 ../ 越界和指到外面的链接）
  function inLab(itemId, rel) {
    ensure(itemId);
    const dir = fs.realpathSync(dirOf(itemId));
    const abs = path.resolve(dir, String(rel || ''));
    if (!fs.existsSync(abs)) throw bad(`实验目录里没有这个文件：${rel}`);
    const real = fs.realpathSync(abs);
    if (real !== dir && !real.startsWith(dir + path.sep)) throw bad('只能用实验目录里的文件');
    return real;
  }

  function item(itemId) {
    const it = store.get('items', itemId);
    if (!it) throw Object.assign(new Error('找不到这条内容'), { status: 404 });
    return it;
  }

  async function addAssets(itemId, files) {
    const at = Date.now();
    const added = files.map((f, i) => ({ id: `${at.toString(36)}p${i}`, source: 'practice', at, ...f, note: String(f.note || '').slice(0, 300) }));
    const cur = store.get('items', itemId).assets || [];
    await store.update('items', itemId, { assets: [...cur, ...added].slice(-80), updatedAt: Date.now() });
    return added.map((a) => ({ id: a.id, kind: a.kind, file: a.file, part: a.part }));
  }
  const rel = (abs) => path.relative(root, abs);

  // ---------- 录制实验画面：实验目录里的网页 ----------
  async function record(itemId, { file, seconds = 6, note = '', width = 1280, height = 720 }) {
    item(itemId);
    const abs = inLab(itemId, file);
    if (!/\.html?$/i.test(abs)) throw bad('只能录实验目录里的网页（.html），图片、视频用 lab_add_media 存');
    const sec = Math.min(RECORD_MAX_SEC, Math.max(1, Number(seconds) || 6));
    const vp = { width: Math.min(1920, Math.max(320, Number(width) || 1280)), height: Math.min(1920, Math.max(320, Number(height) || 720)) };
    const browser = await chromium.launch({ ...LAUNCH, headless: true });
    const errors = [];
    try {
      const page = await browser.newPage({ viewport: vp });
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(pathToFileURL(abs).href, { waitUntil: 'load', timeout: 60_000 });
      // 页面可以设置 window.READY = true 表示准备好了；没设置就等一秒半
      await page.waitForFunction(() => window.READY === true, null, { timeout: 10_000 }).catch(() => page.waitForTimeout(1500));
      const base = path.join(dirOf(itemId), 'media', `rec-${stamp()}`);
      await page.screenshot({ path: base + '.png' });
      const frames = await screencast(page, sec, base + '.mp4');
      const assets = await addAssets(itemId, [
        { kind: 'video', file: rel(base + '.mp4'), part: '实践录屏', title: path.basename(abs), note },
        { kind: 'image', file: rel(base + '.png'), part: '实践截图', title: path.basename(abs), note },
      ]);
      return { assets, frames, seconds: sec, pageErrors: errors.slice(0, 5) };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // ---------- 实验目录里已经生成好的图片、视频（Python 出的图、渲染的视频）存成素材 ----------
  async function addMedia(itemId, { file, note = '' }) {
    item(itemId);
    const abs = inLab(itemId, file);
    const kind = MEDIA_KIND[path.extname(abs).toLowerCase()];
    if (!kind) throw bad('只支持 png、jpg、webp、gif 图片和 mp4、webm、mov 视频');
    return { assets: await addAssets(itemId, [{ kind, file: rel(abs), part: kind === 'video' ? '实践视频' : '实践图片', title: path.basename(abs), note }]) };
  }

  // Claude 删掉自己存的实践素材（比如录坏了重录）：文件和卡片上的记录一起删
  async function removeMedia(itemId, { ids = [], files = [] }) {
    const it = item(itemId);
    const want = new Set([...ids, ...files.map((f) => path.relative(root, path.resolve(dirOf(itemId), f)))]);
    const gone = (it.assets || []).filter((a) => a.source === 'practice' && (want.has(a.id) || want.has(a.file)));
    for (const a of gone) {
      const abs = path.resolve(root, a.file);
      if (abs.startsWith(dirOf(itemId) + path.sep)) fs.rmSync(abs, { force: true });
    }
    const ids2 = new Set(gone.map((a) => a.id));
    await store.update('items', itemId, { assets: (it.assets || []).filter((a) => !ids2.has(a.id)), updatedAt: Date.now() });
    return { removed: gone.length };
  }

  // 文件已经不在了的素材记录（被删掉的录屏、截图）从卡片上去掉
  async function pruneMissing(itemId) {
    const it = store.get('items', itemId);
    if (!it?.assets?.length) return 0;
    const keep = it.assets.filter((a) => !a.file || fs.existsSync(path.resolve(root, a.file)));
    if (keep.length === it.assets.length) return 0;
    await store.update('items', itemId, { assets: keep });
    return it.assets.length - keep.length;
  }

  // ---------- 实践浏览器：每个网站一份登录状态，后台无界面运行 ----------
  const sessions = new Map(); // 网站 -> { ctx, page, timer }
  const windows = new Map(); // 网站 -> 给人登录、付款用的 Chrome 窗口进程

  async function closeSession(site) {
    const s = sessions.get(site);
    sessions.delete(site);
    clearTimeout(s?.timer);
    await s?.ctx.close().catch(() => {});
  }

  async function session(site) {
    if (windows.has(site)) throw bad(`${site} 的窗口还开着，等人在里面处理完`);
    let s = sessions.get(site);
    if (!s) {
      const dir = path.join(profiles, site);
      fs.mkdirSync(dir, { recursive: true });
      const ctx = await chromium.launchPersistentContext(dir, { ...LAUNCH, headless: true, viewport: { width: 1440, height: 900 }, locale: 'zh-CN', acceptDownloads: true });
      s = { ctx, page: ctx.pages()[0] || (await ctx.newPage()) };
      ctx.on('page', (p) => { s.page = p; }); // 点链接开了新标签页，就跟到新页面
      ctx.on('close', () => { sessions.delete(site); setTimeout(() => slimProfile(dir), 1000); });
      sessions.set(site, s);
    }
    clearTimeout(s.timer);
    s.timer = setTimeout(() => closeSession(site), IDLE_CLOSE_MS);
    return s;
  }

  async function snapshot(page) {
    const snap = await page.ariaSnapshot({ mode: 'ai', timeout: 20_000 }).catch((e) => `（读不到页面结构：${e.message.split('\n')[0]}）`);
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      snapshot: snap.length > SNAPSHOT_MAX ? snap.slice(0, SNAPSHOT_MAX) + '\n…（页面太长，后面省略；需要的话先滚动）' : snap,
    };
  }

  async function browse(itemId, { site, action, url, ref, text, key, file, seconds, note = '' }) {
    item(itemId);
    ensure(itemId);
    const name = siteKey(site || url);
    const s = await session(name);
    const page = s.page;
    const el = () => {
      if (!/^[a-z0-9]{1,16}$/i.test(String(ref || ''))) throw bad('ref 要填页面快照里的编号，比如 e12');
      return page.locator(`aria-ref=${ref}`);
    };
    const extra = {};
    switch (action) {
      case 'open': {
        if (!/^https?:\/\//i.test(String(url || ''))) throw bad('open 要给完整网址');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        break;
      }
      case 'snapshot':
        break;
      case 'click':
        await el().click({ timeout: 15_000 });
        break;
      case 'fill':
        if (looksLikeCard(text)) throw bad('这看起来是银行卡号：支付信息只能由人自己填。用 lab_ask_user（kind: payment）请用户在弹出的窗口里完成');
        await el().fill(String(text ?? ''), { timeout: 15_000 });
        break;
      case 'press':
        await page.keyboard.press(String(key || 'Enter'));
        break;
      case 'select':
        await el().selectOption(String(text ?? ''), { timeout: 15_000 });
        break;
      case 'upload': {
        const abs = inLab(itemId, file);
        // 很多网站的上传按钮背后是隐藏的文件框：点按钮、接住弹出的选文件窗口
        const chooser = page.waitForEvent('filechooser', { timeout: 15_000 });
        await el().click({ timeout: 15_000 }).catch(() => {});
        const fc = await chooser.catch(() => null);
        if (fc) await fc.setFiles(abs);
        else await el().setInputFiles(abs, { timeout: 15_000 });
        break;
      }
      case 'download': {
        const dl = page.waitForEvent('download', { timeout: 120_000 });
        await el().click({ timeout: 15_000 });
        const d = await dl;
        const out = path.join(dirOf(itemId), 'downloads', `${stamp()}-${d.suggestedFilename().replace(/[^\w.\-一-鿿]/g, '_')}`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        await d.saveAs(out);
        extra.downloaded = path.relative(dirOf(itemId), out);
        break;
      }
      case 'scroll':
        await page.mouse.wheel(0, Number(seconds) || 900);
        break;
      case 'back':
        await page.goBack({ timeout: 30_000 }).catch(() => {});
        break;
      case 'wait':
        await page.waitForTimeout(Math.min(180, Math.max(1, Number(seconds) || 5)) * 1000);
        break;
      case 'screenshot': {
        const out = path.join(dirOf(itemId), 'media', `web-${stamp()}.png`);
        await page.screenshot({ path: out });
        extra.assets = await addAssets(itemId, [{ kind: 'image', file: rel(out), part: '实践截图', url: page.url(), title: await page.title().catch(() => ''), note }]);
        break;
      }
      case 'record': {
        const out = path.join(dirOf(itemId), 'media', `web-${stamp()}.mp4`);
        await screencast(page, Math.min(RECORD_MAX_SEC, Math.max(1, Number(seconds) || 6)), out);
        extra.assets = await addAssets(itemId, [{ kind: 'video', file: rel(out), part: '实践录屏', url: page.url(), title: await page.title().catch(() => ''), note }]);
        break;
      }
      case 'close':
        await closeSession(name);
        return { closed: name };
      default:
        throw bad('action 不对');
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
    return { site: name, ...(await snapshot(s.page)), ...extra };
  }

  // ---------- 等人处理：登录、付款（人在弹出的窗口里自己操作）、花钱确认、其他 ----------
  const asks = new Map(); // 请求 id -> { itemId, resolve, kind, site }

  function openWindow(site, url) {
    const dir = path.join(profiles, site);
    fs.mkdirSync(dir, { recursive: true });
    // --use-mock-keychain：和实践浏览器用同一种 cookie 加密方式，人登录完后台才读得出登录状态
    const proc = spawn(CHROME, [`--user-data-dir=${dir}`, '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', '--new-window', url || `https://${site}/`], { stdio: 'ignore' });
    windows.set(site, proc);
    proc.on('exit', () => { windows.delete(site); slimProfile(dir); });
  }

  // 人处理完：让 Chrome 正常退出（cookie 写盘），最多等 15 秒
  async function closeWindow(site) {
    const proc = windows.get(site);
    if (!proc) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
    windows.delete(site);
  }

  async function ask(itemId, { kind, site, url, message, amount }) {
    const it = item(itemId);
    if (!ASK_KINDS[kind]) throw bad('kind 只能是 login、payment、spend、other');
    if (it.labAsk?.status === 'waiting' && asks.has(it.labAsk.id)) throw bad('已经有一个请求在等人处理');
    const name = site || url ? siteKey(site || url) : null;
    if ((kind === 'login' || kind === 'payment') && !name) throw bad('登录、付款要写清楚是哪个网站');
    const req = {
      id: randomUUID().replace(/-/g, '').slice(0, 10), kind, site: name, url: /^https?:\/\//i.test(url || '') ? url : null,
      message: String(message || '').slice(0, 600), amount: amount ? String(amount).slice(0, 120) : null, status: 'waiting', at: Date.now(),
    };
    if (name && (kind === 'login' || kind === 'payment')) {
      await closeSession(name); // 实践浏览器先让出这个网站的登录配置
      openWindow(name, req.url);
    }
    await store.update('items', itemId, { labAsk: req, updatedAt: Date.now() });
    const result = await new Promise((resolve) => {
      asks.set(req.id, { itemId, resolve, kind, site: name });
      setTimeout(() => answer(itemId, req.id, 'timeout').catch(() => {}), ASK_TIMEOUT_MS);
    });
    return { result, kind, site: name };
  }

  async function answer(itemId, id, result) {
    const w = asks.get(id);
    const it = item(itemId);
    if (!w || w.itemId !== itemId) {
      // 任务已经结束或者工作台重启过：这个请求没人在等了，清掉
      if (it.labAsk?.id === id) await store.update('items', itemId, { labAsk: { ...it.labAsk, status: 'expired' } });
      throw Object.assign(new Error('Claude 已经不在等这个请求了（任务结束或工作台重启过），可以重新调研'), { status: 409 });
    }
    if (result !== 'timeout' && !ASK_KINDS[w.kind].includes(result)) throw bad('结果不对');
    asks.delete(id);
    if (w.site) await closeWindow(w.site);
    await store.update('items', itemId, { labAsk: { ...it.labAsk, status: result, answeredAt: Date.now() }, updatedAt: Date.now() });
    w.resolve(result);
    return { ok: true, result };
  }

  // 工作台重启后，没人在等的请求不再显示为「等你处理」
  function clearStale() {
    for (const [id, it] of Object.entries(store.all().items || {})) {
      if (it.labAsk?.status === 'waiting' && !asks.has(it.labAsk.id)) store.update('items', id, { labAsk: { ...it.labAsk, status: 'expired' } });
    }
  }

  // 实验目录里有哪些文件（给 get_item 和写脚本、做视频时参考）
  function files(itemId, max = 60) {
    const dir = dirOf(itemId);
    if (!fs.existsSync(dir)) return null;
    const out = [];
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (out.length >= max) return;
        if (e.name.startsWith('.') || ['node_modules', '__pycache__', 'venv', '.venv'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); } else out.push(path.relative(dir, p));
      }
    };
    walk(dir, 0);
    return { dir: path.relative(root, dir), files: out };
  }

  // ---------- 共用工具箱和经验本 ----------
  const shared = path.join(root, 'videos', 'lab-shared');
  const toolsDir = path.join(shared, 'tools');
  const manifestFile = path.join(shared, 'tools.json');
  const notesFile = path.join(shared, 'NOTES.md');
  const NOTES_HEAD = '# 实践经验本\n\n调研里动手实践积累的经验：这台电脑的环境、工具箱里的工具怎么用、踩过的坑和解法。Claude 每次调研开始时读，结束时追加；你可以随时改、删掉过时的。\n\n';
  fs.mkdirSync(toolsDir, { recursive: true });

  const settings = () => ({ ...LAB_DEFAULTS, ...(store.get('settings', 'lab') || {}) });
  async function setSettings(body) {
    const cur = settings();
    const num = (k, min, max) => { const v = Number(body[k]); return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : cur[k]; };
    const next = { toolIdleDays: num('toolIdleDays', 1, 365), toolCapGB: num('toolCapGB', 1, 500), labKeepDays: num('labKeepDays', 1, 365), askAboveGB: num('askAboveGB', 0.1, 50) };
    await store.set('settings', 'lab', next);
    return next;
  }

  const readManifest = () => { try { return JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { return {}; } };
  const writeManifest = (m) => fs.writeFileSync(manifestFile, JSON.stringify(m, null, 1));
  const readNotes = () => { try { return fs.readFileSync(notesFile, 'utf8'); } catch { return NOTES_HEAD; } };
  function writeNotes(text) {
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(notesFile, String(text).slice(0, 60_000));
    return { ok: true, length: Math.min(String(text).length, 60_000) };
  }
  function appendNotes(text) {
    const lines = String(text || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20);
    if (!lines.length) throw bad('没写经验');
    const day = new Date().toISOString().slice(0, 10);
    const add = lines.map((l) => (l.startsWith('- ') ? l : `- ${l}`)).map((l) => `${l}（${day}）`).join('\n');
    return writeNotes(readNotes().replace(/\s*$/, '\n') + add + '\n');
  }

  // 工具箱：list 列出工具和经验本；add 登记新装的工具；used 记下这次用了哪些
  function toolbox({ action = 'list', name, dir, purpose, usage }) {
    const m = readManifest();
    if (action === 'add' || action === 'used') {
      const key = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 60);
      if (!key) throw bad('要写工具名');
      if (action === 'add') {
        const rel = String(dir || key).replace(/^\/+/, '');
        const abs = path.resolve(toolsDir, rel);
        if (!abs.startsWith(toolsDir + path.sep)) throw bad('工具要装在工具箱目录里');
        m[key] = { ...(m[key] || {}), name: key, dir: path.relative(toolsDir, abs), purpose: String(purpose || m[key]?.purpose || '').slice(0, 300), usage: String(usage || m[key]?.usage || '').slice(0, 600), addedAt: m[key]?.addedAt || Date.now(), lastUsedAt: Date.now(), removed: false };
      } else {
        if (!m[key]) throw bad(`工具箱里没有 ${key}，装好后先用 add 登记`);
        m[key].lastUsedAt = Date.now();
      }
      writeManifest(m);
    }
    const tools = Object.values(m).map((t) => ({ name: t.name, dir: t.dir, purpose: t.purpose, usage: t.usage, removed: !!t.removed,
      exists: !t.removed && fs.existsSync(path.join(toolsDir, t.dir || t.name)), lastUsed: t.lastUsedAt ? new Date(t.lastUsedAt).toISOString().slice(0, 10) : null }));
    return { toolsDir, tools, notes: readNotes(), askAboveGB: settings().askAboveGB };
  }

  // ---------- 空间管理 ----------
  function storage() {
    const m = readManifest();
    const tools = fs.existsSync(toolsDir) ? fs.readdirSync(toolsDir, { withFileTypes: true }).filter((e) => e.isDirectory() || ARCHIVE_RE.test(e.name)).map((e) => {
      const p = path.join(toolsDir, e.name);
      const meta = Object.values(m).find((t) => (t.dir || t.name).split('/')[0] === e.name) || {};
      return { name: e.name, purpose: meta.purpose || '', size: sizeOf(p), lastUsedAt: Math.max(meta.lastUsedAt || 0, newestMtime(p)) };
    }) : [];
    const items = store.all().items || {};
    const labs = fs.readdirSync(path.join(root, 'videos'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('lab-') && e.name !== 'lab-shared')
      .map((e) => {
        const itemId = e.name.slice(4);
        const p = path.join(root, 'videos', e.name);
        return { itemId, title: items[itemId]?.title || '（内容已删除）', exists: !!items[itemId], size: sizeOf(p), slimmed: fs.existsSync(path.join(p, '.slimmed')), lastUsedAt: newestMtime(p) };
      });
    return { settings: settings(), tools, toolsTotal: tools.reduce((s, t) => s + t.size, 0), labs, labsTotal: labs.reduce((s, l) => s + l.size, 0), notesLength: readNotes().length };
  }

  function removeTool(name, reason) {
    const p = path.join(toolsDir, String(name));
    if (!p.startsWith(toolsDir + path.sep) || !fs.existsSync(p)) throw bad('工具箱里没有这个工具');
    fs.rmSync(p, { recursive: true, force: true });
    const m = readManifest();
    for (const t of Object.values(m)) if ((t.dir || t.name).split('/')[0] === name) t.removed = true;
    writeManifest(m);
    if (reason) appendNotes(`工具箱里的 ${name} 已删除（${reason}），需要时按上面记的方法重装`);
    return { removed: name };
  }

  // 实验目录瘦身：只留代码、记录和实践素材（media/），删掉虚拟环境、依赖、工具、编译产物和大文件
  function slimLab(itemId) {
    const dir = dirOf(itemId);
    if (!fs.existsSync(dir)) throw bad('这条内容没有实验目录');
    let freed = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (d === dir && (e.name === 'media' || e.name === '.claude')) continue;
        if (e.isDirectory()) {
          if (HEAVY_DIRS.has(e.name)) { freed += sizeOf(p); fs.rmSync(p, { recursive: true, force: true }); } else walk(p);
        } else if (e.isFile()) {
          const st = fs.statSync(p);
          if (st.size > SLIM_KEEP_MAX || ARCHIVE_RE.test(e.name)) { freed += st.size; fs.rmSync(p, { force: true }); }
        }
      }
    };
    walk(dir);
    fs.writeFileSync(path.join(dir, '.slimmed'), JSON.stringify({ at: Date.now(), freed }));
    return { freed };
  }

  function removeLab(itemId) {
    const dir = dirOf(itemId);
    if (!fs.existsSync(dir)) throw bad('这条内容没有实验目录');
    const used = (store.get('items', itemId)?.assets || []).some((a) => a.source === 'practice');
    if (used) throw bad('这条内容的实践素材还在用，先瘦身（会保留实践素材），或者先在素材里删掉它们');
    const freed = sizeOf(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { freed };
  }

  // 每次调研结束：清掉下载缓存、解压过的安装包（实验目录和工具箱里的）
  function afterRun(itemId) {
    pruneMissing(itemId).catch(() => {});
    let freed = 0;
    const drop = (p) => { if (fs.existsSync(p)) { freed += sizeOf(p); fs.rmSync(p, { recursive: true, force: true }); } };
    drop(path.join(dirOf(itemId), '.cache'));
    // 实验目录：往下找两层（downloads/ 是实践浏览器下载的成果、media/ 是实践素材，不动）；
    // 工具箱：只看根目录（工具装好后自带的 zip 插件之类不能删）
    for (const [base, maxDepth] of [[dirOf(itemId), 2], [toolsDir, 0]]) {
      const walk = (d, depth) => {
        if (!fs.existsSync(d)) return;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isFile() && ARCHIVE_RE.test(e.name)) drop(p);
          else if (e.isDirectory() && depth < maxDepth && !HEAVY_DIRS.has(e.name) && !['media', 'downloads'].includes(e.name)) walk(p, depth + 1);
        }
      };
      walk(base, 0);
    }
    return { freed };
  }

  // 定时清理：久没用的工具、总量超上限的工具（最久没用的先删）、调研完一段时间或已发布内容的实验目录瘦身
  function cleanup() {
    const s = settings();
    const now = Date.now();
    const done = [];
    const st = storage();
    const tools = [...st.tools].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    let total = st.toolsTotal;
    for (const t of tools) {
      const idleDays = (now - t.lastUsedAt) / 864e5;
      const over = total > s.toolCapGB * 1024 ** 3;
      if (idleDays > s.toolIdleDays || over) {
        removeTool(t.name, idleDays > s.toolIdleDays ? `${Math.floor(idleDays)} 天没用过` : `工具箱超过 ${s.toolCapGB} GB 上限，它最久没用`);
        total -= t.size;
        done.push({ tool: t.name, freed: t.size });
      }
    }
    const items = store.all().items || {};
    for (const id of Object.keys(items)) pruneMissing(id).catch(() => {});
    for (const l of st.labs) {
      if (l.slimmed) continue;
      const it = items[l.itemId];
      const runs = Object.values(store.all().agentRuns || {}).filter((r) => r.task === 'research' && r.args?.itemId === l.itemId);
      if (runs.some((r) => r.status === 'running')) continue;
      const lastRun = Math.max(0, ...runs.map((r) => r.finishedAt || 0));
      if (!it || it.stage === 'published' || (lastRun && now - lastRun > s.labKeepDays * 864e5)) done.push({ lab: l.itemId, ...slimLab(l.itemId) });
    }
    return { done };
  }

  return { dirOf, prepare, record, addMedia, removeMedia, pruneMissing, browse, ask, answer, clearStale, files,
    shared, toolsDir, settings, setSettings, toolbox, readNotes, writeNotes, appendNotes, storage, removeTool, slimLab, removeLab, afterRun, cleanup };
}
