// AI 任务：页面通过 HTTP 调用，以后的定时任务也可以直接 import 这些函数。
import { randomUUID } from 'node:crypto';
import { modelFor, effortFor } from './models.js';
import { runClaude } from './cli.js';
import { resolveSeries } from './series.js';
import { ideasPrompt, scriptPrompt, checkPrompt, analysisPrompt } from './prompts.js';

const STAGE_ORDER = ['idea', 'script', 'production', 'review', 'scheduled', 'published'];
const PLATFORMS = ['douyin', 'bilibili', 'xhs'];
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12);

// 结构化输出的格式（claude -p --json-schema）
const SCORE = { type: 'integer', minimum: 1, maximum: 5 };
const IDEAS_SCHEMA = {
  type: 'object',
  required: ['ideas'],
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['account', 'title', 'hook', 'angle', 'emotions', 'format', 'scores', 'risk'],
        properties: {
          account: { type: 'string' },
          title: { type: 'string' },
          hook: { type: 'string' },
          angle: { type: 'string' },
          emotions: { type: 'array', items: { type: 'string' } },
          format: { type: 'string' },
          series: { type: 'string' },
          scores: { type: 'object', required: ['hook', 'emotion', 'relate', 'social'], properties: { hook: SCORE, emotion: SCORE, relate: SCORE, social: SCORE } },
          risk: { type: 'string' },
        },
      },
    },
  },
};
const CHECK_SCHEMA = {
  type: 'object',
  required: ['items', 'advice'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'pass', 'note'],
        properties: { key: { enum: ['notMisleading', 'noRealPerson', 'hook', 'emotion', 'anxiety'] }, pass: { type: 'boolean' }, note: { type: 'string' } },
      },
    },
    advice: { type: 'string' },
  },
};

