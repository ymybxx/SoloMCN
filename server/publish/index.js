// 发布：生成各平台的发布信息（标题、描述、话题、封面图），人确认后发到勾选的平台。
// 进度和结果都写在内容卡片的 publish 字段上，页面实时看到。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runClaude } from '../cli.js';
import { modelFor, effortFor } from '../models.js';
import { createDouyin } from './douyin.js';
import { createXhs } from './xhs.js';
import { generateImage } from '../../tools/img.mjs';
import { imageConfig } from '../secrets.js';
import { createBili } from './bili.js';
import { createYt } from './yt.js';
import { createX } from './x.js';
import { seriesOf } from '../series.js';
import { creativeBlock } from '../prompts.js';

// 视频是不是竖屏（宽 < 高）。读不出来就当竖屏：工作台做的都是竖屏短视频
function isPortrait(mp4) {
  try {
    const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', mp4], { encoding: 'utf8', timeout: 10_000 }).trim().split(',').map(Number);
    return !(w > h);
  } catch {
    return true;
  }
}

// 封面两种做法：在「设置 → 连接」里配了图片生成（OpenAI 兼容接口），就让 Claude 写提示词、AI 画一张；
// 没配就从成片里截一帧。截下来的画面完整放进平台要的比例里，四周空出来的地方用同一帧放大模糊后铺满，
// 竖屏视频放进横版封面、横屏视频放进竖版封面都不会裁掉标题。
// 平台显示封面的比例：抖音竖封面、小红书 3:4；抖音横封面 4:3；B站、YouTube 16:9
const COVER_SIZES = { cover: [1080, 1440], coverWide: [1920, 1080], coverWide43: [1440, 1080] };
function frameCover(mp4, t, out, [w, h]) {
  const fill = `[0:v]split[a][b];[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=40:5[bg];` +
    `[b]scale=${w}:${h}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, t)), '-i', mp4, '-frames:v', '1', '-filter_complex', fill, out], { timeout: 60_000 });
  return out;
}
// 从中间裁成指定比例（图片接口给的比例不一定准，生成后在本机裁准）
function cropTo(src, out, w, h) {
  const tmp = `${out}.crop.png`; // 先写临时文件再改名，原地裁剪时不会边读边写
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})'`, tmp], { timeout: 60_000 });
  fs.renameSync(tmp, out);
  return out;
}
const SAFE_TALL = '\n\n这张图会从中间裁成 3:4 显示（抖音、小红书的封面比例）：标题文字和主体都放在画面中间 3:4 的范围里，最上面和最下面各留出约 15% 只放背景，不放任何文字。';
const SAFE_WIDE = '\n\n画面改为横版 16:9 构图。这张图还会从中间裁成 4:3 当抖音横封面：标题文字和主体都放在画面中间 4:3 的范围里（标题居中），最左边和最右边各留出约 15% 只放背景，不放任何文字。';
function duration(mp4) {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8', timeout: 10_000 }).trim()) || 0;
  } catch {
    return 0;
  }
}

export const PUBLISH_PLATFORMS = [
  { k: 'douyin', n: '抖音', ready: true },
  { k: 'bilibili', n: 'B站', ready: true },
  { k: 'xhs', n: '小红书', ready: true },
  { k: 'youtube', n: 'YouTube', ready: true },
  { k: 'x', n: '推特', ready: true },
];

const PLATFORM_INFO = { type: 'object', required: ['title', 'desc', 'tags'], properties: { title: { type: 'string' }, desc: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } };
// 各平台文案要求；生成时可以只写其中几个（比如新接入的平台补文案）
const PLATFORM_RULES = {
  douyin: 'douyin：title 不超过 30 字，前几个字就要有钩子；desc 一到三句，最后一句引导评论；tags 3–5 个，和内容相关、大家会搜的词，不带 #',
  bilibili: 'bilibili：title 不超过 80 字，可以更完整；desc 写清楚这期讲了什么，有调研来源就列出主要来源；tags 5–10 个',
  youtube: 'youtube：和视频同一种语言；title 不超过 100 字，可以带一两个英文关键词方便搜索；desc 写清楚这期讲了什么，有调研来源就列出主要来源；tags 5–10 个，可以中英文混合',
  x: 'x（推特）：desc 就是推文正文。中文视频写中英双语：先一段中文、空一行、再一段英文，意思一致；其他语言的视频只用那一种语言。按推特的算法中文每个字算 2、英文字母和空格算 1，正文合计不超过 240（中英双语大约中文 60 字加英文 100 个字母）；不放链接；title 写一句短标题，只在工作台里看，不会发出去；tags 1–3 个，不带 #',
  xhs: 'xhs：title 不超过 20 字；desc 写成小红书笔记的口吻，100–300 字，分段；tags 5–8 个',
};
const PUBLISH_KEYS = Object.keys(PLATFORM_RULES);
const imageReady = () => !!imageConfig().apiKey;
export const infoSchema = (keys, withCover) => {
  const cover = withCover ? (imageReady() ? ['cover_prompt', 'cover_time'] : ['cover_time']) : [];
  return {
    type: 'object',
    required: [...cover, ...keys],
    properties: { ...Object.fromEntries(cover.map((k) => [k, { type: k === 'cover_time' ? 'number' : 'string' }])), ...Object.fromEntries(keys.map((k) => [k, PLATFORM_INFO])) },
  };
};

