// 本地服务：提供页面、数据接口和 AI 接口。只监听本机地址。
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, COLLECTIONS } from './store.js';
import { SEED_ACCOUNTS } from './seed.js';
import { generateIdeas, appendIdeas, appendPicks, writeScript, precheck, analyze } from './tasks.js';
import { createAgent } from './agent.js';
import { createPublisher } from './publish/index.js';
import { modelSettings, modelFor, effortFor } from './models.js';
import { createSkills, voicesFile } from './skills.js';
import { createSetupCheck } from './setupcheck.js';
import { runClaude } from './cli.js';
import { captureSource } from './assets.js';
import { watchVideo, probe } from './watch.js';
import { publicConfig, setImage, clearImage, setClaudeToken, clearClaudeToken } from './secrets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(root, 'public');
const PORT = Number(process.env.PORT) || 5178;
const HOST = process.env.HOST || '127.0.0.1';
// 热点数据服务（hot-service，独立的 Python 服务），默认端口是工作台端口 + 1
const HOT_PORT = Number(process.env.HOT_PORT) || PORT + 1;
const HOT_URL = process.env.HOT_SERVICE_URL || `http://127.0.0.1:${HOT_PORT}`;
// 后台 Claude 的 MCP 服务（server/mcp.js）从环境变量里找工作台地址，换了端口也能连对
process.env.WORKBENCH_URL ||= `http://127.0.0.1:${PORT}`;

// 页面通过 /api/events 订阅数据变化，Claude 经 MCP 写入的内容能立刻显示出来
const listeners = new Set();
let changeTimer;
const notifyChange = () => {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    for (const res of listeners) res.write(`event: change\ndata: {}\n\n`);
  }, 200);
};

const store = await createStore(path.join(root, 'data', 'db.json'), { onChange: notifyChange });
const agent = createAgent({ store, cwd: root });
const publisher = createPublisher({ store, root });
// 技能是本地数据：启动时装上新的出厂技能，没改过的跟着出厂说明更新
const skills = createSkills({ root });
const setupCheck = createSetupCheck({ hotUrl: HOT_URL });
{
  const r = skills.sync();
  if (r.installed.length) console.log(`已装上出厂技能：${r.installed.join('、')}`);
  if (r.updated.length) console.log(`技能已跟着出厂说明更新：${r.updated.join('、')}`);
}

// 让 Claude 能“看”一条视频：截帧拼成缩略图 + 语音转文字，结果存在 video.watch，生成发布信息时用
const watching = new Set();
async function startWatch(itemId) {
  if (watching.has(itemId)) return;
  watching.add(itemId);
  const it = store.get('items', itemId);
  await store.update('items', itemId, { video: { watch: { status: 'running', at: Date.now() } } });
  try {
    const r = await watchVideo({ root, mp4: it.video.mp4, dir: path.join(it.video.project || `videos/local-${itemId}`, 'watch') });
    await store.update('items', itemId, { video: { watch: { status: 'done', sheets: r.sheets, every: r.every, frames: r.frames, transcript: r.transcript, transcriptNote: r.transcriptNote, at: Date.now() } } });
  } catch (err) {
    await store.update('items', itemId, { video: { watch: { status: 'failed', message: String(err.message).split('\n')[0].slice(0, 200), at: Date.now() } } });
  } finally {
    watching.delete(itemId);
  }
}
if (store.isEmpty()) {
  for (const [id, acc] of Object.entries(SEED_ACCOUNTS)) await store.set('accounts', id, acc);
  console.log('首次启动：已写入默认的 4 个账号');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
const sendError = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

// 上传图片（修改意见里的截图）：原始字节，存到 data/uploads/，返回相对项目根目录的路径
const UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
async function saveUpload(req) {
  const ext = UPLOAD_TYPES[String(req.headers['content-type'] || '').split(';')[0].trim()];
  if (!ext) throw Object.assign(new Error('只支持 PNG、JPG、WebP 图片'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 10 * 1024 * 1024) throw Object.assign(new Error('图片太大，最大 10MB'), { status: 413 });
    chunks.push(c);
  }
  if (!size) throw Object.assign(new Error('没有收到图片'), { status: 400 });
  const { randomUUID } = await import('node:crypto');
  const rel = `data/uploads/${randomUUID().replace(/-/g, '')}.${ext}`;
  await fs.mkdir(path.join(root, 'data', 'uploads'), { recursive: true });
  await fs.writeFile(path.join(root, rel), Buffer.concat(chunks));
  return { path: rel, size };
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('请求体太大'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 格式不对'), { status: 400 });
  }
}

// 页面关闭或点「停止」时，取消正在进行的 Claude 调用
function abortOnClose(res) {
  const ctl = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ctl.abort();
  });
  return ctl.signal;
}