const sortedAccounts = (store) =>
  Object.entries(store.all().accounts)
    .map(([id, a]) => ({ id, ...a }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

const metric = (item, key) => PLATFORMS.reduce((s, p) => s + (Number(item.metrics?.[p]?.[key]) || 0), 0);

// 按人设批量生成选题，追加到选题雷达
export async function generateIdeas(store, { accountIds = [], text = '', n = 3 }, { signal } = {}) {
  const accounts = sortedAccounts(store).filter((a) => accountIds.includes(a.id));
  if (!accounts.length) throw Object.assign(new Error('至少选一个账号'), { code: 'bad_input' });
  const count = [2, 3, 5].includes(Number(n)) ? Number(n) : 3;

  const { structured } = await runClaude(ideasPrompt(accounts, text.trim(), count), { model: modelFor(store, 'ideas'), effort: effortFor(store, 'ideas'), schema: IDEAS_SCHEMA, signal });
  return appendIdeas(store, structured?.ideas || [], { text: text.trim(), by: 'claude' });
}

// 把选题追加到选题雷达。account 可以是账号代号（A）或账号 id。页面生成和 MCP 工具共用。
export async function appendIdeas(store, rawIdeas, { text, by = 'api' } = {}) {
  const accounts = sortedAccounts(store);
  const resolve = (v) => {
    const s = String(v || '').replace(/[[\]]/g, '').trim();
    return accounts.find((a) => a.id === s || String(a.code).toUpperCase() === s.toUpperCase())?.id;
  };
  const rejected = [];
  const fresh = [];
  for (const x of Array.isArray(rawIdeas) ? rawIdeas : []) {
    if (!x || !x.title) continue;
    const accountId = resolve(x.account ?? x.accountId);
    if (!accountId) {
      rejected.push(`${x.title}（找不到账号 ${x.account ?? x.accountId}）`);
      continue;
    }
    const clip = (v, n) => String(v || '').slice(0, n);
    const series = resolveSeries(accounts.find((a) => a.id === accountId), x.series ?? x.seriesId);
    fresh.push({
      id: shortId(),
      accountId,
      seriesId: series?.id || null,
      title: clip(x.title, 80),
      hook: clip(x.hook, 300),
      angle: clip(x.angle, 400),
      emotions: Array.isArray(x.emotions) ? x.emotions.map(String).slice(0, 4) : [],
      format: clip(x.format, 30),
      scores: {
        hook: Number(x.scores?.hook) || 0,
        emotion: Number(x.scores?.emotion) || 0,
        relate: Number(x.scores?.relate) || 0,
        social: Number(x.scores?.social) || 0,
      },
      risk: clip(x.risk, 200),
      trend: x.trend ? { title: clip(x.trend.title, 120), platforms: clip(x.trend.platforms, 120) } : null,
      whyNow: clip(x.whyNow, 200),
      pickId: x.pickId && store.get('picks', x.pickId) ? x.pickId : null,
      by,
    });
  }
  for (const pickId of new Set(fresh.map((d) => d.pickId).filter(Boolean))) {
    await store.update('picks', pickId, { status: 'ideas', updatedAt: Date.now() });
  }
  const prevRadar = store.get('radar', 'latest') || {};
  const radar = await store.set('radar', 'latest', {
    text: text ?? prevRadar.text ?? '',
    ideas: [...fresh, ...(prevRadar.ideas || [])].slice(0, 80),
    at: Date.now(),
  });
  return { added: fresh.length, rejected, radar };
}

// Claude 只给了渠道和 id 时，按渠道补上原帖链接
function sourceUrl(s) {
  const id = String(s?.id || '');
  if (!id) return '';
  if (s.channel === 'douyin') return 'https://www.douyin.com/search/' + encodeURIComponent(id);
  if (s.channel === 'x' && /^\d+$/.test(id)) return 'https://x.com/i/status/' + id;
  return '';
}

// 选题雷达的精选：Claude 从各渠道素材里挑出值得做的主题，等人决定给哪些账号出题
export async function appendPicks(store, rawPicks, { by = 'claude', runId = null } = {}) {
  const accounts = sortedAccounts(store);
  const code = (v) => accounts.find((a) => a.id === v || String(a.code).toUpperCase() === String(v || '').trim().toUpperCase())?.id;
  const clip = (v, n) => String(v || '').slice(0, n);
  const added = [];
  const now = Date.now();
  for (const x of Array.isArray(rawPicks) ? rawPicks : []) {
    if (!x || !x.title) continue;
    const id = shortId();
    await store.set('picks', id, {
      title: clip(x.title, 60),
      why: clip(x.why, 300),
      angle: clip(x.angle, 300),
      sources: (Array.isArray(x.sources) ? x.sources : []).slice(0, 8).map((s) => ({
        channel: clip(s?.channel, 20),
        id: clip(s?.id, 200),
        title: clip(s?.title, 200),
        url: /^https?:\/\//.test(s?.url || '') ? clip(s.url, 500) : sourceUrl(s),
      })),
      accounts: (Array.isArray(x.accounts) ? x.accounts : []).map(code).filter(Boolean),
      risk: clip(x.risk, 200),
      status: 'new',
      by,
      runId,
      createdAt: now,
      updatedAt: now,
    });
    added.push(id);
  }
  return { added };
}

// 写分镜脚本，流式输出，写完保存到内容并推进到「脚本」阶段
export async function writeScript(store, { itemId, draft = {} }, { signal, onText } = {}) {
  const item = store.get('items', itemId);
  if (!item) throw Object.assign(new Error('内容不存在'), { code: 'not_found' });
  const merged = { ...item, ...pick(draft, ['title', 'hook', 'angle']) };
  const account = store.get('accounts', merged.accountId) || {};

  const { text, truncated } = await runClaude(scriptPrompt(account, merged), { model: modelFor(store, 'script'), effort: effortFor(store, 'script'), signal, onText });
  const stageIdx = STAGE_ORDER.indexOf(item.stage || 'idea');
  const saved = await store.update('items', itemId, {
    ...pick(draft, ['title', 'hook', 'angle']),
    script: text,
    stage: stageIdx < 1 ? 'script' : item.stage,
    updatedAt: Date.now(),
  });
  return { text, truncated, item: saved };
}

// AI 预审：只给参考意见，不替人勾审核清单
export async function precheck(store, { itemId, draft = {} }, { signal } = {}) {
  const item = store.get('items', itemId);
  if (!item) throw Object.assign(new Error('内容不存在'), { code: 'not_found' });
  const merged = { ...item, ...pick(draft, ['title', 'hook', 'script']) };
  merged.script = String(merged.script || '').slice(0, 8000);
  const { structured: r } = await runClaude(checkPrompt(merged), { model: modelFor(store, 'check'), effort: effortFor(store, 'check'), schema: CHECK_SCHEMA, signal });
  const precheck = {
    items: Array.isArray(r?.items) ? r.items.map((x) => ({ key: String(x.key), pass: !!x.pass, note: String(x.note || '') })) : [],
    advice: String(r?.advice || ''),
    at: Date.now(),
  };
  // 和后台 Agent 预审一样存在卡片上，下次打开还能看到
  await store.update('items', itemId, { precheck });
  return precheck;
}

// 数据复盘，流式输出，结果保存在 notes/analysis
export async function analyze(store, { signal, onText } = {}) {
  const { items } = store.all();
  const accounts = sortedAccounts(store);
  const published = Object.values(items).filter((i) => i.stage === 'published');
  if (!published.length) throw Object.assign(new Error('还没有已发布的内容'), { code: 'bad_input' });
  const rows = published.map((i) => {
    const a = store.get('accounts', i.accountId);
    return `${a?.code || '?'}｜${i.title}｜情绪：${(i.emotions || []).join('/')}｜形式：${i.format || ''}｜播放 ${metric(i, 'views')}｜赞 ${metric(i, 'likes')}｜评 ${metric(i, 'comments')}｜转 ${metric(i, 'shares')}｜粉 ${metric(i, 'follows')}｜发布 ${i.publishedAt || ''}`;
  });
  const { text } = await runClaude(analysisPrompt(accounts, rows), { model: modelFor(store, 'analysis'), effort: effortFor(store, 'analysis'), signal, onText });
  const note = await store.set('notes', 'analysis', { text, at: Date.now() });
  return { text, note };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (typeof obj[k] === 'string') out[k] = obj[k];
  return out;
}
