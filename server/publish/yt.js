// YouTube 发布：用本机 Chrome 打开 YouTube Studio，模拟人在网页上操作。
// YouTube Data API 能上传，但没通过 Google 审核的项目上传的视频会被强制设为私享，所以和其他平台一样走浏览器自动化。
// Studio 界面会跟随账号语言，选择器尽量用 id / name 属性而不是文字；YouTube 改版后这里要跟着改。
// 登录、检查、解绑这些各平台通用的部分在 browser.js。
import fs from 'node:fs';
import { createBrowserAccounts, waitState, settle, insertChecked } from './browser.js';

const STUDIO = 'https://studio.youtube.com/';
const CREATE = 'ytcp-button.ytcpAppHeaderCreateIcon, #create-icon'; // 顶栏「创建」按钮

// 没登录会跳到 accounts.google.com；登录后 Studio 顶栏有「创建」按钮。
// 后台无界面检查时 Studio 会先显示「不受支持的浏览器」提示页，点它自带的「跳至 YouTube 工作室」继续
async function loggedIn(page) {
  const url = page.url();
  if (!url.includes('studio.youtube.com') || url.includes('accounts.google.com')) return false;
  const create = page.locator(CREATE).first();
  if (await create.isVisible().catch(() => false)) return true;
  const skip = page.getByText(/跳至\s*YouTube\s*工作室|Continue to YouTube Studio/i).first();
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
  return create.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
}