// 流式接口：SSE，事件 text / done / error
async function streamTask(res, run) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const signal = abortOnClose(res);
  try {
    const result = await run({ signal, onText: (delta) => send('text', { delta }) });
    send('done', result);
  } catch (err) {
    if (err.code !== 'cancelled') send('error', { code: err.code || 'unknown', message: err.message });
  }
  res.end();
}

async function handleApi(req, res, parts) {
  const method = req.method;

  if (parts[0] === 'state' && method === 'GET') return sendJson(res, 200, store.all());
  if (parts[0] === 'uploads' && parts.length === 1 && method === 'POST') return sendJson(res, 200, await saveUpload(req));

  // ---------- 发布 ----------
  if (parts[0] === 'publish') {
    const fail = (err) => {
      if (!err.status) throw err;
      return sendError(res, err.status, err.status === 409 ? 'busy' : 'bad_request', err.message);
    };
    const body = method === 'POST' ? await readBody(req) : {};
    const accountOk = (id) => ID_RE.test(id || '') && store.get('accounts', id);
    try {
      if (parts[1] === 'platforms' && method === 'GET') return sendJson(res, 200, publisher.platforms());
      if (parts[1] === 'accounts' && method === 'GET') return sendJson(res, 200, publisher.accounts());
      const plat = Object.hasOwn(publisher.browsers, parts[1]) ? publisher.browsers[parts[1]] : null;
      if (plat && method === 'POST' && ['login', 'login-done', 'check', 'unbind'].includes(parts[2])) {
        if (!accountOk(body.accountId)) return sendError(res, 400, 'bad_request', '找不到这个账号');
        if (parts[2] === 'login') return sendJson(res, 200, plat.startLogin(body.accountId));
        if (parts[2] === 'login-done') return sendJson(res, 200, { ok: await plat.finishLogin(body.accountId) });
        if (parts[2] === 'check') return sendJson(res, 200, await plat.check(body.accountId));
        plat.unbind(body.accountId);
        return sendJson(res, 200, { ok: true });
      }
      if (parts[1] === 'logins' && parts[2] && method === 'GET') {
        const st = publisher.loginStatus(parts[2]);
        return st ? sendJson(res, 200, st) : sendError(res, 404, 'not_found', '没有这次登录');
      }
      if (parts[1] === 'items' && ID_RE.test(parts[2] || '') && method === 'POST') {
        if (parts[3] === 'info') return sendJson(res, 200, await publisher.generateInfo(parts[2], { coverOnly: !!body.coverOnly, missingOnly: !!body.missingOnly, coverTime: body.coverTime != null && body.coverTime !== '' && Number.isFinite(Number(body.coverTime)) ? Number(body.coverTime) : undefined, coverPrompt: body.coverPrompt ? String(body.coverPrompt).slice(0, 2000) : undefined, mode: body.mode === 'frame' ? 'frame' : body.mode === 'ai' ? 'ai' : undefined }));
        if (parts[3] === 'go') return sendJson(res, 200, await publisher.publish(parts[2], body.platforms, body.manual));
        if (parts[3] === 'manual' && ['done', 'cancel'].includes(parts[5])) return sendJson(res, 200, await (parts[5] === 'done' ? publisher.manualDone : publisher.manualCancel)(parts[2], parts[4]));
        // 在 Finder 里显示这条内容的视频或封面（只认这条内容登记过的文件）
        if (parts[3] === 'reveal') {
          const it = store.get('items', parts[2]);
          if (!it) return sendError(res, 404, 'not_found', '找不到这条内容');
          const allowed = [it.video?.mp4, it.publish?.cover, it.publish?.coverWide, it.publish?.coverWide43].filter(Boolean).map((f) => path.resolve(root, f));
          const file = path.resolve(root, String(body.file || ''));
          if (!allowed.includes(file)) return sendError(res, 403, 'forbidden', '禁止访问');
          if (!existsSync(file)) return sendError(res, 404, 'not_found', '文件不在了，可能被移动或删除');
          if (process.platform !== 'darwin') return sendJson(res, 200, { path: file });
          execFile('open', ['-R', file]);
          return sendJson(res, 200, { ok: true, path: file });
        }
      }
      // 发布失败时的截图
      if (parts[1] === 'shots' && /^[0-9]+(-[a-z]+)+\.png$/.test(parts[2] || '') && method === 'GET') {
        const f = path.join(root, 'data', 'publish', 'screenshots', parts[2]);
        if (!existsSync(f)) return sendError(res, 404, 'not_found', '截图不存在');
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(await fs.readFile(f));
      }
    } catch (err) {
      return fail(err);
    }
    return sendError(res, 404, 'not_found', '没有这个发布接口');
  }
  if (parts[0] === 'voices' && parts.length === 1 && method === 'GET') {
    return sendJson(res, 200, JSON.parse(await fs.readFile(voicesFile(root), 'utf8')));
  }
  // 连接设置（图片生成的接口地址、key、模型，Claude 长期令牌）：只返回末 4 位
  // 环境检查：首次打开时提示还差什么（Claude Code 登录、ffmpeg、Chrome、HyperFrames 技能、热点服务）
  if (parts[0] === 'setup-check' && method === 'GET') return sendJson(res, 200, await setupCheck.check(new URL(req.url, 'http://localhost').searchParams.has('force')));
  // 技能：列表、查看、保存、恢复出厂、出厂更新的合并
  if (parts[0] === 'skills') {
    if (parts.length === 1 && method === 'GET') return sendJson(res, 200, skills.list());
    const name = parts[1];
    if (parts.length === 2 && method === 'GET') return sendJson(res, 200, skills.get(name));
    if (parts.length === 2 && method === 'PUT') return sendJson(res, 200, skills.save(name, (await readBody(req)).content));
    if (parts[2] === 'reset' && method === 'POST') return sendJson(res, 200, skills.reset(name));
    if (parts[2] === 'accept' && method === 'POST') return sendJson(res, 200, skills.acceptUpdate(name, (await readBody(req)).content));
    if (parts[2] === 'history' && /^\d+$/.test(parts[3] || '') && method === 'GET') return sendJson(res, 200, { content: skills.historyContent(name, parts[3]) });
    // 让 Claude 把新版出厂说明的改进合进你改过的版本：只返回合并结果，你看过再保存
    if (parts[2] === 'merge' && method === 'POST') {
      const { base, next, mine } = skills.mergeInputs(name);
      const prompt = `下面是一个 Claude Code 技能（SKILL.md）的三个版本。用户在旧的出厂版本上改过，现在出厂版本更新了。
请输出合并后的完整 SKILL.md：保留用户的所有改动和口味，同时把新出厂版本里的改进（新增的规则、步骤、修正）合进来；两边冲突时以用户的改动为准。只输出合并后的文件内容，不要任何解释。

===== 旧的出厂版本 =====
${base}
===== 新的出厂版本 =====
${next}
===== 用户现在的版本 =====
${mine}`;
      const { text } = await runClaude(prompt, { model: modelFor(store, 'series'), effort: effortFor(store, 'series') });
      return sendJson(res, 200, { content: String(text || '').replace(/^```(?:markdown|md)?\n|\n```\s*$/g, '').trim() + '\n' });
    }
  }
  if (parts[0] === 'config') {
    if (parts.length === 1 && method === 'GET') return sendJson(res, 200, publicConfig());
    if (parts[1] === 'image' && method === 'PUT') return sendJson(res, 200, setImage(await readBody(req)));
    if (parts[1] === 'image' && method === 'DELETE') return sendJson(res, 200, clearImage());
    if (parts[1] === 'claude' && method === 'PUT') return sendJson(res, 200, setClaudeToken((await readBody(req)).token));
    if (parts[1] === 'claude' && method === 'DELETE') return sendJson(res, 200, clearClaudeToken());
  }
  if (parts[0] === 'events' && method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return;
  }
  // 国内热榜聚合：转给 hot-service 的 /topics
  if (parts[0] === 'hot' && parts.length === 1 && method === 'GET') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const out = new URLSearchParams();
    for (const k of ['limit', 'sources']) if (q.get(k)) out.set(k, q.get(k));
    if (q.get('force') === '1') out.set('refresh', 'true');
    if (q.get('risky') === '1') out.set('risky', 'true');
    return proxyHot(req, res, '/topics?' + out);
  }
  // 其他热点数据接口原样转发：/api/hs/global、/api/hs/feed、/api/hs/channels
  if (parts[0] === 'hs' && ['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    const rest = parts.slice(1).join('/');
    if (!/^(health|sources|topics|global|feed|channels(\/[a-z0-9-]{1,30}\/(run|config))?)$/.test(rest)) {
      return sendError(res, 404, 'not_found', '没有这个热点数据接口');
    }
    return proxyHot(req, res, '/' + rest + new URL(req.url, 'http://localhost').search);
  }
  if (parts[0] === 'models' && parts.length === 1 && method === 'GET') return sendJson(res, 200, modelSettings(store));
  // 本机现成视频：弹 macOS 的选文件窗口拿到路径（不上传、不复制）
  if (parts[0] === 'pick-video' && method === 'POST') {
    if (process.platform !== 'darwin') return sendError(res, 400, 'bad_request', '只有 macOS 能弹选文件窗口，请直接粘贴视频的完整路径');
    const script = 'POSIX path of (choose file with prompt "选一条现成的视频" of type {"public.movie"})';
    return execFile('osascript', ['-e', script], { timeout: 10 * 60_000 }, (err, stdout) => {
      if (err) return sendJson(res, 200, { cancelled: true });
      sendJson(res, 200, { path: stdout.trim() });
    });
  }
  if (parts[0] === 'items' && ID_RE.test(parts[1] || '') && ['video-local', 'video-watch', 'video-file'].includes(parts[2])) {
    const it = store.get('items', parts[1]);
    if (!it) return sendError(res, 404, 'not_found', '找不到这条内容');
    // 用本机视频：记下原文件路径，进「待发布」，后台让 Claude 能“看”它
    if (parts[2] === 'video-local' && method === 'POST') {
      const body = await readBody(req);
      const file = String(body.path || '').trim().replace(/^file:\/\//, '').replace(/^~(?=\/)/, os.homedir());
      if (!path.isAbsolute(file)) return sendError(res, 400, 'bad_request', '要视频文件的完整路径，比如 /Users/你/Movies/xxx.mp4');
      if (!['.mp4', '.mov', '.m4v', '.webm'].includes(path.extname(file).toLowerCase())) return sendError(res, 400, 'bad_request', '只支持 mp4、mov、m4v、webm');
      if (!existsSync(file)) return sendError(res, 400, 'bad_request', '找不到这个文件');
      let info;
      try {
        info = await probe(file);
      } catch {
        return sendError(res, 400, 'bad_request', '读不出这个视频，确认文件没有损坏');
      }
      const prev = it.video && it.video.mp4 !== file ? [{ mp4: it.video.mp4, durationS: it.video.durationS, notes: it.video.notes, at: it.video.at, version: it.video.version || 1, source: it.video.source }, ...(it.video.history || [])].slice(0, 10) : it.video?.history || [];
      const video = {
        history: prev,
        version: it.video && it.video.mp4 !== file ? (it.video.version || 1) + 1 : it.video?.version || 1,
        mp4: file, project: `videos/local-${parts[1]}`, source: 'local', durationS: info.durationS, width: info.width, height: info.height,
        guide: String(body.guide || '').slice(0, 2000), notes: '', contactSheet: null, at: Date.now(), watch: { status: 'running', at: Date.now() },
      };
      await store.set('items', parts[1], { ...store.get('items', parts[1]), video, stage: ['idea', 'script', 'production'].includes(it.stage || 'idea') ? 'scheduled' : it.stage, updatedAt: Date.now() });
      startWatch(parts[1]);
      return sendJson(res, 200, { ok: true, durationS: info.durationS });
    }
    if (parts[2] === 'video-watch' && method === 'POST') {
      if (!it.video?.mp4) return sendError(res, 400, 'bad_request', '这条还没有视频');
      if (it.video.watch?.status === 'running') return sendError(res, 409, 'busy', '正在看，稍等');
      startWatch(parts[1]);
      return sendJson(res, 200, { ok: true });
    }
    // 播放本机视频：只给这条内容登记过的文件（当前版本和历史版本），不能读任意路径
    if (parts[2] === 'video-file' && method === 'GET') {
      const want = new URL(req.url, 'http://localhost').searchParams.get('path') || it.video?.mp4 || '';
      const allowed = [it.video?.mp4, ...(it.video?.history || []).map((h) => h.mp4)].filter((f) => f && path.isAbsolute(f));
      if (!allowed.includes(want)) return sendError(res, 403, 'forbidden', '禁止访问');
      return serveFile(req, res, want);
    }
  }
  // 调研素材：截网页（和页面里的视频）存到内容卡片上；删掉不要的
  if (parts[0] === 'items' && ID_RE.test(parts[1] || '') && parts[2] === 'assets') {
    const it = store.get('items', parts[1]);
    if (!it) return sendError(res, 404, 'not_found', '找不到这条内容');
    if (parts.length === 3 && method === 'POST') {
      const body = await readBody(req);
      try {
        const r = await captureSource({ root, itemId: parts[1], url: String(body.url || ''), fullPage: body.fullPage !== false, videos: !!body.videos });
        const at = Date.now();
        const added = r.files.map((f, i) => ({ id: `${at.toString(36)}${i}`, kind: f.kind, file: f.file, part: f.part, url: r.url, title: r.title, note: String(body.note || '').slice(0, 300), at }));
        const cur = store.get('items', parts[1]).assets || [];
        await store.update('items', parts[1], { assets: [...cur, ...added].slice(-80), updatedAt: Date.now() });
        return sendJson(res, 200, { title: r.title, files: added.map((a) => ({ id: a.id, kind: a.kind, file: a.file, part: a.part })), skippedVideos: r.skippedVideos });
      } catch (err) {
        return sendError(res, err.status || 502, 'capture_failed', `截图失败：${String(err.message).split('\n')[0].slice(0, 200)}`);
      }
    }
    if (parts.length === 4 && method === 'DELETE') {
      const cur = it.assets || [];
      const a = cur.find((x) => x.id === parts[3]);
      if (!a) return sendError(res, 404, 'not_found', '素材不存在');
      const file = path.resolve(root, a.file);
      if (file.startsWith(path.join(VIDEOS, '_assets') + path.sep)) await fs.rm(file, { force: true });
      await store.update('items', parts[1], { assets: cur.filter((x) => x.id !== parts[3]), updatedAt: Date.now() });
      return sendJson(res, 200, { ok: true });
    }
  }
  if (parts[0] === 'radar' && parts[1] === 'picks' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await appendPicks(store, body.picks, { by: body.by || 'claude', runId: agent.running() }));
  }
  // 后台调起 Claude Code 跑技能：/api/agent/run 开始，/api/agent/runs/<id>/stop 停止；进度写在 agentRuns 里
  if (parts[0] === 'agent' && method === 'POST') {
    if (parts[1] === 'run' && parts.length === 2) {
      const { task, ...args } = await readBody(req);
      try {
        return sendJson(res, 200, await agent.start(task, args));
      } catch (err) {
        if (!err.status) throw err;
        return sendError(res, err.status, err.status === 409 ? 'busy' : 'bad_request', err.message);
      }
    }
    if (parts[1] === 'runs' && ID_RE.test(parts[2] || '') && parts[3] === 'say') {
      const { text } = await readBody(req);
      try {
        return sendJson(res, 200, { ok: agent.say(parts[2], text) });
      } catch (err) {
        if (!err.status) throw err;
        return sendError(res, err.status, err.status === 409 ? 'busy' : 'bad_request', err.message);
      }
    }
    if (parts[1] === 'runs' && ID_RE.test(parts[2] || '') && parts[3] === 'resume') {
      try {
        return sendJson(res, 200, await agent.resume(parts[2]));
      } catch (err) {
        if (!err.status) throw err;
        return sendError(res, err.status, err.status === 409 ? 'busy' : 'bad_request', err.message);
      }
    }
    if (parts[1] === 'runs' && ID_RE.test(parts[2] || '') && parts[3] === 'stop') {
      return agent.stop(parts[2]) ? sendJson(res, 200, { ok: true }) : sendError(res, 404, 'not_found', '这个任务没有在运行');
    }
  }
  if (parts[0] === 'radar' && parts[1] === 'ideas' && method === 'POST') {
    const body = await readBody(req);
    return sendJson(res, 200, await appendIdeas(store, body.ideas, { by: body.by || 'claude' }));
  }
  if (parts[0] === 'health' && method === 'GET') {
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === 'ai' && method === 'POST') {
    const body = await readBody(req);
    const task = parts[1];
    if (task === 'ideas') {
      const signal = abortOnClose(res);
      return sendJson(res, 200, await generateIdeas(store, body, { signal }));
    }
    if (task === 'check') {
      const signal = abortOnClose(res);
      return sendJson(res, 200, await precheck(store, body, { signal }));
    }
    if (task === 'script') return streamTask(res, (o) => writeScript(store, body, o));
    if (task === 'analysis') return streamTask(res, (o) => analyze(store, o));
    return sendError(res, 404, 'not_found', '没有这个 AI 接口');
  }

  // 数据接口：/api/<collection>/<id>
  const [col, id] = parts;
  if (!COLLECTIONS.includes(col) || !ID_RE.test(id || '') || parts.length !== 2) {
    return sendError(res, 404, 'not_found', '没有这个接口');
  }
  if (method === 'GET') {
    const doc = store.get(col, id);
    return doc ? sendJson(res, 200, doc) : sendError(res, 404, 'not_found', '不存在');
  }
  if (method === 'PUT') {
    const body = await readBody(req);
    return sendJson(res, 200, await store.set(col, id, body));
  }
  if (method === 'PATCH') {
    const body = await readBody(req);
    const doc = await store.update(col, id, body);
    return doc ? sendJson(res, 200, doc) : sendError(res, 404, 'not_found', '不存在');
  }
  if (method === 'DELETE') {
    await store.del(col, id);
    return sendJson(res, 200, { ok: true });
  }
  return sendError(res, 405, 'method_not_allowed', '不支持这个操作');
}

