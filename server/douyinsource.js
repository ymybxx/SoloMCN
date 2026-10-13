// 抖音话题、征稿和热点：发布前帮 Claude 挑话题。
// - 搜同类热门视频，统计它们带的话题（要登录一个抖音小号；抖音弹滑块验证时，在弹出的窗口里由你自己滑）
// - 话题联想、话题详情（播放量、参与人数、创建时间、简介里的征稿规则）、关联热点：不用登录
// - 创作者中心的官方活动：要登录
// 都是只读：不点赞、不评论、不发布。结果缓存 3 小时。这些是抖音网页自己用的接口，抖音改版了要跟着调。
import path from 'node:path';
import { createBrowserAccounts, sleep } from './publish/browser.js';

const ACC = 'default';
const CREATOR = 'https://creator.douyin.com/';
const CREATOR_HOME = 'https://creator.douyin.com/creator-micro/home';
const TTL = 3 * 3600_000;
const VERIFY_WAIT = 5 * 60_000;
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

export function createDouyinSource({ root, store }) {
  const acc = createBrowserAccounts({
    dataDir: path.join(root, 'data'), key: 'douyin-source', name: '抖音', app: '抖音 App',
    loginUrl: CREATOR, checkUrl: CREATOR_HOME,
    loggedIn: async (page) => {
      if (!page.url().includes('creator-micro')) return false;
      const r = await page.evaluate(() => fetch('/web/api/media/user/info/', { credentials: 'include' }).then((x) => x.json()).catch(() => null)).catch(() => null);
      return r?.status_code === 0;
    },
  });

  // 同一份浏览器配置一次只能开一个：所有查询排队
  let chain = Promise.resolve();
  const queue = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const cache = new Map();
  const cached = async (key, fn) => {
    const c = cache.get(key);
    if (c && Date.now() - c.at < TTL) return c.v;
    const v = await fn();
    cache.set(key, { at: Date.now(), v });
    return v;
  };
  const loggedIn = () => acc.status(ACC).bound;

  // 浏览器关掉后，共用的配置目录会被清一次缓存（browser.js 的 slimProfile，延迟 1 秒）：下一次打开要等它清完，不然页面会卡住
  let lastClose = 0;
  async function session(headless, fn) {
    const wait = lastClose + 2500 - Date.now();
    if (wait > 0) await sleep(wait);
    const ctx = await acc.openProfile(ACC, headless);
    try { return await fn(ctx); } finally { await ctx.close().catch(() => {}); lastClose = Date.now(); }
  }
  // 每个请求最多等 10 秒（抖音偶尔会让请求挂着不回）
  const getJson = async (page, url) => {
    const t = Date.now();
    const r = await page.evaluate(async (u) => { try { return await (await fetch(u, { credentials: 'include', signal: AbortSignal.timeout(10_000) })).json(); } catch { return null; } }, url).catch(() => null);
    if (process.env.DY_DEBUG) console.log('[douyin]', Date.now() - t, 'ms', r ? 'ok' : 'null', url.slice(0, 90), page.url().slice(0, 50));
    return r;
  };
  // 打开抖音网页版的一个页面当「同源」，后面的接口请求从这里发（要带上页面自己的签名和 cookie）
  async function openWww(ctx, cid) {
    const page = await ctx.newPage();
    await page.goto(`https://www.douyin.com/hashtag/${cid}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
    await sleep(2500);
    return ctx.pages().find((p) => p.url().startsWith('https://www.douyin.com')) || page;
  }
  // 话题联想按开头匹配：带空格的短语拆开、去空格各查一次
  const sugWords = (words) => [...new Set(words.flatMap((w) => [w.replace(/\s+/g, ''), ...w.split(/\s+/)]).filter((w) => w.length >= 2))].slice(0, 10);

  // ---------- 不用登录的部分 ----------
  async function suggestOn(page, word) {
    const r = await getJson(page, `/aweme/v1/search/challengesug/?keyword=${encodeURIComponent(word)}&source=challenge_create&aid=2906`);
    return (r?.sug_list || []).map((x) => ({ name: x.cha_name, cid: String(x.cid), views: x.view_count || 0 }));
  }
  async function hotspotsOn(page, words) {
    const rec = await getJson(page, '/aweme/v1/hotspot/recommend/?aid=1128&aweme_name=aweme');
    const out = (rec?.all_sentences || []).map((x) => ({ word: x.word, hot: x.hot_value || 0, at: x.event_time ? x.event_time * 1000 : null, from: '推荐' }));
    for (const w of words.slice(0, 4)) {
      const s = await getJson(page, `/aweme/v1/hotspot/search/?keyword=${encodeURIComponent(w)}&count=50&aid=2906`);
      for (const x of s?.sentences || []) out.push({ word: x.word, hot: x.hot_value || 0, at: x.event_time ? x.event_time * 1000 : null, from: `搜「${w}」` });
    }
    const seen = new Set();
    return out.filter((x) => x.word && !seen.has(x.word) && seen.add(x.word)).sort((a, b) => b.hot - a.hot).slice(0, 40);
  }
  async function activitiesOn(page) {
    const r = await getJson(page, '/web/api/creator/inspiration/activities/?aid=1128');
    return (r?.activities || []).map((a) => ({ name: a.show_name, category: a.query_tag_name, reward: a.activity_incentive_name || '', end: a.end_time ? a.end_time * 1000 : null, pitch: a.recommendation || '', hot: !!a.is_hot, id: a.activity_id }));
  }
  // 话题详情：简介里常写着征稿规则（必带话题、标题前缀、截止、流量扶持）
  async function detailsOn(page, cids) {
    const out = {};
    for (const cid of cids) {
      const r = await getJson(page, `/aweme/v1/web/challenge/detail/?ch_id=${cid}&device_platform=webapp&aid=6383`);
      const c = r?.ch_info;
      if (!c) continue;
      const created = c.create_time ? c.create_time * 1000 : null;
      const days = created ? Math.max(1, (Date.now() - created) / 864e5) : null;
      out[cid] = {
        name: c.cha_name, cid: String(cid), views: c.view_count || 0, users: c.user_count || 0, createdAt: created,
        viewsPerDay: days ? Math.round((c.view_count || 0) / days) : null,
        desc: String(c.desc || '').slice(0, 600),
        campaign: /必带|征稿|投稿激励|流量扶持|截止|即日起|活动时间|参与方式/.test(c.desc || ''),
      };
    }
    return out;
  }

  // ---------- 要登录、可能弹验证的部分：搜同类视频，统计它们带的话题 ----------
  async function setVerify(waiting) {
    await store.set('settings', 'douyinVerify', waiting ? { waiting: true, at: Date.now() } : { waiting: false });
  }
  async function searchTags(words) {
    if (!loggedIn()) return { tags: [], note: '没登录抖音查话题用的小号，跳过搜同类视频' };
    // 要人滑验证时窗口得看得见，所以这一步用可见窗口
    return session(false, async (ctx) => {
      const page = ctx.pages()[0] || (await ctx.newPage());
      const videos = [];
      let loginNeeded = false;
      page.on('response', async (r) => {
        if (!/\/aweme\/v1\/web\/(search\/item|general\/search)/.test(r.url())) return;
        try {
          const j = await r.json();
          if (j.status_code === 2483) loginNeeded = true;
          for (const d of j.data || []) { const a = d.aweme_info || d; if (a?.aweme_id) videos.push(a); }
        } catch {}
      });
      const notes = [];
      for (const w of words.slice(0, 2)) {
        const before = videos.length;
        await page.goto(`https://www.douyin.com/search/${encodeURIComponent(w)}?type=video`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        // 等搜索结果；弹了验证就提醒你去滑，最多等 5 分钟；没弹验证、20 秒还没结果，算这次搜不到
        const start = Date.now();
        let asked = false;
        while (videos.length === before && !loginNeeded) {
          const verify = await page.locator('text=请完成下列验证').first().isVisible().catch(() => false);
          if (verify && !asked) { asked = true; await setVerify(true); await page.bringToFront().catch(() => {}); }
          const waited = Date.now() - start;
          if (asked ? waited > VERIFY_WAIT : !verify && waited > 20_000) break;
          await sleep(1500);
        }
        if (asked) await setVerify(false);
        if (loginNeeded) { notes.push('小号的登录失效了，搜同类视频要重新扫码'); break; }
        if (videos.length === before) notes.push(asked ? `「${w}」的验证没滑，跳过` : `「${w}」没搜到结果`);
        // 多翻一屏，样本多一点
        if (videos.length > before) { await page.mouse.wheel(0, 4000).catch(() => {}); await sleep(2500); }
      }
      const now = Date.now();
      const tags = {};
      for (const a of videos) {
        const recent = a.create_time && now - a.create_time * 1000 < 14 * 864e5;
        for (const t of a.text_extra || []) {
          if (!t.hashtag_name) continue;
          const k = t.hashtag_name;
          tags[k] = tags[k] || { name: k, cid: t.hashtag_id ? String(t.hashtag_id) : null, videos: 0, recent: 0, likes: 0 };
          tags[k].videos++;
          if (recent) tags[k].recent++;
          tags[k].likes += a.statistics?.digg_count || 0;
        }
      }
      return { tags: Object.values(tags).sort((a, b) => b.videos - a.videos || b.likes - a.likes).slice(0, 25), sampled: videos.length, note: notes.join('；') };
    });
  }

  // ---------- 发布前用的总查询 ----------
  // words：描述这条视频内容的几个搜索词（观众会怎么搜这类视频）
  async function research({ words = [], search = true } = {}) {
    words = [...new Set(words.map((w) => String(w).trim()).filter(Boolean))].slice(0, 6);
    if (!words.length) throw bad('至少给一个关键词');
    if (!loggedIn()) throw bad('先在「渠道 → 抖音」扫码登录查话题用的小号');
    return cached(`r:${search ? 1 : 0}:${words.join('|')}`, () => queue(async () => {
      const found = search ? await searchTags(words).catch((e) => ({ tags: [], note: `搜同类视频出错：${e.message.split('\n')[0]}` })) : { tags: [], note: '' };
      return session(true, async (ctx) => {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto(loggedIn() ? CREATOR_HOME : CREATOR, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        const sug = [];
        for (const w of sugWords(words)) sug.push(...(await suggestOn(page, w)).slice(0, 3));
        const hot = await hotspotsOn(page, words);
        const acts = loggedIn() ? await activitiesOn(page) : [];
        // 搜到的话题没带 id 的，用联想补上 id
        for (const t of found.tags.filter((x) => !x.cid).slice(0, 10)) t.cid = (await suggestOn(page, t.name)).find((x) => x.name === t.name)?.cid || null;
        // 候选：同类视频里出现的 + 联想到的
        const byCid = new Map();
        for (const t of found.tags) if (t.cid) byCid.set(t.cid, { name: t.name, cid: t.cid, fromVideos: { videos: t.videos, recent: t.recent, likes: t.likes } });
        for (const x of sug) if (!byCid.has(x.cid)) byCid.set(x.cid, { name: x.name, cid: x.cid, fromSuggest: true });
        const cids = [...byCid.keys()].slice(0, 30);
        const det = cids.length ? await detailsOn(await openWww(ctx, cids[0]), cids) : {};
        const candidates = cids.map((cid) => ({ ...byCid.get(cid), ...(det[cid] || {}) }));
        return { words, searched: found.tags.length > 0, sampledVideos: found.sampled || 0, note: found.note || '', candidates, hotspots: hot, activities: acts, at: Date.now() };
      });
    }));
  }

  // ---------- 登录（查话题用的小号，和发布账号分开） ----------
  return {
    research,
    loggedIn,
    login: {
      status: () => acc.status(ACC),
      start: () => acc.startLogin(ACC),
      finish: () => acc.finishLogin(ACC),
      progress: (id) => acc.loginStatus(id),
      check: () => acc.check(ACC),
      logout: () => { acc.unbind(ACC); cache.clear(); return { ok: true }; },
    },
  };
}
