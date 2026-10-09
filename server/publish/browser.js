// 各平台共用的浏览器账号管理：每个账号一个独立的 Chrome 配置目录，登录状态存在里面，只在本机，不碰你日常用的 Chrome。
//   data/publish/<平台>-profiles/<账号 id>
// 登录：打开一个完全普通、不受程序控制的 Chrome 窗口，人正常扫码；点「我已登录」后让 Chrome 正常退出，再在后台确认登录状态。
// 发布：用同一个配置目录打开受控的 Chrome，由各平台模块按页面一步步操作。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// 默认弹出可见窗口：发布时能看着它操作；跑稳了可以在 .env 里设 PUBLISH_HEADLESS=1
const HEADLESS = process.env.PUBLISH_HEADLESS === '1';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 按页面状态推进，不靠固定等几秒 ----------
// 等到页面满足某个条件；等不到时 soft=true 就继续，否则报错（错误里带上在等什么）
export async function waitState(page, fn, { timeout = 15_000, soft = false, what = '页面状态', arg } = {}) {
  try {
    await page.waitForFunction(fn, arg, { timeout, polling: 250 });
    return true;
  } catch (err) {
    if (soft) return false;
    throw new Error(`等不到${what}（${Math.round(timeout / 1000)} 秒）`);
  }
}

// 网络请求停下来（上传、保存这类后台请求结束）；等不到也不报错
export const settle = (page, timeout = 10_000) => page.waitForLoadState('networkidle', { timeout }).catch(() => {});

// 普通输入框：标准填充，读回来核对，不一致再填一次
export async function fillChecked(locator, value, what = '输入框') {
  for (let i = 0; i < 2; i++) {
    await locator.fill(value);
    if ((await locator.inputValue().catch(() => '')) === value) return;
  }
  throw new Error(`${what}填不进去`);
}

// 富文本编辑框（contenteditable）：整段写入，读回来核对开头一段已经在框里
const squash = (t) => String(t).replace(/\s+/g, '');
export async function insertChecked(page, editor, text, what = '正文') {
  if (!text) return;
  const probe = squash(text).slice(0, 24);
  for (let i = 0; i < 2; i++) {
    await editor.click();
    await page.keyboard.insertText(text);
    const ok = await editor.evaluate((el, p) => el.innerText.replace(/\s+/g, '').includes(p), probe).catch(() => false);
    if (ok) return;
  }
  throw new Error(`${what}没写进去`);
}

// Chrome 自己攒的缓存：每份配置能涨到一两百 MB，登录只需要 cookie、本地存储、IndexedDB（约 4 MB）。
// 每次用完（登录、检查、发布结束）就删掉这些，下次打开网页时按需重建，不影响登录状态。
const CACHE_PATHS = [
  'Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/DawnWebGPUCache', 'Default/DawnGraphiteCache',
  'Default/Service Worker/CacheStorage', 'Default/Service Worker/ScriptCache',
  'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache', 'GPUCache', 'optimization_guide_model_store',
  'WasmTtsEngine', 'Safe Browsing', // Chrome 组件（朗读引擎、安全浏览名单），下次按需重新下载
];
// Chrome 会给每个配置下载几十 MB 的本地模型和组件（optimization guide、朗读引擎等），用不到，启动时关掉
const SLIM_ARGS = ['--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,OptimizationTargetPrediction,OptimizationHints', '--disable-component-update'];

export function slimProfile(dir) {
  for (const rel of CACHE_PATHS) fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
}