async function proxyHot(req, res, pathAndQuery) {
  const body = ['POST', 'PUT'].includes(req.method) ? JSON.stringify(await readBody(req)) : undefined;
  let r;
  try {
    // 立即抓取可能比较慢
    r = await fetch(HOT_URL + pathAndQuery, {
      method: req.method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body,
      signal: AbortSignal.timeout(req.method === 'POST' ? 15 * 60e3 : 3 * 60e3),
    });
  } catch {
    return sendError(res, 503, 'hot_service_down', '热点数据服务还没响应：刚启动的话等几秒会自动连上；一直这样的话，在项目目录运行 npm run setup，再重新 npm start');
  }
  res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(await r.text());
}

// 生成的视频和缩略图：/media/videos/<项目>/renders/video.mp4。支持 Range，页面里的播放器才能拖进度条
const VIDEOS = path.join(root, 'videos');
const MEDIA_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
async function serveMedia(req, res, rel) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(VIDEOS + path.sep)) return sendError(res, 403, 'forbidden', '禁止访问');
  return serveFile(req, res, file);
}
// 按文件流式返回，支持拖动进度条（Range）。调用方负责确认这个文件允许访问
async function serveFile(req, res, file) {
  const type = MEDIA_TYPES[path.extname(file).toLowerCase()];
  if (!type) return sendError(res, 403, 'forbidden', '禁止访问');
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return sendError(res, 404, 'not_found', '文件不存在');
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const { createReadStream } = await import('node:fs');
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, stat.size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return sendError(res, 403, 'forbidden', '禁止访问');
  try {
    const buf = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  } catch {
    sendError(res, 404, 'not_found', '文件不存在');
  }
}

