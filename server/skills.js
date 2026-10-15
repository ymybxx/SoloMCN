// 技能是用户自己的数据：仓库只带出厂版本（defaults/skills），在用的技能在 .claude/skills（不进 git），
// Claude Code 原生就读这个目录（简介常驻，正文用到才读，附录再往下按需读），所以在工作台、终端、桌面端跑的都是同一份。
// 记录每个技能是基于哪一版出厂版本装的（data/skills/base/<名字>/），用来判断「改过没有」和做三方合并。
//
// 技能的每一次变化都是一条「技能改动」（store 的 skillChanges），不管从哪来：
//   idea 用户在总控台、技能页提的想法 / tidy 用户要求的整理 / update 出厂更新 / manual 用户在技能页自己改的
//   （以前的 run、suggest 是运行自己改的、提的，已经去掉：运行不改技能，旧记录照常显示）
// 改动前后的文件存在 data/skills/changes/<id>/before、after（只存变了的文件），能看逐行对比、能撤回。
// 要 Claude 动手的改动（想法、整理、有冲突的出厂更新）先在草稿里改（changes/<id>/draft，是全部技能的副本，
// start 是开工时的样子），改完等用户确认；通过时按三方合并写回，期间技能被别处改过也不会丢。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const SKIP = new Set(['node_modules', '.git', '.DS_Store']);
// 技能只在用户提要求时改（总控台、技能页的想法，整理，再改改）：Claude 在草稿里改好，用户确认后才生效。
// 运行（调研、写脚本、出片……）不改技能。出厂更新可以选直接换上，有冲突的总是先给用户看
export const DEFAULT_POLICY = { update: 'auto' };
const OPEN = ['queued', 'working', 'pending', 'failed'];

