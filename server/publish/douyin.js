// 抖音发布：用本机 Chrome 打开抖音创作者中心，模拟人在网页上操作。
// 抖音的官方发布接口只对政府机关和事业单位开放，所以走浏览器自动化。
// 页面结构最初参考开源项目 social-auto-upload，之后按实际页面校正过；抖音改版后这里的选择器要跟着改。
// 登录、检查、解绑这些各平台通用的部分在 browser.js。
import fs from 'node:fs';
import { createBrowserAccounts, waitState, settle, fillChecked, insertChecked } from './browser.js';

const CREATOR = 'https://creator.douyin.com/';
const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload';
const LOGIN_MARKERS = ['扫码登录', '手机号登录', '验证码登录', '密码登录'];

// 没登录时，上传页地址不会跳走，而是显示创作者中心的介绍页；所以除了排除登录提示，还要看到登录后才有的东西
async function loggedIn(page) {
  if (!page.url().includes('creator.douyin.com/creator-micro')) return false;
  const visible = (t) => page.getByText(t, { exact: true }).first().isVisible().catch(() => false);
  if (await page.getByText('抖音创作者的一站式创作与服务平台').first().isVisible().catch(() => false)) return false;
  for (const t of LOGIN_MARKERS) if (await visible(t)) return false;
  if (await page.locator('input[type="file"]').count().catch(() => 0)) return true;
  for (const t of ['发布视频', '高清发布', '作品管理', '数据中心', '内容管理']) if (await visible(t)) return true;
  return false;
}