// 只接受本机页面和本机程序的请求。工作台能让 Claude 干活、改技能、发到你的账号，
// 不能让别的网站借你的浏览器来调：
// - Host 不是本机地址的拒绝：挡住 DNS 重绑定（恶意域名解析到 127.0.0.1 后来读写接口）
// - 带 Origin 的必须和工作台同源：挡住别的网页在后台偷偷发请求（CSRF）
// 用 HOST=0.0.0.0 等开放给局域网时，访问地址由你自己决定，只校验同源。
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOCAL_ONLY = LOOPBACK.has(HOST) || HOST === '::1';
function fromSelf(req) {
  const host = req.headers.host || '';
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (LOCAL_ONLY && !LOOPBACK.has(hostname)) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // Origin: null（沙盒 iframe、本地文件打开的网页）
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!fromSelf(req)) return sendError(res, 403, 'forbidden', '只接受从本机打开的工作台发来的请求');
  try {
    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname.slice(5).split('/').filter(Boolean));
    }
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', '不支持这个操作');
    if (pathname.startsWith('/media/')) return await serveMedia(req, res, decodeURIComponent(pathname.slice('/media/'.length)));
    return await serveStatic(req, res, pathname);
  } catch (err) {
    if (res.headersSent) return res.end();
    if (err.status) return sendError(res, err.status, 'bad_request', err.message);
    if (err.code === 'cancelled') return res.end();
    if (err.code && err.message) return sendError(res, err.code === 'not_found' ? 404 : err.code === 'bad_input' ? 400 : 502, err.code, err.message);
    console.error(err);
    return sendError(res, 500, 'internal', '服务出错了，看一下终端日志。');
  }
});

// npm start 时顺带启动 hot-service（已在运行或没安装就跳过）
let hotProc = null;
const hotPython = path.join(root, 'hot-service', '.venv', 'bin', 'python');
if (!process.env.HOT_SERVICE_URL && existsSync(hotPython)) {
  const running = await fetch(HOT_URL + '/health', { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
  if (!running) {
    hotProc = spawn(hotPython, ['app.py'], { cwd: path.join(root, 'hot-service'), env: { ...process.env, HOT_PORT: String(HOT_PORT) }, stdio: ['ignore', 'inherit', 'inherit'] });
    hotProc.on('exit', (code) => code && console.log(`热点数据服务退出（${code}）`));
    console.log(`已启动热点数据服务：${HOT_URL}`);
  }
}
// 工作台退出时把它启动的热点服务一起停掉：Ctrl+C、solomcn stop（SIGTERM）、直接关掉终端窗口（SIGHUP）都算
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    hotProc?.kill();
    process.exit(0);
  });
}
process.on('exit', () => hotProc?.kill());

server.listen(PORT, HOST, () => {
  console.log(`SoloMCN 工作台已启动：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