export function infoPrompt(item, account = {}, keys = PUBLISH_KEYS, withCover = true, root = process.cwd()) {
  return `为下面这条短视频写${keys.length < PUBLISH_KEYS.length ? '这几个平台' : '各平台'}的发布信息${withCover ? (imageReady() ? '，写一段封面图的生成提示词，再选一帧备用' : '，并选一帧当封面') : ''}。用这条视频的语言写（按系列和脚本，系列没写明就用中文）。

账号：${account.code || ''} ${account.name || ''}
${creativeBlock(account, item)}
选题：${item.title}
钩子：${item.hook || ''}
概要：${item.angle || ''}

${item.video?.guide ? `作者的说明（最重要，按这个方向写）：\n${item.video.guide}\n` : ''}${item.script ? `脚本（节选）：\n${String(item.script).slice(0, 5000)}` : ''}${!item.script && item.video?.watch?.status === 'done' ? `这条是作者现成的视频，没有脚本。先用读文件工具逐张看下面这几张画面缩略图（每格左上角是时间点，每 ${item.video.watch.every} 秒一帧），再结合语音转文字，弄清视频讲了什么、画面里有什么，再写发布信息：\n${item.video.watch.sheets.map((f) => path.resolve(root, f)).join('\n')}\n${item.video.watch.transcript ? `\n语音转文字（机器识别，专有名词可能听错，以画面为准）：\n${item.video.watch.transcript.slice(0, 6000)}\n` : `\n（${item.video.watch.transcriptNote || '没有语音转文字'}）\n`}` : ''}
${item.research?.text ? `\n调研报告（节选，标题和描述里的数字只能用这里有出处的）：\n${item.research.text.slice(0, 2500)}\n` : ''}
要求：
${keys.map((k) => '- ' + PLATFORM_RULES[k]).join('\n')}
${withCover && imageReady() ? '- cover_prompt：竖版封面图的生成提示词，描述画面构图、颜色和风格（贴合账号风格），画面上要有一行醒目的中文大标题（不超过 12 个字，写清楚具体文字），高对比、文字清晰；不画真人的脸（AI 画出的真人脸属于伪造）\n' : ''}${withCover ? '- cover_time：封面从成片里截哪一秒（可以带小数）。选标题字最醒目、画面最完整、没有转场的一帧，通常是开头的标题画面；按脚本里的分镜时间估，不确定就填 1\n' : ''}- 不夸大，不用"震惊""必看"这类标题党词，不写没有依据的数字
- 所有平台的标题、描述、话题都不点名其他平台和交易平台（闲鱼、淘宝、拼多多、抖音、B站、小红书、微信等），需要时用泛称（"二手市场""某视频网站"）；不写联系方式、链接、"私信领""评论区扣1"这类引导
- 描述里不列具体商品价格（¥xxx、$xx/月）和"XX 官方价格页"，具体数字留在视频里讲，描述只写结论；来源写成"各家官方定价、公开评测榜单、二手市场成交价"这样的泛称（B站曾因简介里"闲鱼二手成交价 + 显卡价格"被判违规推广，简介被删）`;
}

