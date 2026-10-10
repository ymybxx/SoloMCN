// B站投稿：用本机 Chrome 打开 B站创作中心，模拟人在网页上操作。
// B站开放平台的投稿接口要先申请开发者资质，个人号用不了，所以走浏览器自动化。
// 选择器按 2026-10 的实际页面校正过；B站改版后这里要跟着改。
// 登录、检查、解绑这些各平台通用的部分在 browser.js。
import fs from 'node:fs';
import { createBrowserAccounts, waitState, settle, fillChecked, insertChecked } from './browser.js';

const CREATOR = 'https://member.bilibili.com/platform/home';
const UPLOAD_URL = 'https://member.bilibili.com/platform/upload/video/frame';
const LOGIN_MARKERS = ['扫码登录', '密码登录', '短信登录'];

// 没登录会跳到 passport.bilibili.com；登录后创作中心有「投稿」入口或上传框
async function loggedIn(page) {
  const url = page.url();
  if (!url.includes('member.bilibili.com') || url.includes('passport.bilibili.com')) return false;
  const visible = (t) => page.getByText(t, { exact: true }).first().isVisible().catch(() => false);
  for (const t of LOGIN_MARKERS) if (await visible(t)) return false;
  if (await page.locator('input[type="file"]').count().catch(() => 0)) return true;
  for (const t of ['投稿', '内容管理', '数据中心', '上传视频']) if (await visible(t)) return true;
  return false;
}

