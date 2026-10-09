// 小红书发布：用本机 Chrome 打开小红书创作服务平台，模拟人在网页上操作。
// 小红书开放平台的发布能力只对商家和合作方开放，个人号没有发布接口，所以走浏览器自动化。
// 选择器按 2026-10 的实际页面校正过；小红书改版后这里要跟着改。
// 登录、检查、解绑这些各平台通用的部分在 browser.js。
import fs from 'node:fs';
import { createBrowserAccounts, waitState, settle, fillChecked, insertChecked } from './browser.js';
import { createStepPause } from './pacing.js';

const CREATOR = 'https://creator.xiaohongshu.com/';
const UPLOAD_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=video';
const LOGIN_MARKERS = ['扫码登录', '短信登录', '验证码登录', '手机号登录', '登 录'];

// 没登录会跳到 /login；登录后上传页有视频上传框或「发布笔记」入口
async function loggedIn(page) {
  const url = page.url();
  if (!url.includes('creator.xiaohongshu.com') || /\/login/.test(url)) return false;
  const visible = (t) => page.getByText(t, { exact: true }).first().isVisible().catch(() => false);
  for (const t of LOGIN_MARKERS) if (await visible(t)) return false;
  if (await page.locator('input[type="file"]').count().catch(() => 0)) return true;
  for (const t of ['发布笔记', '上传视频', '笔记管理', '数据看板']) if (await visible(t)) return true;
  return false;
}

