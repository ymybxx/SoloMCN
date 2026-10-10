// 推特（X）发布：用本机 Chrome 打开 x.com 的发帖框，模拟人在网页上操作。
// 官方接口按条收费且要开发者账号，这里按用户的选择走浏览器自动化。选择器按 data-testid 写，X 改版后要跟着改。
// 登录、检查、解绑这些各平台通用的部分在 browser.js；和 Google 一样，登录窗口不开远程调试端口。
// 这里发的是用户自己绑定的账号，和读推特用的号池无关。
import fs from 'node:fs';
import { createBrowserAccounts, waitState, insertChecked } from './browser.js';

const HOME = 'https://x.com/home';
const COMPOSE = 'https://x.com/compose/post';
export const X_MAX_WEIGHT = 280; // 推文长度上限：中日韩文字、emoji 算 2，其他算 1，链接固定算 23

// 按 X 的规则算推文长度
export function tweetWeight(text) {
  let n = 0;
  const s = String(text).replace(/https?:\/\/\S+/g, (u) => (n += 23, ''));
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += (c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037)) ? 1 : 2;
  }
  return n;
}

// 正文加话题，超长就从正文末尾截（补一个省略号），话题保留
export function buildTweet(desc, tags = []) {
  const tagText = tags.map((t) => `#${String(t).replace(/^#/, '').replace(/\s+/g, '')}`).filter((t) => t.length > 1).slice(0, 3).join(' ');
  const compose = (b) => (tagText ? `${b}\n\n${tagText}` : b);
  const fits = (b) => tweetWeight(compose(b)) <= X_MAX_WEIGHT;
  const full = String(desc || '').trim();
  if (fits(full)) return compose(full);
  const chars = [...full];
  while (chars.length && !fits(chars.join('').trimEnd() + '…')) chars.pop();
  return compose(chars.join('').trimEnd() + '…');
}

// 没登录会跳到登录页；登录后首页有发帖按钮
async function loggedIn(page) {
  const url = page.url();
  if (!/x\.com|twitter\.com/.test(url) || /\/login|\/i\/flow/.test(url)) return false;
  return page.locator('[data-testid="SideNav_NewTweet_Button"], [data-testid="AppTabBar_Home_Link"]').first()
    .waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false);
}

export function createX({ dataDir }) {
  const acc = createBrowserAccounts({ dataDir, key: 'x', name: '推特', app: 'X 账号', loginUrl: 'https://x.com/login', checkUrl: HOME, loggedIn, debugPort: false });

  // ---------- 发布 ----------
  // info: { mp4, title, desc, tags, dryRun }；推特没有标题和封面，正文就是 desc 加话题
  async function publish(accountId, info, log) {
    acc.ensureBound(accountId);
    if (!fs.existsSync(info.mp4)) throw new Error(`找不到视频文件 ${info.mp4}`);
    const text = buildTweet(info.desc || info.title, info.tags);
    const ctx = await acc.openProfile(accountId);
    const page = ctx.pages()[0] || (await ctx.newPage());
    try {
      log('打开推特发帖框');
      await page.goto(COMPOSE, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const box = page.locator('[data-testid="tweetTextarea_0"]').first();
      await box.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
      if (!(await box.isVisible().catch(() => false))) {
        if (!(await loggedIn(page))) throw new Error('推特登录已失效，去「账号矩阵」重新登录');
        throw new Error('没打开发帖框');
      }

      log(`填写推文（${tweetWeight(text)}/${X_MAX_WEIGHT}）`);
      await insertChecked(page, box, text, '推文');

      log('上传视频');
      await page.locator('input[data-testid="fileInput"]').first().setInputFiles(info.mp4, { timeout: 30_000 });
      const btn = page.locator('[data-testid="tweetButton"]').first();
      // 视频上传、处理完之前发帖按钮是灰的
      await page.waitForFunction(() => {
        const b = document.querySelector('[data-testid="tweetButton"]');
        const busy = document.querySelector('[role="progressbar"]');
        return b && b.getAttribute('aria-disabled') !== 'true' && !b.disabled && !busy;
      }, null, { timeout: 15 * 60_000, polling: 2000 });
      // 视频预览出现在发帖框里，确认视频已经挂上
      await waitState(page, () => !!document.querySelector('[data-testid="attachments"] video, [data-testid="attachments"] [data-testid*="video" i]'), { timeout: 10_000, soft: true });

      log('点击发布');
      if (info.dryRun) {
        log('试运行：停在点发布之前');
        return { ok: true, dryRun: true, screenshot: await acc.shot(page, 'dryrun') };
      }
      await btn.click({ timeout: 15_000 });
      // 发出去后弹「帖子已发送」提示，发帖框关闭
      await Promise.race([
        page.locator('[data-testid="toast"]').first().waitFor({ state: 'visible', timeout: 120_000 }),
        box.waitFor({ state: 'detached', timeout: 120_000 }),
      ]);
      log('发布成功');
      return { ok: true };
    } catch (err) {
      err.screenshot = await acc.shot(page);
      throw err;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  return { ...acc, publish };
}