export function createBili({ dataDir }) {
  const acc = createBrowserAccounts({ dataDir, key: 'bilibili', name: 'B站', app: '哔哩哔哩 App', loginUrl: CREATOR, checkUrl: UPLOAD_URL, loggedIn });

  // ---------- 发布 ----------
  // info: { mp4, cover, title, desc, tags, dryRun }；log(text) 记录每一步
  async function publish(accountId, info, log) {
    acc.ensureBound(accountId);
    if (!fs.existsSync(info.mp4)) throw new Error(`找不到视频文件 ${info.mp4}`);
    const ctx = await acc.openProfile(accountId);
    const page = ctx.pages()[0] || (await ctx.newPage());
    const bodyText = () => page.evaluate(() => document.body.innerText);
    try {
      log('打开 B站创作中心的投稿页');
      await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      // 等上传框出现（没登录会跳到登录页）
      await page.locator('input[type="file"][accept*=".mp4"]').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => {});
      if (!(await loggedIn(page))) throw new Error('B站登录已失效，去「账号矩阵」重新扫码');

      // 之前没提交的稿件会在上传框上方提示「本地浏览器存在 N 个未提交的视频」，挡住新上传；点「不用了」清掉再传
      const drafts = page.getByText('不用了', { exact: true }).first();
      if (await drafts.isVisible().catch(() => false)) {
        log('清掉之前没提交的本地草稿');
        await drafts.click({ timeout: 5000 }).catch(() => {});
        await drafts.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }

      log('上传视频文件');
      const titleBox = page.locator('input[placeholder*="稿件标题"]').first();
      // 像人一样点「上传视频」，在选文件窗口里选视频（不弹系统窗口，由浏览器自动化接管）；
      // B站改版后页面上会同时存在新旧几个上传框，直接往某个 input 里塞文件容易塞进不起作用的那个
      const viaButton = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15_000 }),
        page.getByText('上传视频', { exact: true }).last().click({ timeout: 10_000 }),
      ]).then(([chooser]) => chooser.setFiles(info.mp4)).then(() => true, () => false);
      let started = viaButton && (await titleBox.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false));
      // 点按钮不行：挨个试页面上能收视频的上传框，从后往前（新的上传框在后面）
      if (!started) {
        const inputs = page.locator('input[type="file"][accept*=".mp4"]');
        for (let i = (await inputs.count()) - 1; i >= 0 && !started; i--) {
          await inputs.nth(i).setInputFiles(info.mp4, { timeout: 30_000 }).catch(() => {});
          started = await titleBox.waitFor({ state: 'visible', timeout: 30_000 }).then(() => true, () => false);
        }
      }
      if (!started) await titleBox.waitFor({ state: 'visible', timeout: 120_000 });

      log('填写标题、创作声明、标签和简介');
      await fillChecked(titleBox, String(info.title || '').slice(0, 80), '标题');
      // 创作声明是必填项，选「内容无需标注」
      await page.locator('input[placeholder*="创作声明"]').click();
      await page.locator('li.bcc-option:has-text("内容无需标注")').first().click({ timeout: 8000 });
      await waitState(page, () => document.querySelector('input[placeholder*="创作声明"]')?.value === '内容无需标注', { timeout: 5000, what: '创作声明选中' });
      // B站会按视频自动预填几个标签（常常不相关），先删掉再填自己的
      for (let i = 0; i < 12; i++) {
        const x = page.locator('#tag-container .tag-pre-wrp .label-item-v2-container svg').first();
        if (!(await x.count())) break;
        const before = await page.locator('#tag-container .tag-pre-wrp .label-item-v2-container').count();
        await x.click();
        // 等这个标签真的删掉，再删下一个
        const gone = await waitState(page, ([b]) => document.querySelectorAll('#tag-container .tag-pre-wrp .label-item-v2-container').length < b, { arg: [before], timeout: 5000, soft: true });
        if (!gone) { log('有预填标签删不掉，留着'); break; }
      }
      const tagBox = page.locator('#tag-container input[placeholder*="创建标签"]').first();
      for (const raw of (info.tags || []).slice(0, 10)) {
        const tag = String(raw).replace(/^#/, '').slice(0, 20).trim();
        if (!tag) continue;
        await tagBox.fill(tag);
        await tagBox.press('Enter');
        // 等标签出现在标签栏里，再加下一个；重复或不允许的标签 B站不加，记一笔继续
        const added = await waitState(page, ([t]) => [...document.querySelectorAll('#tag-container .label-item-v2-content')].some((el) => el.innerText.trim() === t), { arg: [tag], timeout: 4000, soft: true });
        if (!added) log(`标签「${tag}」没加上，跳过`);
      }
      if (info.desc) {
        // 简介编辑器会把行首的「- 」「1. 」自动变成列表，之后每行都多出符号；换成不会触发的写法
        const desc = String(info.desc).replace(/^[ \t]*[-*•][ \t]+/gm, '· ').replace(/^[ \t]*(\d+)\.[ \t]+/gm, '$1）');
        await insertChecked(page, page.locator('.ql-editor').first(), desc.slice(0, 2000), '简介');
      }

      log('等视频上传完成');
      // 页面上一直有「不需等待上传完成哦」这句提示，所以看「上传中」和进度是否消失
      await page.waitForFunction(() => !/上传中|已经上传：/.test(document.body.innerText), null, { timeout: 15 * 60_000, polling: 2000 });
      if (/上传失败/.test(await bodyText())) throw new Error('B站提示视频上传失败');

      if (info.cover && fs.existsSync(info.cover)) {
        log('上传自定义封面');
        try {
          await page.getByText('添加封面', { exact: true }).first().click({ timeout: 10_000 });
          await page.locator('.sync-checkbox-wrapper label').first().waitFor({ state: 'visible', timeout: 10_000 });
          // 4:3 和 16:9 两个比例都要有封面，勾上「双比例同步改动」后一次上传两边都用上
          const sync = page.locator('.sync-checkbox-wrapper label').first();
          if (!/checked/.test((await sync.getAttribute('class')) || '')) await sync.click();
          await page.locator('input[type="file"][accept*="image"]').last().setInputFiles(info.cover, { timeout: 15_000 });
          // 等封面上传请求结束
          await settle(page);
          await page.locator('.cover-editor-button .button.submit').first().click({ timeout: 10_000 });
          // 点完成后按钮变成「制作中…」，等弹窗关掉、封面栏的「添加封面」消失才算设置好
          await page.locator('.cover-editor-button .button.submit').first().waitFor({ state: 'hidden', timeout: 90_000 });
          await page.getByText('添加封面', { exact: true }).first().waitFor({ state: 'hidden', timeout: 15_000 });
          log('封面已设置');
        } catch (err) {
          log(`封面没设置成功，会用 B站推荐的封面（${err.message.split('\n')[0]}）`);
          await page.keyboard.press('Escape').catch(() => {});
        }
      }

      log('点击立即投稿');
      const btn = page.locator('span.submit-add:text-is("立即投稿")').first();
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      if (info.dryRun) {
        log('试运行：停在点投稿之前');
        return { ok: true, dryRun: true, screenshot: await acc.shot(page, 'dryrun') };
      }
      await btn.click({ timeout: 15_000 });
      await page.getByText(/稿件投递成功|投稿成功/).first().waitFor({ state: 'visible', timeout: 90_000 });
      log('投稿成功');
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
