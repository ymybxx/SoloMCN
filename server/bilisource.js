// B站视频素材：搜视频、读详情、按弹幕找高能时刻、把视频的一段剪下来存成这条内容的素材。
// 调研时用（追星舞台、综艺、游戏、影视这类要用真实片段的选题）。只用公开接口，一次只下一个，不批量扒站。
// 不登录最高 480P；在「渠道 → B站热门视频」扫码登录一个 B站账号后能下 1080P。这个登录和发布用的 B站账号分开，
// cookie 存在 data/bilibili-cookies.json（只有本机账号能读，不进 git）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createBrowserAccounts } from './publish/browser.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const API = 'https://api.bilibili.com';
// wbi 签名的打乱表（B站网页端公开的固定表）
const MIX = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const MAX_CLIP_S = 420; // 一次最多剪这么长（整首歌的直拍也能一次下完）
const MAX_HEIGHT = 1080; // 素材够用就行，不下 4K
const MIN_GAP_MS = 1500; // 两次请求 B站至少隔这么久

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const day = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : undefined);
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// "3:10" / "1:02:03" -> 秒
const seconds = (t) => String(t || '').split(':').reduce((n, x) => n * 60 + (Number(x) || 0), 0);

// BV 号、av 号或视频链接 -> { bvid } / { aid }，链接里的 ?p= 一起认出来
export function parseVideo(v) {
  const s = String(v || '').trim();
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  const p = Number(s.match(/[?&]p=(\d+)/)?.[1]) || undefined;
  if (bv) return { bvid: bv[0], p };
  const av = s.match(/(?:^|\/|av)(\d{4,})/i);
  if (av) return { aid: av[1], p };
  throw badRequest(`认不出这个 B站视频：${s.slice(0, 80)}（给 BV 号或视频链接）`);
}