export function createSkills({ root, store }) {
  const DEFAULTS = path.join(root, 'defaults', 'skills');
  const LIVE = path.join(root, '.claude', 'skills');
  const BASE = path.join(root, 'data', 'skills', 'base'); // 装的时候那一版出厂版本的副本
  const HISTORY = path.join(root, 'data', 'skills', 'history'); // 老版本的 SKILL.md 历史，只读
  const CHANGES = path.join(root, 'data', 'skills', 'changes');
  const DISABLED = path.join(root, 'data', 'skills', 'disabled'); // 关掉的技能挪到这里，不占 Claude 的上下文
  fs.mkdirSync(CHANGES, { recursive: true });
  // 以前运行开跑前存的技能快照（运行不再改技能），清掉
  for (const d of fs.readdirSync(CHANGES)) if (d.startsWith('run-')) fs.rmSync(path.join(CHANGES, d), { recursive: true, force: true });

  const bad = (m, status = 400) => Object.assign(new Error(m), { status });
  const check = (name) => {
    if (!NAME_RE.test(name || '')) throw bad('技能名只能用小写字母、数字和连字符');
    return name;
  };
  const checkRel = (rel) => {
    const r = path.normalize(String(rel || '')).replace(/^\/+/, '');
    if (!r || r.startsWith('..') || r.split(path.sep).some((p) => p.startsWith('.') || SKIP.has(p))) throw bad('文件路径不对');
    return r;
  };

  // ---------- 设置 ----------
  function settings() {
    const s = store.get('settings', 'skills') || {};
    return { policy: { update: s.policy?.update === 'confirm' ? 'confirm' : 'auto' }, disabled: s.disabled || [] };
  }
  async function setSettings(body = {}) {
    const cur = settings();
    const policy = { ...cur.policy };
    for (const k of Object.keys(DEFAULT_POLICY)) if (['auto', 'confirm'].includes(body.policy?.[k])) policy[k] = body.policy[k];
    const next = { ...(store.get('settings', 'skills') || {}), policy };
    await store.set('settings', 'skills', next);
    return settings();
  }
  const patchSettings = (p) => store.set('settings', 'skills', { ...(store.get('settings', 'skills') || {}), ...p });

  // ---------- 文件 ----------
  const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name) : []);
  // 一个目录下的所有文件（相对路径），跳过隐藏文件和依赖
  function files(dir, rel = '') {
    if (!fs.existsSync(path.join(dir, rel))) return [];
    return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      if (e.name.startsWith('.') || SKIP.has(e.name)) return [];
      const r = path.join(rel, e.name);
      return e.isDirectory() ? files(dir, r) : e.isFile() ? [r] : [];
    }).sort();
  }
  function hash(dir) {
    const fl = files(dir);
    if (!fl.length) return null;
    const h = crypto.createHash('sha256');
    for (const f of fl) h.update(f + '\0').update(fs.readFileSync(path.join(dir, f))).update('\0');
    return h.digest('hex');
  }
  const copyFilter = (src) => !path.basename(src).startsWith('.') && !SKIP.has(path.basename(src));
  const copyDir = (from, to) => {
    fs.rmSync(to, { recursive: true, force: true });
    if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true, filter: (s) => s === from || copyFilter(s) });
  };
  const buf = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
  const same = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));
  const isText = (b) => b === null || !b.subarray(0, 8000).includes(0);
  const read = (dir) => buf(path.join(dir, 'SKILL.md'))?.toString('utf8') || '';
  const front = (text) => (text.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
  const describe = (text) => (front(text).match(/^description:\s*(.+)$/m) || [])[1]?.trim() || '';
  // 流程技能不标；做法标 kind: craft，工具标 kind: tool（写在 metadata 下面）
  const kindOf = (text) => (front(text).match(/^\s+kind:\s*(craft|tool)\s*$/m) || [])[1] || 'flow';
  function writeFile(p, b) {
    if (b === null) {
      fs.rmSync(p, { force: true });
      // 删空了的目录一路往上清掉（不出技能根目录）
      for (let d = path.dirname(p); d.startsWith(LIVE + path.sep) && fs.existsSync(d) && !fs.readdirSync(d).length; d = path.dirname(d)) fs.rmdirSync(d);
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, b);
    }
  }
  // 两份技能目录（都是「技能名/文件」的结构）里内容不同的文件
  function changed(a, b) {
    const all = [...new Set([...files(a), ...files(b)])].sort();
    return all.filter((r) => !same(buf(path.join(a, r)), buf(path.join(b, r))));
  }
  // git 自带的三方合并：mine 是现在的，base 是共同的起点，theirs 是要合进来的。返回合并结果，有冲突返回 null
  function merge3(mine, base, theirs) {
    const tmp = fs.mkdtempSync(path.join(CHANGES, '.m-'));
    try {
      const [m, b, t] = ['mine', 'base', 'theirs'].map((n, i) => { const p = path.join(tmp, n); fs.writeFileSync(p, [mine, base, theirs][i]); return p; });
      try {
        return execFileSync('git', ['merge-file', '-p', m, b, t], { maxBuffer: 1 << 26 });
      } catch (e) {
        return null; // 退出码 > 0 是冲突的个数
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const lineCount = (b) => (b === null ? 0 : b.toString('utf8').split('\n').length - (b.toString('utf8').endsWith('\n') ? 1 : 0));
  // 加了几行、删了几行（git diff --numstat）
  function numstat(a, b) {
    if (!isText(buf(a)) || !isText(buf(b))) return { binary: true };
    try {
      execFileSync('git', ['diff', '--no-index', '--numstat', fs.existsSync(a) ? a : '/dev/null', fs.existsSync(b) ? b : '/dev/null'], { maxBuffer: 1 << 26 });
      return { plus: 0, minus: 0 };
    } catch (e) {
      const [plus, minus] = String(e.stdout || '').split('\t');
      return { plus: Number(plus) || 0, minus: Number(minus) || 0 };
    }
  }
  function unified(a, b, label) {
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '-U3', fs.existsSync(a) ? a : '/dev/null', fs.existsSync(b) ? b : '/dev/null'], { maxBuffer: 1 << 26 });
      return '';
    } catch (e) {
      const out = String(e.stdout || '');
      // 去掉 git 自己的文件头，换成技能里的路径
      return `=== ${label}\n` + out.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l)).join('\n');
    }
  }

  // ---------- 技能列表 ----------
  function status(name) {
    const def = path.join(DEFAULTS, name), base = path.join(BASE, name);
    const disabled = settings().disabled.includes(name) && fs.existsSync(path.join(DISABLED, name));
    const live = disabled ? path.join(DISABLED, name) : path.join(LIVE, name);
    const hasDefault = fs.existsSync(def);
    const hLive = hash(live), hBase = fs.existsSync(base) ? hash(base) : null, hDef = hasDefault ? hash(def) : null;
    const text = read(live) || read(def);
    return {
      name,
      description: describe(text),
      kind: kindOf(text),
      origin: hasDefault ? 'default' : 'custom', // 出厂的 / 你自己加的
      enabled: !disabled,
      // 和现在的出厂版本一模一样的，就算出厂、没有要合并的（比如你的改动已经被收进了出厂版本，还没等到下次启动对账）
      modified: hasDefault ? hLive !== hBase && hLive !== hDef : true,
      update: hasDefault && hBase !== null && hDef !== hBase && hLive !== hDef, // 出厂版本有更新还没合进来（一般是有冲突、等你确认）
      files: files(live),
    };
  }
  const list = () => [...new Set([...dirs(LIVE), ...dirs(DEFAULTS), ...dirs(DISABLED)])].sort().map(status);
  const liveDir = (name) => (settings().disabled.includes(name) && fs.existsSync(path.join(DISABLED, name)) ? path.join(DISABLED, name) : path.join(LIVE, name));

  function get(name) {
    check(name);
    if (!fs.existsSync(liveDir(name))) throw bad('没有这个技能', 404);
    return { ...status(name), content: read(liveDir(name)), changes: listChanges({ skill: name, limit: 30 }) };
  }
  function readSkillFile(name, rel) {
    check(name);
    const p = path.join(liveDir(name), checkRel(rel));
    const b = buf(p);
    if (b === null) throw bad('没有这个文件', 404);
    if (!isText(b)) return { binary: true, size: b.length };
    return { content: b.toString('utf8') };
  }

  // ---------- 技能改动 ----------
  const cdir = (id) => path.join(CHANGES, id);
  const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const rec = (id) => { const r = store.get('skillChanges', id); return r ? { ...r, id } : null; };
  const save = (id, patch) => (rec(id) ? store.update('skillChanges', id, patch) : store.set('skillChanges', id, patch));
  const skillsOf = (rels) => [...new Set(rels.map((r) => r.split(path.sep)[0]))];

  // 把这次变了的文件存进 before / after，算出每个文件加减了几行
  function materialize(id, fromRoot, toRoot, rels) {
    for (const side of ['before', 'after']) fs.rmSync(path.join(cdir(id), side), { recursive: true, force: true });
    return rels.map((r) => {
      for (const [side, src] of [['before', fromRoot], ['after', toRoot]]) {
        const b = buf(path.join(src, r));
        if (b !== null) { fs.mkdirSync(path.dirname(path.join(cdir(id), side, r)), { recursive: true }); fs.writeFileSync(path.join(cdir(id), side, r), b); }
      }
      const a = path.join(cdir(id), 'before', r), b = path.join(cdir(id), 'after', r);
      return { path: r, op: !fs.existsSync(a) ? 'add' : !fs.existsSync(b) ? 'del' : 'mod', ...numstat(a, b) };
    });
  }

  // 把一组改动写回在用的技能：现在的文件还是改动前的样子就直接写；被别处改过就三方合并；合不了就整组不写，报冲突
  function applyPairs(id, reverse) {
    const r = rec(id);
    const plan = [];
    const conflicts = [];
    for (const f of r.files || []) {
      const before = buf(path.join(cdir(id), 'before', f.path)), after = buf(path.join(cdir(id), 'after', f.path));
      const [from, to] = reverse ? [after, before] : [before, after];
      const target = path.join(LIVE, f.path);
      const cur = buf(target);
      if (same(cur, to)) continue;
      if (same(cur, from)) { plan.push([target, to]); continue; }
      if (cur !== null && from !== null && to !== null && isText(cur) && isText(from) && isText(to)) {
        const m = merge3(cur, from, to);
        if (m) { plan.push([target, m]); continue; }
      }
      conflicts.push(f.path);
    }
    if (conflicts.length) throw bad(`这几个文件在这之后又被改过，合不上：${conflicts.join('、')}。先看看现在的版本再决定`, 409);
    for (const [p, b] of plan) writeFile(p, b);
  }
  const dropWork = (id) => { for (const d of ['start', 'draft', 'old', 'new']) fs.rmSync(path.join(cdir(id), d), { recursive: true, force: true }); };
  // 有冲突、由 Claude 合的出厂更新总是先给用户看
  const policyOf = (source, r) => (source === 'manual' ? 'auto' : source === 'update' && !r?.conflicts?.length ? settings().policy.update : 'confirm');

  async function apply(id) {
    const r = rec(id);
    if (!r) throw bad('没有这条改动', 404);
    if (r.status !== 'pending') throw bad('这条改动现在不能通过');
    applyPairs(id, false);
    // 出厂更新合进来了：以新的出厂版本为基准
    if (r.source === 'update') for (const n of r.skills || []) copyDir(path.join(DEFAULTS, n), path.join(BASE, n));
    dropWork(id);
    await save(id, { status: 'applied', decidedAt: Date.now() });
    return rec(id);
  }
  async function reject(id) {
    const r = rec(id);
    if (!r) throw bad('没有这条改动', 404);
    if (!OPEN.includes(r.status)) throw bad('这条改动已经处理过了');
    if (r.status === 'working') throw bad('Claude 还在改，先在运行记录里停掉它');
    // 有冲突的出厂更新不要了：以新出厂版本为基准，保留你的版本，以后不再提示这一版
    if (r.source === 'update') for (const n of r.skills || []) copyDir(path.join(DEFAULTS, n), path.join(BASE, n));
    dropWork(id);
    await save(id, { status: 'rejected', decidedAt: Date.now() });
    return rec(id);
  }
  async function revert(id) {
    const r = rec(id);
    if (!r) throw bad('没有这条改动', 404);
    if (r.status !== 'applied') throw bad('只有已生效的改动能撤回');
    applyPairs(id, true);
    await save(id, { status: 'reverted', decidedAt: Date.now() });
    return rec(id);
  }
  function diff(id) {
    const r = rec(id);
    if (!r) throw bad('没有这条改动', 404);
    return (r.files || []).map((f) => (f.binary ? `=== ${f.path}\n（不是文本文件，${f.op === 'add' ? '新加' : f.op === 'del' ? '删除' : '有改动'}）\n` : unified(path.join(cdir(id), 'before', f.path), path.join(cdir(id), 'after', f.path), f.path))).join('\n');
  }

  // 改完了（不管是用户在页面上改的、Claude 在草稿里改的）：记一条改动，按设置直接生效或等确认
  async function settle(id, fromRoot, toRoot, { live = false } = {}) {
    const rels = changed(fromRoot, toRoot);
    if (!rels.length) {
      fs.rmSync(cdir(id), { recursive: true, force: true });
      await save(id, { status: 'empty', files: [], decidedAt: Date.now() });
      return rec(id);
    }
    const filesInfo = materialize(id, fromRoot, toRoot, rels);
    await save(id, { files: filesInfo, skills: [...new Set([...(rec(id)?.skills || []), ...skillsOf(rels)])] });
    const r = rec(id);
    if (live) {
      // 已经写在在用的技能里了（用户自己改的、视频运行里 Claude 直接改的）
      if (policyOf(r.source, r) === 'auto') { await save(id, { status: 'applied', decidedAt: Date.now() }); return rec(id); }
      // 要先确认的：撤回在用的，留在草稿里等确认
      applyPairs(id, true);
      await save(id, { status: 'pending' });
      return rec(id);
    }
    await save(id, { status: 'pending' });
    if (policyOf(r.source, r) === 'auto') {
      try { return await apply(id); } catch (e) { await save(id, { note: e.message }); }
    }
    return rec(id);
  }

  // 新开一条要 Claude 动手的改动：草稿是全部在用技能的副本，排队等 Claude
  async function begin(source, meta = {}) {
    const id = newId();
    fs.mkdirSync(cdir(id), { recursive: true });
    copyDir(LIVE, path.join(cdir(id), 'start'));
    copyDir(LIVE, path.join(cdir(id), 'draft'));
    await save(id, { source, status: 'queued', createdAt: Date.now(), files: [], ...meta });
    return rec(id);
  }
  const draftDir = (id) => path.join(cdir(id), 'draft');

  // Claude 做完了：对比开工时和草稿，记成改动
  async function finishDraft(id, { summary = '', ok = true, error = '' } = {}) {
    const r = rec(id);
    if (!r) return null;
    if (!ok) { await save(id, { status: 'failed', error: String(error || '').slice(0, 500), summary: String(summary || '').slice(0, 3000) }); return rec(id); }
    await save(id, { summary: String(summary || '').slice(0, 3000) });
    return settle(id, path.join(cdir(id), 'start'), draftDir(id));
  }
  // 再改改：接着同一个草稿和对话改
  async function refine(id, text) {
    const r = rec(id);
    if (!r) throw bad('没有这条改动', 404);
    if (r.status !== 'pending' || !fs.existsSync(draftDir(id))) throw bad('这条改动现在不能再改');
    text = String(text || '').trim().slice(0, 2000);
    if (!text) throw bad('写一下还要怎么改');
    await save(id, { status: 'queued', refines: [...(r.refines || []), { at: Date.now(), text }] });
    return rec(id);
  }
  const nextQueued = () => Object.entries(store.all().skillChanges || {}).map(([id, r]) => ({ id, ...r })).filter((r) => r.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  const markWorking = (id, runId) => save(id, { status: 'working', runId: runId || rec(id)?.runId || null });

  // 总控台的想法
  async function idea(text) {
    text = String(text || '').trim().slice(0, 2000);
    if (text.length < 2) throw bad('先写一句想改什么');
    return begin('idea', { idea: text, title: text.slice(0, 60) });
  }
  async function tidy() {
    if (Object.values(store.all().skillChanges || {}).some((r) => r.source === 'tidy' && OPEN.includes(r.status))) throw bad('已经有一次整理在排队或等确认');
    return begin('tidy', { title: '整理技能' });
  }
  // 用户在技能页改一个文件：直接生效，记一条改动
  async function writeSkillFile(name, rel, content, { reason = '' } = {}) {
    check(name);
    rel = checkRel(rel);
    if (typeof content !== 'string') throw bad('内容不对');
    if (rel === 'SKILL.md' && !content.trim()) throw bad('SKILL.md 不能是空的');
    if (settings().disabled.includes(name)) throw bad('这个技能关着，先打开再改');
    const id = newId();
    fs.mkdirSync(cdir(id), { recursive: true });
    const before = path.join(cdir(id), 'start');
    copyDir(path.join(LIVE, name), path.join(before, name));
    const b = Buffer.from(content.endsWith('\n') ? content : content + '\n');
    writeFile(path.join(LIVE, name, rel), b);
    await save(id, { source: 'manual', status: 'working', createdAt: Date.now(), files: [], title: reason ? String(reason).slice(0, 80) : `改了 ${name}/${rel}`, reason: String(reason || '').slice(0, 300) });
    const after = path.join(cdir(id), 'draft');
    copyDir(path.join(LIVE, name), path.join(after, name));
    const r = await settle(id, before, after);
    // settle 对 manual 走的是「通过」那条路，但文件已经写好了：applyPairs 发现内容一致会跳过
    dropWork(id);
    return { change: r, skill: status(name) };
  }
  // 新建一个自己的技能
  async function create(name, content) {
    check(name);
    if (fs.existsSync(path.join(LIVE, name)) || fs.existsSync(path.join(DEFAULTS, name))) throw bad('已经有这个名字的技能');
    return writeSkillFile(name, 'SKILL.md', content, { reason: `新建技能 ${name}` });
  }
  // 删掉自己加的技能（出厂的只能关掉），记成一条改动，能撤回
  async function remove(name) {
    check(name);
    if (fs.existsSync(path.join(DEFAULTS, name))) throw bad('出厂技能不能删，可以关掉');
    if (!fs.existsSync(path.join(LIVE, name))) throw bad('没有这个技能', 404);
    const id = newId();
    fs.mkdirSync(cdir(id), { recursive: true });
    const before = path.join(cdir(id), 'start'), after = path.join(cdir(id), 'draft');
    copyDir(path.join(LIVE, name), path.join(before, name));
    fs.mkdirSync(after, { recursive: true });
    await save(id, { source: 'manual', status: 'working', createdAt: Date.now(), files: [], title: `删除技能 ${name}` });
    fs.rmSync(path.join(LIVE, name), { recursive: true, force: true });
    const r = await settle(id, before, after);
    dropWork(id);
    return r;
  }
  // 恢复出厂：记一条改动，能撤回
  async function reset(name) {
    check(name);
    const def = path.join(DEFAULTS, name);
    if (!fs.existsSync(def)) throw bad('这是你自己加的技能，没有出厂版本');
    const id = newId();
    fs.mkdirSync(cdir(id), { recursive: true });
    const before = path.join(cdir(id), 'start'), after = path.join(cdir(id), 'draft');
    copyDir(path.join(LIVE, name), path.join(before, name));
    copyDir(def, path.join(after, name));
    await save(id, { source: 'manual', status: 'working', createdAt: Date.now(), files: [], title: `${name} 恢复出厂` });
    copyDir(def, path.join(LIVE, name));
    copyDir(def, path.join(BASE, name));
    const r = await settle(id, before, after);
    dropWork(id);
    return { change: r, skill: status(name) };
  }

  // 开关：只有做法和工具能关（流程技能是工作台每个环节的入口，关了就跑不起来）
  async function setEnabled(name, on) {
    check(name);
    const s = settings();
    const st = status(name);
    if (st.kind === 'flow') throw bad('流程技能是各环节的入口，不能关');
    if (on && s.disabled.includes(name)) {
      if (fs.existsSync(path.join(DISABLED, name))) { fs.rmSync(path.join(LIVE, name), { recursive: true, force: true }); fs.renameSync(path.join(DISABLED, name), path.join(LIVE, name)); }
      await patchSettings({ disabled: s.disabled.filter((x) => x !== name) });
      await sync();
    } else if (!on && !s.disabled.includes(name)) {
      fs.mkdirSync(DISABLED, { recursive: true });
      fs.rmSync(path.join(DISABLED, name), { recursive: true, force: true });
      if (fs.existsSync(path.join(LIVE, name))) fs.renameSync(path.join(LIVE, name), path.join(DISABLED, name));
      await patchSettings({ disabled: [...s.disabled, name] });
    }
    return status(name);
  }

  // ---------- 出厂更新 ----------
  // 启动时：装上新的出厂技能；出厂版本更新了的，没改过的直接换上，改过的逐个文件三方合并，
  // 合得上就直接合（记一条改动，能撤回），合不上的交给 Claude 合并（排队）
  async function sync() {
    fs.mkdirSync(LIVE, { recursive: true });
    fs.mkdirSync(CHANGES, { recursive: true });
    const out = { installed: [], updated: [], merged: [], conflicted: [] };
    const s = settings();
    for (const name of dirs(DEFAULTS)) {
      if (s.disabled.includes(name)) continue;
      const def = path.join(DEFAULTS, name), live = path.join(LIVE, name), base = path.join(BASE, name);
      if (!fs.existsSync(live)) { copyDir(def, live); copyDir(def, base); out.installed.push(name); continue; }
      if (!fs.existsSync(base)) { copyDir(def, base); continue; } // 老用户第一次用这个功能：以当前出厂版本为基准
      const hDef = hash(def);
      if (hDef === hash(base)) continue;
      // 这一版出厂更新已经在排队或等确认了，不重复开
      if (Object.values(store.all().skillChanges || {}).some((r) => r.source === 'update' && OPEN.includes(r.status) && r.skills?.includes(name) && r.defHash === hDef)) continue;
      const modified = hash(live) !== hash(base);
      // 逐个文件合：出厂没动的留你的，你没动的换出厂的，都动了的三方合并
      const result = new Map();
      const conflicts = [];
      for (const r of [...new Set([...files(base), ...files(live), ...files(def)])]) {
        const b = buf(path.join(base, r)), c = buf(path.join(live, r)), n = buf(path.join(def, r));
        if (same(n, b) || same(c, n)) result.set(r, c);
        else if (same(c, b)) result.set(r, n);
        else if (b !== null && c !== null && n !== null && isText(b) && isText(c) && isText(n)) {
          const m = merge3(c, b, n);
          if (m) result.set(r, m); else { conflicts.push(r); result.set(r, c); }
        } else { conflicts.push(r); result.set(r, c); }
      }
      const id = newId();
      fs.mkdirSync(cdir(id), { recursive: true });
      const start = path.join(cdir(id), 'start'), draft = path.join(cdir(id), 'draft');
      copyDir(live, path.join(start, name));
      fs.mkdirSync(path.join(draft, name), { recursive: true });
      for (const [r, b] of result) if (b !== null) { fs.mkdirSync(path.dirname(path.join(draft, name, r)), { recursive: true }); fs.writeFileSync(path.join(draft, name, r), b); }
      const meta = { source: 'update', createdAt: Date.now(), files: [], skills: [name], defHash: hDef, title: `${name} 出厂更新` };
      if (!conflicts.length) {
        await save(id, { ...meta, status: 'working', summary: modified ? '出厂版本更新了，和你改过的地方没有冲突，已自动合并。' : '出厂版本更新了，这个技能你没改过，直接换上新版。' });
        // 没改过的直接生效；改过的按设置（默认也是直接生效、能撤回）
        if (!modified) {
          const r = await settle(id, start, draft);
          if (r.status === 'pending') await apply(id);
          out.updated.push(name);
        } else {
          const r = await settle(id, start, draft);
          if (r.status === 'applied') out.merged.push(name);
        }
        if (rec(id)?.status === 'empty' || rec(id)?.status === 'applied') copyDir(def, base);
        continue;
      }
      // 有冲突：交给 Claude 合并。草稿是全部技能的副本，旧出厂版、新出厂版放在旁边给它对照
      copyDir(LIVE, start);
      copyDir(LIVE, draft);
      copyDir(base, path.join(cdir(id), 'old', name));
      copyDir(def, path.join(cdir(id), 'new', name));
      await save(id, { ...meta, status: 'queued', conflicts });
      out.conflicted.push(name);
    }
    return out;
  }
  const mergeDirs = (id) => ({ old: path.join(cdir(id), 'old'), next: path.join(cdir(id), 'new') });

  function listChanges({ skill, limit = 50, open } = {}) {
    return Object.entries(store.all().skillChanges || {})
      .map(([id, r]) => ({ id, ...r }))
      .filter((r) => r.status !== 'empty' && (!skill || (r.skills || []).includes(skill) || r.target === skill) && (!open || OPEN.includes(r.status)))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, limit);
  }
  // 老版本 SKILL.md 历史（改成「技能改动」之前存的），只读
  const historyContent = (name, at) => fs.readFileSync(path.join(HISTORY, check(name), `${Number(at)}.md`), 'utf8');

  // 服务重启时还标着「Claude 在改」的：上次被打断，重新排队
  for (const [id, r] of Object.entries(store.all().skillChanges || {})) if (r.status === 'working' && r.source !== 'manual' && r.source !== 'run') store.update('skillChanges', id, { status: 'queued' });

  return {
    sync, list, get, readSkillFile, writeSkillFile, create, remove, reset, setEnabled, settings, setSettings,
    listChanges, diff, apply, reject, revert, refine, idea, tidy, nextQueued, markWorking, finishDraft,
    draftDir, mergeDirs, historyContent, rec, LIVE,
  };
}

// 配音音色列表在配音技能里：先用在用的那份（你可能改过），没有就用出厂的
export function voicesFile(root) {
  const live = path.join(root, '.claude', 'skills', 'voice-over', 'voices.json');
  return fs.existsSync(live) ? live : path.join(root, 'defaults', 'skills', 'voice-over', 'voices.json');
}