export function createYt({ dataDir }) {
  const acc = createBrowserAccounts({ dataDir, key: 'youtube', name: 'YouTube', app: 'Google 账号', loginUrl: STUDIO, checkUrl: STUDIO, loggedIn, debugPort: false });

  // 往 Studio 的文本框（contenteditable）里写字：先清空，再整段写入并读回核对
  async function fillBox(page, box, text, what) {
    await box.click();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await insertChecked(page, box, String(text || ''), what);
  }

  // ---------- 发布 ----------
  // info: { mp4, cover, title, desc, tags, dryRun }；log(text) 记录每一步
  async function publish(accountId, info, log) {
    acc.ensureBound(accountId);
    if (!fs.existsSync(info.mp4)) throw new Error(`找不到视频文件 ${info.mp4}`);
    const ctx = await acc.openProfile(accountId);
    const page = ctx.pages()[0] || (await ctx.newPage());
    try {
      log('打开 YouTube Studio');
      await page.goto(STUDIO, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (!(await loggedIn(page))) throw new Error('YouTube 登录已失效，去「账号矩阵」重新登录');

      log('上传视频文件');
      // 信息中心有「上传视频」快捷按钮；没有的话走「创建」菜单的第一项
      const quick = page.locator('ytcp-icon-button#upload-icon').first();
      if (await quick.isVisible().catch(() => false)) await quick.click();
      else {
        await page.locator(CREATE).first().click();
        await page.locator('tp-yt-paper-item#text-item-0').first().click({ timeout: 10_000 });
      }
      await page.locator('input[type="file"][name="Filedata"]').first().setInputFiles(info.mp4, { timeout: 30_000 });
      const dialog = page.locator('ytcp-uploads-dialog');
      const titleBox = dialog.locator('#title-textarea #textbox').first();
      await titleBox.waitFor({ state: 'visible', timeout: 180_000 });
      // YouTube 会先把文件名填进标题框，等它填好再改，免得被它覆盖
      await waitState(page, () => (document.querySelector('ytcp-uploads-dialog #title-textarea #textbox')?.innerText || '').trim().length > 0, { timeout: 8000, soft: true });

      log('填写标题和说明');
      await fillBox(page, titleBox, String(info.title || '').slice(0, 100), '标题');
      const tags = (info.tags || []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean);
      // 说明里带上话题标签（#xxx），YouTube 会显示在标题上方
      const desc = [String(info.desc || ''), tags.slice(0, 5).map((t) => `#${t.replace(/\s+/g, '')}`).join(' ')].filter(Boolean).join('\n\n');
      await fillBox(page, dialog.locator('#description-textarea #textbox').first(), desc.slice(0, 5000), '说明');

      if (info.cover && fs.existsSync(info.cover)) {
        log('上传缩略图');
        const thumb = dialog.locator('input#file-loader[type="file"], ytcp-thumbnails-compact-editor-uploader input[type="file"]').first();
        if (await thumb.count()) {
          await thumb.setInputFiles(info.cover, { timeout: 15_000 }).catch((err) => log(`缩略图没传上（${err.message.split('\n')[0]}）`));
          // 等缩略图上传请求结束
          await settle(page);
        } else {
          log('这条会被当作 Shorts，YouTube 网页版不能给 Shorts 换缩略图，跳过');
        }
      }

      log('选择「不是面向儿童的内容」');
      await dialog.locator('tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]').first().click({ timeout: 15_000 });

      // 展开更多选项，填标签
      await dialog.locator('#toggle-button').first().click({ timeout: 8000 }).catch(() => {});
      if (tags.length) {
        const tagBox = dialog.locator('#tags-container input#text-input, ytcp-free-text-chip-bar input').first();
        // 等「更多选项」展开、标签框出现
        if (await tagBox.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
          log('填写标签');
          await tagBox.click();
          // 标签框靠逗号键把输入变成标签，要键盘事件，逐字输入；输完确认至少出现了标签
          await page.keyboard.type(tags.join(',').slice(0, 480) + ',');
          const ok = await waitState(page, () => document.querySelectorAll('ytcp-uploads-dialog #tags-container ytcp-chip, ytcp-uploads-dialog ytcp-free-text-chip-bar ytcp-chip').length > 0, { timeout: 5000, soft: true });
          if (!ok) log('标签没变成标签块，可能没填上');
        }
      }

      log('下一步，直到公开范围');
      for (let i = 0; i < 3; i++) {
        // 「下一步」可点再点，点完等这一步的请求结束
        await waitState(page, () => { const b = document.querySelector('ytcp-uploads-dialog #next-button'); return b && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true'; }, { timeout: 15_000, what: '「下一步」可点' });
        await dialog.locator('#next-button').first().click({ timeout: 15_000 });
        await settle(page, 5000);
      }
      const pub = dialog.locator('tp-yt-paper-radio-button[name="PUBLIC"]').first();
      await pub.click({ timeout: 15_000 });
      // 确认「公开」已经选中
      await waitState(page, () => { const r = document.querySelector('ytcp-uploads-dialog tp-yt-paper-radio-button[name="PUBLIC"]'); return r && (r.hasAttribute('checked') || r.getAttribute('aria-checked') === 'true'); }, { timeout: 5000, what: '「公开」选中' });

      log('等视频上传完成');
      // 「发布」按钮在上传过程中就能点，但上传没完就关浏览器会中断上传，所以看底部进度文字（「正在上传，已完成 8%」）
      const done = dialog.locator('#done-button').first();
      await page.waitForFunction(() => {
        const t = document.querySelector('ytcp-uploads-dialog ytcp-video-upload-progress')?.innerText || '';
        const b = document.querySelector('ytcp-uploads-dialog #done-button');
        return t && !/正在上传|上传中|Uploading|%/.test(t) && b && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true';
      }, null, { timeout: 30 * 60_000, polling: 2000 });
      log(`上传完成（${(await dialog.locator('ytcp-video-upload-progress').first().innerText().catch(() => '')).trim().slice(0, 40)}）`);

      log('点击发布');
      if (info.dryRun) {
        log('试运行：停在点发布之前');
        return { ok: true, dryRun: true, screenshot: await acc.shot(page, 'dryrun') };
      }
      await done.click({ timeout: 15_000 });
      // 发布后弹「视频已发布」或「正在处理视频」（还在转码时），两种都算成功；上传对话框关闭也算
      await Promise.race([
        page.getByText(/视频已发布|正在处理视频|Video published|Video processing/).first().waitFor({ state: 'visible', timeout: 120_000 }),
        dialog.locator('#done-button').first().waitFor({ state: 'detached', timeout: 120_000 }),
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