export function createBiliSource({ root }) {
  const cookieFile = path.join(root, 'data', 'bilibili-cookies.json');
  let guest = null; // 没登录时用的访客 cookie（buvid3）
  let mixin = null; // wbi 签名的 key，每小时刷新
  let last = 0;
  let queue = Promise.resolve(); // 下载一次只跑一个

  const login = () => { try { return JSON.parse(fs.readFileSync(cookieFile, 'utf8')); } catch { return null; } };
  async function cookie() {
    const l = login();
    if (l?.cookie) return l.cookie;
    if (!guest) {
      const r = await fetch(`${API}/x/frontend/finger/spi`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15_000) }).then((x) => x.json());
      guest = `buvid3=${r.data.b_3}; buvid4=${encodeURIComponent(r.data.b_4)}`;
    }
    return guest;
  }

  async function get(pathname, params, { signed = false } = {}) {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: await cookie() };
    const q = signed ? await sign(params) : new URLSearchParams(params).toString();
    let r;
    try {
      r = await fetch(`${API}${pathname}?${q}`, { headers, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error('连不上 B站接口，稍后再试');
    }
    const d = await r.json().catch(() => null);
    if (!d) throw new Error(`B站接口返回 ${r.status}`);
    if (d.code === -352 || d.code === -412 || r.status === 412) throw new Error('B站把这次请求当成了异常访问（风控），过几分钟再试，别连续重试');
    if (d.code === -404 || d.code === 62002 || d.code === 62004) throw badRequest('视频不存在、已删除或不公开');
    if (d.code !== 0) throw new Error(`B站接口报错：${d.message || d.code}`);
    return d.data;
  }

  async function sign(params) {
    if (!mixin || Date.now() - mixin.at > 3600_000) {
      const nav = await fetch(`${API}/x/web-interface/nav`, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: await cookie() }, signal: AbortSignal.timeout(15_000) }).then((x) => x.json());
      const key = (u) => String(u).split('/').pop().split('.')[0];
      const raw = key(nav.data.wbi_img.img_url) + key(nav.data.wbi_img.sub_url);
      mixin = { key: MIX.map((i) => raw[i]).join('').slice(0, 32), at: Date.now() };
    }
    const p = { ...params, wts: Math.floor(Date.now() / 1000) };
    const q = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&');
    return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin.key).digest('hex')}`;
  }

  // ---------- 搜索 ----------
  async function search({ q, order = 'totalrank', limit = 20, days = 0, duration = 0 }) {
    if (!String(q || '').trim()) throw badRequest('关键词不能为空');
    const params = { search_type: 'video', keyword: String(q).trim().slice(0, 100), order, page: 1 };
    if (duration) params.duration = duration; // 1: 10 分钟以下 2: 10–30 3: 30–60 4: 60 以上
    const d = await get('/x/web-interface/wbi/search/type', params, { signed: true });
    const since = days > 0 ? Date.now() / 1000 - days * 86400 : 0;
    const videos = (d.result || []).filter((v) => v.type === 'video' && v.pubdate >= since).slice(0, Math.min(50, limit)).map((v) => ({
      bvid: v.bvid,
      title: strip(v.title),
      owner: v.author,
      duration: mmss(seconds(v.duration)),
      plays: v.play,
      danmaku: v.video_review,
      favorites: v.favorites,
      publishedAt: day(v.pubdate),
      tags: v.tag ? String(v.tag).split(',').slice(0, 8).join('、') : undefined,
      desc: strip(v.description).slice(0, 160) || undefined,
      url: `https://www.bilibili.com/video/${v.bvid}`,
    }));
    return { videos };
  }

  // ---------- 详情 ----------
  async function view(v) {
    const id = parseVideo(v);
    const d = await get('/x/web-interface/wbi/view', id.bvid ? { bvid: id.bvid } : { aid: id.aid }, { signed: true });
    return { d, p: id.p };
  }

  async function videos(list) {
    const out = [];
    for (const v of list.slice(0, 10)) {
      try {
        const { d } = await view(v);
        out.push({
          bvid: d.bvid,
          title: d.title,
          owner: d.owner?.name,
          ownerMid: d.owner?.mid,
          copyright: d.copyright === 1 ? '自制' : '转载',
          duration: mmss(d.duration),
          publishedAt: day(d.pubdate),
          stats: { plays: d.stat?.view, danmaku: d.stat?.danmaku, likes: d.stat?.like, coins: d.stat?.coin, favorites: d.stat?.favorite, shares: d.stat?.share },
          size: d.dimension ? `${d.dimension.rotate ? d.dimension.height : d.dimension.width}×${d.dimension.rotate ? d.dimension.width : d.dimension.height}` : undefined,
          pages: d.pages?.length > 1 ? d.pages.map((x) => ({ p: x.page, title: x.part, duration: mmss(x.duration) })) : undefined,
          desc: String(d.desc || '').slice(0, 600) || undefined,
          url: `https://www.bilibili.com/video/${d.bvid}`,
        });
      } catch (err) {
        out.push({ video: String(v), error: err.message });
      }
    }
    return { videos: out };
  }

  // ---------- 高能时刻：按弹幕密度找观众反应最强的几段 ----------
  async function highlights(v, { window: win = 5, top = 8 } = {}) {
    const { d, p } = await view(v);
    const page = d.pages?.find((x) => x.page === (p || 1)) || d.pages?.[0];
    if (!page) throw badRequest('这个视频没有可读的分P');
    let xml;
    try {
      xml = await fetch(`https://comment.bilibili.com/${page.cid}.xml`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) }).then((r) => r.text());
    } catch {
      throw new Error('读不到这个视频的弹幕');
    }
    const items = [...xml.matchAll(/<d p="([\d.]+),[^"]*">([^<]*)<\/d>/g)].map((m) => [Number(m[1]), strip(m[2])]);
    if (!items.length) return { bvid: d.bvid, title: d.title, duration: mmss(page.duration), danmaku: 0, moments: [] };
    const w = Math.max(2, Math.min(30, win));
    const buckets = new Map();
    for (const [t, text] of items) {
      const k = Math.floor(t / w);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(text);
    }
    const avg = items.length / Math.max(1, Math.ceil(page.duration / w));
    // 取最密的几段，相邻的段合并成一段
    const picked = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, Math.max(1, Math.min(20, top)) * 2).map(([k]) => k).sort((a, b) => a - b);
    const ranges = [];
    for (const k of picked) {
      const r = ranges.at(-1);
      if (r && k <= r.to + 1) r.to = k;
      else ranges.push({ from: k, to: k });
    }
    const moments = ranges.map((r) => {
      const texts = [];
      for (let k = r.from; k <= r.to; k++) texts.push(...(buckets.get(k) || []));
      const count = new Map();
      for (const t of texts) if (t.length <= 30) count.set(t, (count.get(t) || 0) + 1);
      return {
        start: mmss(r.from * w),
        end: mmss(Math.min(page.duration, (r.to + 1) * w)),
        density: Math.round((texts.length / (r.to - r.from + 1) / avg) * 10) / 10,
        say: [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, n]) => (n > 1 ? `${t}×${n}` : t)),
      };
    }).sort((a, b) => b.density - a.density).slice(0, top);
    return { bvid: d.bvid, title: d.title, p: page.page, duration: mmss(page.duration), danmaku: items.length, moments };
  }

  // ---------- 预览：B站自带的进度条缩略图，拼成一张带时间的图 ----------
  // 下载之前先看造型、机位、主角在不在画面里；out 是要写的 jpg 路径
  async function preview(v, out, { count = 24 } = {}) {
    const { d, p } = await view(v);
    const page = d.pages?.find((x) => x.page === (p || 1)) || d.pages?.[0];
    const shot = await get('/x/player/videoshot', { bvid: d.bvid, cid: page?.cid || d.cid, index: 1 });
    const sprites = (shot.image || []).map((u) => (u.startsWith('//') ? `https:${u}` : u));
    if (!sprites.length) throw new Error('这条视频没有进度条缩略图');
    const per = shot.img_x_len * shot.img_y_len, W = shot.img_x_size, H = shot.img_y_size;
    const times = (shot.index || []).slice(1); // 第 0 个是占位
    const total = Math.min(times.length || per * sprites.length, per * sprites.length);
    const n = Math.max(4, Math.min(48, count, total));
    const picks = Array.from({ length: n }, (_, i) => Math.floor((i * (total - 1)) / Math.max(1, n - 1)));
    const tmp = fs.mkdtempSync(path.join(path.dirname(out), '.preview-'));
    try {
      const files = [];
      for (const [si, url] of sprites.entries()) {
        if (!picks.some((k) => Math.floor(k / per) === si)) continue;
        const buf = Buffer.from(await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(30_000) }).then((r) => r.arrayBuffer()));
        fs.writeFileSync(path.join(tmp, `s${si}.jpg`), buf);
      }
      const font = ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf'].find((f) => fs.existsSync(f));
      for (const [i, k] of picks.entries()) {
        const si = Math.floor(k / per), j = k % per;
        const x = (j % shot.img_x_len) * W, y = Math.floor(j / shot.img_x_len) * H;
        const label = mmss(times[k] ?? 0);
        const vf = `crop=${W}:${H}:${x}:${y},scale=320:-2${font ? `,drawtext=fontfile='${font}':text='${label.replace(':', '\\:')}':x=6:y=6:fontsize=20:fontcolor=yellow:shadowcolor=black:shadowx=1:shadowy=1` : ''}`;
        await new Promise((ok, no) => execFile('ffmpeg', ['-v', 'error', '-y', '-i', path.join(tmp, `s${si}.jpg`), '-vf', vf, path.join(tmp, `t${String(i).padStart(3, '0')}.jpg`)], (e) => (e ? no(e) : ok())));
      }
      const cols = 6;
      await new Promise((ok, no) => execFile('ffmpeg', ['-v', 'error', '-y', '-pattern_type', 'glob', '-i', path.join(tmp, 't*.jpg'), '-vf', `tile=${cols}x${Math.ceil(n / cols)}`, '-frames:v', '1', out], (e) => (e ? no(e) : ok())));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return { bvid: d.bvid, title: d.title, duration: mmss(page?.duration || d.duration), frames: picks.map((k) => mmss(times[k] ?? 0)) };
  }

  // ---------- 剪一段存成素材 ----------
  // 返回 { file, part, url, title, quality, start, end }，file 相对项目根目录
  function clip(args) {
    const run = queue.then(() => doClip(args));
    queue = run.catch(() => {});
    return run;
  }

  async function doClip({ itemId, video, start, end }) {
    const { d, p } = await view(video);
    const page = d.pages?.find((x) => x.page === (p || 1)) || d.pages?.[0];
    if (!page) throw badRequest('这个视频没有可读的分P');
    const from = Math.max(0, seconds(start));
    const to = Math.min(page.duration, end ? seconds(end) : from + 30);
    if (to - from < 1) throw badRequest(`时间段不对：${mmss(from)}–${mmss(to)}（视频共 ${mmss(page.duration)}）`);
    if (to - from > MAX_CLIP_S) throw badRequest(`一段最多剪 ${MAX_CLIP_S / 60} 分钟，分成几段剪`);

    const pu = await get('/x/player/wbi/playurl', { bvid: d.bvid, cid: page.cid, qn: 80, fnval: 4048, fourk: 0 }, { signed: true });
    const dash = pu.dash;
    if (!dash?.video?.length) throw new Error('B站没有给出可下载的视频流（可能是付费、会员专享或地区限制）');
    // 画质：1080P 以内最高的一档，优先 H.264（解码最省事），同一档里码率最高
    const codecRank = (c) => (c.startsWith('avc') ? 0 : c.startsWith('hev') ? 1 : 2);
    const vs = dash.video.filter((x) => Math.min(x.width, x.height) <= MAX_HEIGHT);
    const best = (vs.length ? vs : dash.video).sort((a, b) => Math.min(b.width, b.height) - Math.min(a.width, a.height) || codecRank(a.codecs) - codecRank(b.codecs) || b.bandwidth - a.bandwidth)[0];
    const audio = [...(dash.audio || []), ...(dash.flac?.audio ? [dash.flac.audio] : [])].sort((a, b) => b.bandwidth - a.bandwidth)[0];

    const rel = path.join('videos', '_assets', itemId);
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    const name = `${Date.now().toString(36)}-bili-${d.bvid}-${Math.floor(from)}-${Math.floor(to)}.mp4`;
    const out = path.join(root, rel, name);
    const hdr = `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`;
    const input = (url) => ['-headers', hdr, '-ss', String(from), '-to', String(to), '-i', url];
    // 重新编码成每秒一个关键帧的 H.264，做视频时逐帧定位才准
    const args = ['-hide_banner', '-v', 'error', '-y', ...input(best.baseUrl || best.base_url), ...(audio ? input(audio.baseUrl || audio.base_url) : []),
      '-map', '0:v:0', ...(audio ? ['-map', '1:a:0'] : []),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30',
      ...(audio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []), '-movflags', '+faststart', out];
    try {
      await new Promise((resolve, reject) => execFile('ffmpeg', args, { timeout: 300_000, maxBuffer: 4 << 20 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split('\n').pop())) : resolve())));
    } catch (err) {
      fs.rmSync(out, { force: true });
      throw new Error(`剪片段失败：${err.message.slice(0, 200)}`);
    }
    const h = Math.min(best.width, best.height);
    return {
      file: path.join(rel, name),
      part: `B站片段 ${mmss(from)}–${mmss(to)}${p ? ` · P${page.page}` : ''} · ${h}P`,
      url: `https://www.bilibili.com/video/${d.bvid}${p ? `?p=${page.page}` : ''}`,
      title: `${d.title}（UP 主：${d.owner?.name || '未知'}）`,
      quality: `${best.width}×${best.height}`,
      loggedIn: !!login()?.cookie,
      start: mmss(from),
      end: mmss(to),
    };
  }

  // ---------- 登录（可选，只为了下 1080P） ----------
  const acc = createBrowserAccounts({
    dataDir: path.join(root, 'data'), key: 'bilibili-source', name: 'B站', app: '哔哩哔哩 App',
    loginUrl: 'https://passport.bilibili.com/login', checkUrl: 'https://www.bilibili.com/', debugPort: false,
    loggedIn: async (page) => {
      if (!page.url().includes('bilibili.com')) return false;
      const r = await page.evaluate(() => fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then((x) => x.json()).catch(() => null)).catch(() => null);
      return !!r?.data?.isLogin;
    },
  });
  const ACC = 'default';

  async function exportCookies() {
    const ctx = await acc.openProfile(ACC, true);
    try {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      const nav = await page.evaluate(() => fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' }).then((x) => x.json())).catch(() => null);
      if (!nav?.data?.isLogin) throw new Error('B站没有登录，重新扫码登录一次');
      const cookies = (await ctx.cookies(['https://www.bilibili.com', 'https://api.bilibili.com'])).filter((c) => c.domain.endsWith('bilibili.com'));
      const data = { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '), uname: nav.data.uname, vip: !!nav.data.vipStatus, at: Date.now() };
      fs.writeFileSync(cookieFile, JSON.stringify(data), { mode: 0o600 });
      fs.chmodSync(cookieFile, 0o600);
      mixin = null;
      return data;
    } finally {
      await ctx.close().catch(() => {});
    }
  }

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
    mixin = null;
    return { ok: true };
  }

  return {
    search,
    videos,
    highlights,
    preview,
    clip,
    login: {
      status: () => { const l = login(); return { ...acc.status(ACC), loggedIn: !!l?.cookie, uname: l?.uname, at: l?.at }; },
      start: () => acc.startLogin(ACC),
      finish: () => acc.finishLogin(ACC),
      progress,
      check,
      logout,
    },
  };
}