// opts: { dataDir, key, name, app, loginUrl, checkUrl, loggedIn(page), debugPort }
// debugPort=false：登录窗口不开远程调试端口（Google 检测到它会拒绝登录），点「我已登录」时改用 SIGTERM 让 Chrome 正常退出
export function createBrowserAccounts({ dataDir, key, name, app, loginUrl, checkUrl, loggedIn, debugPort = true }) {
  const profiles = path.join(dataDir, 'publish', `${key}-profiles`);
  const shotDir = path.join(dataDir, 'publish', 'screenshots');
  fs.mkdirSync(profiles, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  const profileDir = (accountId) => path.join(profiles, accountId);
  const boundFile = (accountId) => path.join(profileDir(accountId), 'workbench-bound.json');
  const logins = new Map(); // loginId -> 状态
  const loginProcs = new Map(); // accountId -> 正在登录的 Chrome 进程

  // 自动化控制的 Chrome：去掉“正受到自动测试软件控制”这类能被网页识别的标记
  async function openProfile(accountId, headless = HEADLESS) {
    if (!fs.existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}。装 Chrome，或在 .env 里设 CHROME_PATH`);
    if (loginProcs.has(accountId)) throw new Error('这个账号的登录窗口还开着，先登录完并关掉它');
    const ctx = await chromium.launchPersistentContext(profileDir(accountId), {
      executablePath: CHROME,
      headless,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', ...SLIM_ARGS],
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
    });
    // 浏览器关掉后清缓存
    ctx.on('close', () => setTimeout(() => slimProfile(profileDir(accountId)), 1000));
    return ctx;
  }

  // 出错时截一张整页图，方便对照页面改选择器
  async function shot(page, label = 'failed') {
    const f = path.join(shotDir, `${Date.now()}-${key}-${label}.png`);
    await page.screenshot({ path: f, fullPage: true }).catch(() => {});
    return f;
  }

  // ---------- 检查登录状态是否还有效（后台打开，看完就关） ----------
  async function check(accountId) {
    if (!fs.existsSync(profileDir(accountId))) return { bound: false, ok: false, message: '还没绑定' };
    const ctx = await openProfile(accountId, true);
    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(4000);
      const ok = await loggedIn(page);
      if (ok) fs.writeFileSync(boundFile(accountId), JSON.stringify({ checkedAt: Date.now() }));
      return { bound: true, ok, message: ok ? '登录有效' : '登录已失效，需要重新扫码' };
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ---------- 登录 ----------
  // 平台会识别自动化控制的浏览器（二维码立刻失效、提示系统繁忙），所以登录这一步不能自动化
  function startLogin(accountId) {
    const id = `${key}-${accountId}-${Date.now().toString(36)}`;
    const st = { id, accountId, platform: key, status: 'opening', message: '正在打开 Chrome…', startedAt: Date.now() };
    logins.set(id, st);
    if (loginProcs.has(accountId)) return Object.assign(st, { status: 'failed', message: '这个账号的登录窗口已经开着了' });
    if (!fs.existsSync(CHROME)) return Object.assign(st, { status: 'failed', message: `找不到 Chrome：${CHROME}` });
    fs.mkdirSync(profileDir(accountId), { recursive: true });
    // --use-mock-keychain：和自动化打开时用同一种 cookie 加密方式，后面才读得出登录状态
    // --remote-debugging-port=0：只用于你点「我已登录」后让 Chrome 正常退出（把 cookie 写盘），登录过程中不连接
    fs.rmSync(path.join(profileDir(accountId), 'DevToolsActivePort'), { force: true });
    const args = [`--user-data-dir=${profileDir(accountId)}`, '--use-mock-keychain', ...(debugPort ? ['--remote-debugging-port=0'] : []), '--no-first-run', '--no-default-browser-check', '--new-window', loginUrl];
    const proc = spawn(CHROME, args, { stdio: 'ignore' });
    loginProcs.set(accountId, proc);
    Object.assign(st, { status: 'waiting', message: `在弹出的 Chrome 窗口里用${app}扫码登录（要短信验证也在那里完成），登录好后点「我已登录」` });
    proc.on('exit', async () => {
      loginProcs.delete(accountId);
      slimProfile(profileDir(accountId));
      Object.assign(st, { status: 'checking', message: '窗口已关闭，正在确认登录状态…' });
      try {
        const r = await check(accountId);
        Object.assign(st, r.ok ? { status: 'done', message: '登录成功' } : { status: 'failed', message: '没有检测到登录，重新点「扫码绑定」再试' }, { finishedAt: Date.now() });
      } catch (err) {
        Object.assign(st, { status: 'failed', message: err.message.split('\n')[0], finishedAt: Date.now() });
      }
    });
    proc.on('error', (err) => Object.assign(st, { status: 'failed', message: `打开 Chrome 失败：${err.message}`, finishedAt: Date.now() }));
    return st;
  }

  // 人点「我已登录」：让 Chrome 正常退出（强制结束的话，刚拿到的登录 cookie 可能还没写到磁盘），退出后自动确认登录状态
  async function finishLogin(accountId) {
    const proc = loginProcs.get(accountId);
    if (!proc) throw Object.assign(new Error('没有正在进行的登录'), { status: 404 });
    try {
      if (!debugPort) throw new Error('no debug port');
      const port = fs.readFileSync(path.join(profileDir(accountId), 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
    } catch {
      proc.kill('SIGTERM');
    }
    // 万一 20 秒还没退出，再强制结束
    setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 20_000);
    return true;
  }

  function status(accountId) {
    const f = boundFile(accountId);
    return fs.existsSync(f) ? { bound: true, checkedAt: JSON.parse(fs.readFileSync(f, 'utf8')).checkedAt } : { bound: false };
  }
  function unbind(accountId) {
    if (loginProcs.has(accountId)) throw Object.assign(new Error('登录窗口还开着，先关掉它'), { status: 409 });
    fs.rmSync(profileDir(accountId), { recursive: true, force: true });
  }
  // 发布前的公共检查
  function ensureBound(accountId) {
    if (!status(accountId).bound) throw new Error(`这个账号还没绑定${name}，先在「账号矩阵」里扫码登录`);
  }

  return { key, name, openProfile, shot, check, startLogin, finishLogin, loginStatus: (id) => logins.get(id) || null, status, unbind, ensureBound };
}
