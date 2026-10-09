// 系列：账号只是一个频道（名称、平台、各平台的登录绑定、一句话大方向），创作上的东西都在系列里——
// 目标人群、主角和语气、配音、视觉风格、主打情绪、定位、固定结构、时长、题材、各平台的合集。
// 一个账号可以有几个系列，每条内容属于其中一个；没选系列时只按账号的大方向做。

export const COLLECTION_PLATFORMS = ['douyin', 'bilibili', 'xhs', 'youtube'];
export const SERIES_TEXT_FIELDS = { name: 30, audience: 200, persona: 400, visual: 400, summary: 200, structure: 600, length: 40, topics: 300 };

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

// 页面或 Claude 交来的系列，整理成固定结构
export function cleanSeries(list) {
  return (Array.isArray(list) ? list : []).filter((s) => s && String(s.name || '').trim()).slice(0, 12).map((s, i) => ({
    id: /^[A-Za-z0-9_-]{1,40}$/.test(s.id || '') ? s.id : `s${Date.now().toString(36)}${i}`,
    ...Object.fromEntries(Object.entries(SERIES_TEXT_FIELDS).map(([k, n]) => [k, clip(s[k], n)])),
    voice: s.voice ? clip(s.voice, 60) : null,
    emotions: (Array.isArray(s.emotions) ? s.emotions : []).map((e) => clip(e, 10)).filter(Boolean).slice(0, 4),
    collections: Object.fromEntries(COLLECTION_PLATFORMS.map((p) => [p, clip(s.collections?.[p], 40)]).filter(([, v]) => v)),
    active: s.active !== false,
  }));
}

export const seriesOf = (account, seriesId) => (account?.series || []).find((s) => s.id === seriesId) || null;
const bare = (n) => String(n || '').replace(/[《》「」"“”]/g, '').trim();

// 按 id 或名字认出系列（Claude 写选题时填的是系列名）；账号只有一个系列时直接用它
export function resolveSeries(account, v) {
  const list = (account?.series || []).filter((s) => s.active !== false);
  const key = bare(v);
  return list.find((s) => s.id === key || bare(s.name) === key) || (list.length === 1 ? list[0] : null);
}

// 一条内容实际用的创作设定：有系列用系列，没有就退回账号的大方向（以及老数据里账号上的人设、风格）
export function creativeOf(account = {}, item = {}) {
  const s = seriesOf(account, item.seriesId);
  return {
    series: s,
    audience: s?.audience || account.audience || '',
    persona: s?.persona || account.persona || '',
    visual: s?.visual || account.style || '',
    voice: s?.voice || account.voice || null,
    emotions: s?.emotions?.length ? s.emotions : account.emotions || [],
    brief: account.brief || '',
  };
}

// 给提示词用的一段系列说明
export function seriesText(s) {
  if (!s) return '';
  return [
    `系列：《${bare(s.name)}》${s.summary ? `——${s.summary}` : ''}`,
    s.audience && `目标人群：${s.audience}`,
    s.persona && `主角和语气：${s.persona}`,
    s.visual && `视觉风格：${s.visual}`,
    s.emotions?.length && `主打情绪：${s.emotions.join('、')}`,
    s.structure && `固定结构：${s.structure}`,
    s.length && `时长：${s.length}`,
    s.topics && `适合的题材：${s.topics}`,
  ].filter(Boolean).join('\n');
}

// 账号的系列清单（一行一个），出选题、精选时用
export const seriesMenu = (account) => (account?.series || []).filter((s) => s.active !== false)
  .map((s) => `《${bare(s.name)}》${s.summary ? `：${s.summary}` : ''}${s.audience ? `（人群：${s.audience}）` : ''}`).join('；');