export function createXhs({ dataDir }) {
  const acc = createBrowserAccounts({ dataDir, key: 'xhs', name: '小红书', app: '小红书 App', loginUrl: CREATOR, checkUrl: UPLOAD_URL, loggedIn });

  // ---------- 发布 ----------
  // info: { mp4, cover, title, desc, tags }；log(text) 记录每一步
  async function publish(accountId, info, log) {
    acc.ensureBound(accountId);
    if (!fs.existsSync(info.mp4)) throw new Error(`找不到视频文件 ${info.mp4}`);
    const pause = createStepPause();
    const ctx = await acc.openProfile(accountId);
    const page = ctx.pages()[0] || (await ctx.newPage());
    try {
      log('打开小红书创作服务平台的上传页');
      await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // 等上传框出现（没登录的话会跳到登录页，上传框不会出现）
      await page.locator('input.upload-input').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
      if (!(await loggedIn(page))) throw new Error('小红书登录已失效，去「账号矩阵」重新扫码');
      // 默认可能停在「上传图文」，切到「上传视频」标签（不要点页面中间那个「上传视频」按钮，它会弹系统选文件窗口）
      await page.locator('.creator-tab:has-text("上传视频")').first().click({ timeout: 5000 }).catch(() => {});
      await page.locator('input.upload-input[accept*="mp4"]').first().waitFor({ state: 'attached', timeout: 10_000 });
      await pause();

      log('上传视频文件');
      await page.locator('input.upload-input[accept*="mp4"]').first().setInputFiles(info.mp4, { timeout: 30_000 });
      const titleBox = page.locator('input[placeholder*="标题"]').first();
      await titleBox.waitFor({ state: 'visible', timeout: 180_000 });
      await pause();

      log('填写标题和正文');
      await fillChecked(titleBox, String(info.title || '').slice(0, 20), '标题');
      const editor = page.locator('div.tiptap.ProseMirror[contenteditable="true"]').first();
      await editor.waitFor({ state: 'visible', timeout: 15_000 });
      await pause();
      await insertChecked(page, editor, String(info.desc || ''), '正文');
      // 话题：输入 #词 后会弹联想列表，只点和自己的词完全一样的那项（直接回车会选中排第一的别的话题）
      const tags = (info.tags || []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 10);
      if (tags.length) await page.keyboard.press('Enter');
      const topics = editor.locator('a.tiptap-topic');
      for (const tag of tags) {
        // 先停顿，再读取话题数量和候选，避免使用停顿前的列表位置。
        await pause();
        const before = await topics.count();
        // 联想列表要靠键盘事件触发，话题词逐字输入；等联想里出现这个词（最多 5 秒）
        await page.keyboard.type(`#${tag}`);
        const items = page.locator('.item').filter({ hasText: `#${tag}` });
        await items.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        let hit = -1;
        for (let i = 0, n = await items.count(); i < n; i++) {
          if ((await items.nth(i).innerText().catch(() => '')).split('\n')[0].trim() === `#${tag}`) { hit = i; break; }
        }
        if (hit >= 0) {
          await items.nth(hit).click();
          // 绑定成功：编辑框里多出一个话题块，再处理下一个
          const bound = await waitState(page, ([n]) => document.querySelectorAll('div.tiptap a.tiptap-topic').length > n, { arg: [before], timeout: 5000, soft: true });
          if (!bound) log(`话题「${tag}」没绑定上，按普通文字留着`);
        } else {
          await page.keyboard.press('Escape');
          await page.keyboard.type(' ');
        }
      }

      log('等视频上传完成');
      await page.waitForFunction(() => /重新上传/.test(document.body.innerText) && !/上传中|上传失败/.test(document.body.innerText), null, { timeout: 15 * 60_000, polling: 2000 });
      if (/上传失败/.test(await page.evaluate(() => document.body.innerText))) throw new Error('小红书提示视频上传失败');

      if (info.cover && fs.existsSync(info.cover)) {
        await pause();
        log('上传自定义封面');
        const modal = page.locator('.cover-modal');
        try {
          // 「编辑封面」要鼠标移到封面缩略图上才出现
          await page.locator('div.default').first().hover({ timeout: 8000 });
          await page.getByText('编辑封面').first().click({ timeout: 8000 });
          await modal.waitFor({ state: 'visible', timeout: 10_000 });
          await pause();
          await modal.locator('input.upload-input[accept*="image"]').setInputFiles(info.cover, { timeout: 15_000 });
          // 等封面上传请求结束、「完成」可点
          await settle(page);
          await pause();
          await modal.locator('button:has-text("完成")').click({ timeout: 15_000 });
          await modal.waitFor({ state: 'hidden', timeout: 60_000 });
          log('封面已设置');
        } catch (err) {
          log(`封面没设置成功，会用小红书默认的封面（${err.message.split('\n')[0]}）`);
          await page.keyboard.press('Escape').catch(() => {});
          await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        }
      }

      // 封面评估还在跑时先等一会儿（最多 1 分钟），不影响发布
      await page.getByText(/评估中|检测中/).first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});

      log('点击发布');
      // 发布按钮在 <xhs-publish-btn> 的封闭 shadow DOM 里，按文字找不到；里面左「暂存离开」右「发布」，各在中心左右 72px
      const bar = page.locator('xhs-publish-btn').first();
      await bar.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForFunction(() => document.querySelector('xhs-publish-btn')?.getAttribute('submit-disabled') === 'false', null, { timeout: 60_000 });
      await pause();
      // 停顿期间页面可能重新评估封面；重新确认后才取坐标、提交一次。
      await page.waitForFunction(() => document.querySelector('xhs-publish-btn')?.getAttribute('submit-disabled') === 'false', null, { timeout: 60_000 });
      const box = await bar.boundingBox();
      if (!box) throw new Error('没找到发布按钮');
      if (info.dryRun) {
        log('试运行：停在点发布之前');
        return { ok: true, dryRun: true, screenshot: await acc.shot(page, 'dryrun') };
      }
      await bar.click({ position: { x: box.width / 2 + 72, y: box.height / 2 } });
      await Promise.race([
        page.waitForURL(/publish\/success/, { timeout: 90_000 }),
        page.getByText('发布成功').first().waitFor({ state: 'visible', timeout: 90_000 }),
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