export function createPublisher({ store, root }) {
  // 走浏览器自动化、需要扫码绑定的平台
  const browsers = { douyin: createDouyin({ dataDir: path.join(root, 'data') }), xhs: createXhs({ dataDir: path.join(root, 'data') }), bilibili: createBili({ dataDir: path.join(root, 'data') }), youtube: createYt({ dataDir: path.join(root, 'data') }), x: createX({ dataDir: path.join(root, 'data') }) };
  const abs = (rel) => path.resolve(root, rel);
  // 没有脚本的现成视频：把“看”过的画面缩略图交给 Claude
  const watchImages = (it) => (!it.script && it.video?.watch?.status === 'done' ? (it.video.watch.sheets || []).map(abs) : []);
  let publishing = null; // 同一时间只发一条，避免同账号短时间连续操作

  const getItem = (id) => {
    const it = store.get('items', id);
    if (!it) throw Object.assign(new Error('找不到这条内容'), { status: 404 });
    return it;
  };
  const coverDir = (it) => path.join(it.video?.project || 'videos/_covers', 'publish');

  // ---------- 生成发布信息 + 封面 ----------
  async function generateInfo(itemId, { coverOnly = false, coverTime, coverPrompt, mode, missingOnly = false } = {}) {
    const it = getItem(itemId);
    if (!it.video?.mp4) throw Object.assign(new Error('先生成视频'), { status: 400 });
    if (it.publish?.gen?.status === 'running') throw Object.assign(new Error('正在生成，稍等'), { status: 409 });
    if (it.video.watch?.status === 'running') throw Object.assign(new Error('Claude 还在看这条视频（截画面、转文字），一般不到一分钟，好了再生成'), { status: 409 });
    // 补文案：只给还没有发布信息的平台写（比如新接入的平台），已经写好、改过的不动，也不重新生成封面
    const missing = PUBLISH_KEYS.filter((k) => !it.publish?.platforms?.[k]);
    if (missingOnly && !missing.length) throw Object.assign(new Error('各平台都已经有发布信息了'), { status: 400 });
    if (missingOnly && !it.publish?.platforms) throw Object.assign(new Error('先生成发布信息'), { status: 400 });
    await store.update('items', itemId, { publish: { gen: { status: 'running', message: coverOnly ? '正在截取封面' : missingOnly ? `Claude 正在补写${missing.map((k) => PUBLISH_PLATFORMS.find((p) => p.k === k)?.n || k).join('、')}的文案` : 'Claude 正在写各平台的标题、描述和话题', at: Date.now() } } });
    (async () => {
      try {
        const clean = (p) => ({ title: String(p.title || '').trim(), desc: String(p.desc || '').trim(), tags: (p.tags || []).map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean) });
        if (missingOnly) {
          const account = store.get('accounts', it.accountId) || {};
          const { structured: r } = await runClaude(infoPrompt(it, account, missing, false, root), { model: modelFor(store, 'publish'), effort: effortFor(store, 'publish'), schema: infoSchema(missing, false), images: watchImages(it) });
          if (!r) throw new Error('Claude 没有返回发布信息');
          await store.update('items', itemId, { publish: { platforms: Object.fromEntries(missing.map((k) => [k, clean(r[k] || {})])), gen: { status: 'done', message: '', at: Date.now() } } });
          return;
        }
        let t = coverTime ?? it.publish?.coverTime;
        let prompt = coverPrompt || it.publish?.coverPrompt;
        if (!coverOnly) {
          const account = store.get('accounts', it.accountId) || {};
          const { structured: r } = await runClaude(infoPrompt(it, account, PUBLISH_KEYS, true, root), { model: modelFor(store, 'publish'), effort: effortFor(store, 'publish'), schema: infoSchema(PUBLISH_KEYS, true), images: watchImages(it) });
          if (!r) throw new Error('Claude 没有返回发布信息');
          t = r.cover_time;
          prompt = r.cover_prompt || prompt;
          await store.update('items', itemId, { publish: { platforms: Object.fromEntries(PUBLISH_KEYS.map((k) => [k, clean(r[k] || {})])), coverPrompt: prompt || null, selected: it.publish?.selected || ['douyin'], gen: { status: 'running', message: '正在做封面', at: Date.now() } } });
        }
        // 三种比例：cover 3:4（抖音竖封面、小红书）· coverWide 16:9（B站、YouTube）· coverWide43 4:3（抖音横封面）
        const ts = Date.now();
        fs.mkdirSync(abs(coverDir(it)), { recursive: true });
        const useAi = mode !== 'frame' && imageReady() && prompt;
        if (useAi) {
          const rel = path.join(coverDir(it), `cover-${ts}.png`);
          const relWide = path.join(coverDir(it), `cover-wide-${ts}.png`);
          const relWide43 = path.join(coverDir(it), `cover-wide43-${ts}.png`);
          // 同一段提示词同时画竖版、横版两张，再裁成平台要的比例
          const wide = generateImage({ prompt: prompt + SAFE_WIDE, out: abs(relWide), size: '1536x1024' })
            .then(() => { cropTo(abs(relWide), abs(relWide), 16, 9); cropTo(abs(relWide), abs(relWide43), 4, 3); return true; }).catch(() => false);
          await generateImage({ prompt: prompt + SAFE_TALL, out: abs(rel), size: '1024x1536' });
          cropTo(abs(rel), abs(rel), 3, 4);
          const wideOk = await wide;
          await store.update('items', itemId, { publish: { cover: rel, coverWide: wideOk ? relWide : null, coverWide43: wideOk ? relWide43 : null, coverKind: 'ai', coverPrompt: prompt, gen: { status: 'done', message: wideOk ? '' : '横版封面没生成出来，B站会用竖版封面裁剪，抖音只传竖封面', at: Date.now() } } });
          return;
        }
        // 从成片截一帧
        const mp4 = abs(it.video.mp4);
        const len = duration(mp4);
        t = Math.min(Math.max(0, Number(t) || 1), len ? Math.max(0, len - 0.1) : Infinity);
        const files = {};
        for (const [k, size] of Object.entries(COVER_SIZES)) {
          files[k] = path.join(coverDir(it), `${k === 'cover' ? 'cover' : k === 'coverWide' ? 'cover-wide' : 'cover-wide43'}-${ts}.jpg`);
          frameCover(mp4, t, abs(files[k]), size);
        }
        await store.update('items', itemId, { publish: { ...files, coverKind: 'frame', coverTime: Math.round(t * 10) / 10, gen: { status: 'done', message: '', at: Date.now() } } });
      } catch (err) {
        await store.update('items', itemId, { publish: { gen: { status: 'failed', message: err.message, at: Date.now() } } });
      }
    })();
    return { started: true };
  }

  // ---------- 发布到勾选的平台 ----------
  // 各平台的发布页（手动发布时在你平时用的浏览器里打开）
  const UPLOAD_PAGES = {
    douyin: 'https://creator.douyin.com/creator-micro/content/upload',
    xhs: 'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch&target=video',
    bilibili: 'https://member.bilibili.com/platform/upload/video/frame',
    youtube: 'https://studio.youtube.com/',
    x: 'https://x.com/compose/post',
  };
  const stamp = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  // 勾选的平台都发完了（自动的发成功、手动的点了「我已发布」），卡片进「已发布」
  async function markIfAllDone(itemId) {
    const it = store.get('items', itemId);
    const sel = it?.publish?.selected || [];
    if (sel.length && sel.every((p) => it.publish.results?.[p]?.status === 'done') && it.stage !== 'published') {
      await store.update('items', itemId, { stage: 'published', publishedAt: stamp(), updatedAt: Date.now() });
    }
  }

  // platforms：自动发布的平台；manual：手动发布的平台（工作台不碰这个平台，只把要复制的东西和文件准备好）
  async function publish(itemId, platforms, manual = []) {
    const it = getItem(itemId);
    if (!it.video?.mp4) throw Object.assign(new Error('先生成视频'), { status: 400 });
    if (!it.publish?.platforms) throw Object.assign(new Error('先生成发布信息'), { status: 400 });
    if (it.publish?.gen?.status === 'running') throw Object.assign(new Error('发布信息或封面还在生成，等它好了再发'), { status: 409 });
    const valid = (list) => [...new Set((list || []).filter((p) => PUBLISH_PLATFORMS.some((x) => x.k === p)))];
    const manualList = valid(manual);
    const autoList = valid(platforms).filter((p) => !manualList.includes(p));
    const chosen = [...autoList, ...manualList];
    if (!chosen.length) throw Object.assign(new Error('至少勾选一个平台'), { status: 400 });
    const notReady = autoList.filter((p) => !PUBLISH_PLATFORMS.find((x) => x.k === p).ready);
    if (notReady.length) throw Object.assign(new Error(`${notReady.map((p) => PUBLISH_PLATFORMS.find((x) => x.k === p).n).join('、')}还没接入自动发布，可以勾「手动发」`), { status: 400 });
    if (autoList.length && publishing) throw Object.assign(new Error('正在发布另一条，等它结束'), { status: 409 });
    const unbound = autoList.filter((p) => browsers[p] && !browsers[p].status(it.accountId).bound);
    if (unbound.length) throw Object.assign(new Error(`这个账号还没绑定${unbound.map((p) => browsers[p].name).join('、')}，先去「账号矩阵」扫码登录，或者勾「手动发」`), { status: 400 });

    const portrait = isPortrait(abs(it.video.mp4));
    // B站封面只收横版；YouTube 跟着视频走：竖屏视频会被当成 Shorts，缩略图按竖版截取，所以用竖版，横屏视频才用横版
    const coverFor = (k) => ((k === 'bilibili' || (k === 'youtube' && !portrait)) && it.publish.coverWide) || it.publish.cover;
    // 第二张封面：抖音要竖封面 3:4 和横封面 4:3 两张，分别传
    const cover2For = (k) => (k === 'douyin' && it.publish.coverWide43) || null;
    const absOrNull = (f) => (f ? abs(f) : null);
    const collectionFor = (k) => seriesOf(store.get('accounts', it.accountId), it.seriesId)?.collections?.[k] || '';
    await store.update('items', itemId, { publish: { selected: chosen } });
    // 手动发布：记下要用的视频、封面、合集和发布页，等人点「我已发布」
    for (const p of manualList) {
      await store.update('items', itemId, { publish: { results: { [p]: { status: 'manual', manual: true, video: abs(it.video.mp4), cover: absOrNull(coverFor(p)), cover2: absOrNull(cover2For(p)), collection: collectionFor(p), url: UPLOAD_PAGES[p] || '', steps: [], error: null, screenshot: null, at: Date.now() } } } });
    }
    if (!autoList.length) return { started: true, manual: manualList };

    publishing = itemId;
    (async () => {
      for (const p of autoList) {
        const steps = [];
        const save = () => store.update('items', itemId, { publish: { results: { [p]: { status: 'running', manual: false, steps: [...steps], error: null, screenshot: null, at: Date.now() } } } });
        await save();
        const log = (text) => {
          steps.push({ at: Date.now(), text });
          save();
        };
        let result;
        try {
          const info = it.publish.platforms[p] || {};
          await browsers[p].publish(it.accountId, { mp4: abs(it.video.mp4), cover: absOrNull(coverFor(p)), cover2: absOrNull(cover2For(p)), title: info.title, desc: info.desc, tags: info.tags, collection: collectionFor(p) }, log);
          result = { status: 'done', steps, error: null, screenshot: null, at: Date.now() };
        } catch (err) {
          result = { status: 'failed', steps, error: err.message.split('\n')[0].slice(0, 300), screenshot: err.screenshot ? path.relative(root, err.screenshot) : null, at: Date.now() };
        }
        await store.update('items', itemId, { publish: { results: { [p]: result } } });
      }
      publishing = null;
      await markIfAllDone(itemId);
    })();
    return { started: true, manual: manualList };
  }

  // 手动发布：人在平台上发完了 / 不发了
  async function manualDone(itemId, p) {
    const it = getItem(itemId);
    if (it.publish?.results?.[p]?.status !== 'manual') throw Object.assign(new Error('这个平台不在手动发布中'), { status: 400 });
    await store.update('items', itemId, { publish: { results: { [p]: { status: 'done', manual: true, at: Date.now() } } } });
    await markIfAllDone(itemId);
    return { ok: true };
  }
  async function manualCancel(itemId, p) {
    const it = getItem(itemId);
    if (it.publish?.results?.[p]?.status !== 'manual') throw Object.assign(new Error('这个平台不在手动发布中'), { status: 400 });
    await store.update('items', itemId, { publish: { results: { [p]: { status: 'cancelled', manual: true, at: Date.now() } }, selected: (it.publish.selected || []).filter((x) => x !== p) } });
    await markIfAllDone(itemId);
    return { ok: true };
  }

  return {
    browsers,
    loginStatus: (id) => Object.values(browsers).map((b) => b.loginStatus(id)).find(Boolean) || null,
    generateInfo,
    publish,
    manualDone,
    manualCancel,
    accounts: () => Object.fromEntries(Object.keys(store.all().accounts).map((id) => [id, Object.fromEntries(Object.entries(browsers).map(([k, b]) => [k, b.status(id)]))])),
    platforms: () => PUBLISH_PLATFORMS,
  };
}