export function createDouyin({ dataDir }) {
  const acc = createBrowserAccounts({ dataDir, key: 'douyin', name: '抖音', app: '抖音 App', loginUrl: CREATOR, checkUrl: UPLOAD_URL, loggedIn });

  // ---------- 发布 ----------
  // info: { mp4, cover（竖封面 3:4）, cover2（横封面 4:3）, title, desc, tags, aiDeclare }；log(text) 记录每一步
  async function publish(accountId, info, log) {
    acc.ensureBound(accountId);
    if (!fs.existsSync(info.mp4)) throw new Error(`找不到视频文件 ${info.mp4}`);
    const ctx = await acc.openProfile(accountId);
    const page = ctx.pages()[0] || (await ctx.newPage());
    try {
      log('打开抖音创作者中心的上传页');
      await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // 等上传框出现（没登录时显示的是介绍页，上传框不会出现）
      await page.locator('input[type="file"]').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
      if (!(await loggedIn(page))) throw new Error('抖音登录已失效，去「账号矩阵」重新扫码');

      log('上传视频文件');
      const input = page.locator('input.upload-btn-input, div[class^="container"] input[accept], input[type="file"]').first();
      await input.setInputFiles(info.mp4, { timeout: 30_000 });
      await page.waitForURL(/creator-micro\/content\/(publish|post\/video)/, { timeout: 180_000 });
      log('进入发布页，填写标题和描述');
      const desc = page.locator('div.zone-container[contenteditable="true"]').first();
      await desc.waitFor({ state: 'visible', timeout: 30_000 });

      const title = String(info.title || '').slice(0, 30);
      const titleBox = page.locator('input[placeholder*="填写作品标题"]').first();
      const hasTitle = await titleBox.isVisible().catch(() => false);
      if (hasTitle) await fillChecked(titleBox, title, '标题');
      else log('没找到标题框，标题会写进描述的第一行');

      await desc.click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      await insertChecked(page, desc, String((hasTitle ? info.desc : `${title}\n${info.desc}`) || ''), '描述');
      for (const raw of (info.tags || []).slice(0, 5)) {
        const tag = String(raw).replace(/^#/, '').trim();
        if (!tag) continue;
        // 话题联想要靠键盘事件触发，话题词逐字输入；确认已经打进框里、等联想出来（最多 3 秒），再用空格确认
        await page.keyboard.type(` #${tag}`);
        await waitState(page, ([t]) => document.querySelector('div.zone-container')?.innerText.includes(t), { arg: [`#${tag}`], timeout: 5000, what: `话题「${tag}」输入` });
        await waitState(page, ([t]) => [...document.querySelectorAll('[class*="mention"], [class*="topic"], [class*="suggest"]')].some((el) => el.offsetParent && !el.closest('.zone-container') && el.innerText.includes(t)), { arg: [tag], timeout: 3000, soft: true });
        await page.keyboard.press('Space');
      }

      // 系列对应的合集：按名字精确选；抖音里没有这个合集就跳过（合集要先在抖音创作者中心建好）
      if (info.collection) {
        log(`放进合集「${info.collection}」`);
        try {
          await page.locator('[class*="select-collection"]').first().click({ timeout: 8000 });
          const opt = page.locator('.semi-select-option.collection-option').filter({ has: page.locator('[class*="option-title"]').getByText(info.collection, { exact: true }) }).first();
          await opt.click({ timeout: 8000 });
          // 选中后合集框里显示这个名字
          await page.locator('[class*="select-collection"]').filter({ hasText: info.collection }).first().waitFor({ state: 'visible', timeout: 5000 });
        } catch {
          log(`抖音里没有叫「${info.collection}」的合集，跳过`);
          await page.keyboard.press('Escape').catch(() => {});
        }
      }

      log('等视频上传完成');
      await page.getByText('重新上传').first().waitFor({ state: 'visible', timeout: 15 * 60_000 });

      await page.getByRole('button', { name: '我知道了' }).click({ timeout: 2000 }).catch(() => {});

      if (info.cover && fs.existsSync(info.cover)) {
        // 抖音要两张封面：竖封面 3:4 和横封面 4:3，分别上传；只有竖封面时，横封面由抖音按竖封面自动生成
        const modal = page.locator('.dy-creator-content-modal');
        // 弹窗里有好几个上传框（左边那个是「生成参考图」），封面要传到「点击上传文件」那个
        const uploadIn = (file) => modal.locator('.semi-upload:has-text("点击上传文件") input.semi-upload-hidden-input').first().setInputFiles(file, { timeout: 15_000 });
        const closeModal = async () => {
          await modal.locator('[class*=close]').first().click({ timeout: 3000 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
          await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
        };
        const finish = async () => {
          await settle(page); // 等封面上传请求结束
          await modal.locator('button:has-text("完成")').last().click({ timeout: 15_000 });
          await modal.waitFor({ state: 'hidden', timeout: 90_000 });
        };
        const wide = info.cover2 && fs.existsSync(info.cover2) ? info.cover2 : null;
        let vertical = false;
        log('上传竖封面（3:4）');
        try {
          await page.getByText('选择封面').first().click({ timeout: 10_000 });
          await modal.waitFor({ state: 'visible', timeout: 10_000 });
          // 弹窗顶部有竖封面 / 横封面切换时，先切到竖封面
          await modal.getByText(/竖封面/).first().click({ timeout: 3000 }).catch(() => {});
          await uploadIn(info.cover);
          if (wide) {
            // 同一个弹窗里能切到横封面就在这里传
            const tab = modal.getByText(/横封面/).first();
            if (await tab.isVisible().catch(() => false)) {
              await settle(page);
              await tab.click({ timeout: 5000 });
              log('上传横封面（4:3）');
              await uploadIn(wide);
              await finish();
              log('竖封面、横封面都已设置');
              vertical = 'both';
            }
          }
          if (!vertical) { await finish(); vertical = true; log('竖封面已设置'); }
        } catch (err) {
          log(`竖封面没设置成功，会用抖音自动选的封面（${err.message.split('\n')[0]}）`);
          await closeModal();
        }
        if (wide && vertical === true) {
          // 弹窗里没有切换时，点页面上「横封面4:3」那张缩略图，单独打开横封面的设置
          log('上传横封面（4:3）');
          try {
            await page.getByText(/横封面\s*4:3/).first().locator('xpath=..').click({ timeout: 8000 });
            await modal.waitFor({ state: 'visible', timeout: 10_000 });
            await modal.getByText(/横封面/).first().click({ timeout: 3000 }).catch(() => {});
            await uploadIn(wide);
            await finish();
            log('横封面已设置');
          } catch (err) {
            log(`横封面没设置成功，用抖音按竖封面生成的横封面（${err.message.split('\n')[0]}）`);
            await closeModal();
          }
        }
      }

      if (info.aiDeclare) { // 默认不选，需要时传 aiDeclare: true
        log('勾选「内容由 AI 生成」声明');
        try {
          await page.getByText('请选择自主声明').first().click({ timeout: 8_000 });
          await page.locator('label.semi-radio:has-text("内容由AI生成")').click({ timeout: 8_000 });
          await page.locator('button:has-text("确定")').last().click({ timeout: 8_000 });
          await page.getByText('内容由AI生成', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        } catch (err) {
          log(`没找到声明选项，跳过（${err.message.split('\n')[0]}）`);
          await page.keyboard.press('Escape').catch(() => {});
        }
      }

      // 封面检测、内容检测还在跑时先等一会儿（最多 1 分钟），不影响发布
      await page.getByText(/检测中/).first().waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => {});

      log('点击发布');
      const btn = page.getByRole('button', { name: '发布', exact: true });
      if (info.dryRun) {
        log('试运行：停在点发布之前');
        return { ok: true, dryRun: true, screenshot: await acc.shot(page, 'dryrun') };
      }
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 15_000 });
      await page.waitForURL(/creator-micro\/content\/manage/, { timeout: 90_000 });
      log('发布成功，已跳转到作品管理页');
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
