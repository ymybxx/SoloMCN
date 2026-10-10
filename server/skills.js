// 技能是用户自己的数据：仓库只带出厂说明（defaults/skills），在用的技能在 .claude/skills（不进 git），
// Claude Code 原生就读这个目录，所以在工作台、终端、桌面端跑的都是同一份。
// 首次启动把出厂说明复制过去；以后出厂说明更新时：没改过的直接跟着更新，改过的只提示，由用户决定怎么合。
// 记录每个技能是基于哪一版出厂说明装的（data/skills/base/<名字>/），用来判断「改过没有」和做三方合并。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

export function createSkills({ root }) {
  const DEFAULTS = path.join(root, 'defaults', 'skills');
  const LIVE = path.join(root, '.claude', 'skills');
  const BASE = path.join(root, 'data', 'skills', 'base'); // 装的时候那一版出厂说明的副本
  const HISTORY = path.join(root, 'data', 'skills', 'history');

  const check = (name) => {
    if (!NAME_RE.test(name || '')) throw Object.assign(new Error('技能名只能用小写字母、数字和连字符'), { status: 400 });
    return name;
  };
  const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && NAME_RE.test(e.name)).map((e) => e.name) : []);
  // 一个技能目录下的所有文件（相对路径），跳过隐藏文件
  function files(dir, rel = '') {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      if (e.name.startsWith('.')) return [];
      const r = path.join(rel, e.name);
      return e.isDirectory() ? files(dir, r) : [r];
    }).sort();
  }
  function hash(dir) {
    const h = crypto.createHash('sha256');
    for (const f of files(dir)) h.update(f + '\0').update(fs.readFileSync(path.join(dir, f))).update('\0');
    return files(dir).length ? h.digest('hex') : null;
  }
  const copyDir = (from, to) => { fs.rmSync(to, { recursive: true, force: true }); fs.cpSync(from, to, { recursive: true }); };
  const read = (dir) => { try { return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { return ''; } };
  // SKILL.md 开头的 description
  const describe = (text) => (text.match(/^---[\s\S]*?\ndescription:\s*(.+)\n[\s\S]*?---/) || [])[1]?.trim() || '';

  // 启动时：装上新的出厂技能；没改过的跟着出厂说明更新
  function sync() {
    fs.mkdirSync(LIVE, { recursive: true });
    const out = { installed: [], updated: [] };
    for (const name of dirs(DEFAULTS)) {
      const def = path.join(DEFAULTS, name), live = path.join(LIVE, name), base = path.join(BASE, name);
      if (!fs.existsSync(live)) {
        copyDir(def, live); copyDir(def, base); out.installed.push(name); continue;
      }
      if (!fs.existsSync(base)) { copyDir(def, base); continue; } // 老用户第一次用这个功能：以当前出厂说明为基准
      const hDef = hash(def), hBase = hash(base);
      if (hDef !== hBase && hash(live) === hBase) { copyDir(def, live); copyDir(def, base); out.updated.push(name); }
    }
    return out;
  }

  function status(name) {
    const def = path.join(DEFAULTS, name), live = path.join(LIVE, name), base = path.join(BASE, name);
    const hasDefault = fs.existsSync(def);
    const hLive = hash(live), hBase = fs.existsSync(base) ? hash(base) : null;
    return {
      name,
      description: describe(read(live) || read(def)),
      origin: hasDefault ? 'default' : 'custom', // 出厂的 / 你自己加的
      modified: hasDefault ? hLive !== hBase : true,
      update: hasDefault && hBase !== null && hash(def) !== hBase, // 出厂说明有新版本
      files: files(live),
    };
  }

  const list = () => [...new Set([...dirs(LIVE), ...dirs(DEFAULTS)])].sort().map(status);

  function get(name) {
    check(name);
    if (!fs.existsSync(path.join(LIVE, name))) throw Object.assign(new Error('没有这个技能'), { status: 404 });
    const s = status(name);
    return { ...s, content: read(path.join(LIVE, name)), defaultContent: s.origin === 'default' ? read(path.join(DEFAULTS, name)) : null, history: history(name) };
  }

  // 改之前先存一份旧版，可以退回
  function snapshot(name) {
    const cur = read(path.join(LIVE, name));
    if (!cur) return;
    const dir = path.join(HISTORY, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${Date.now()}.md`), cur);
    const old = fs.readdirSync(dir).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.rmSync(path.join(dir, f)); // 只留最近 30 版
  }
  const history = (name) => {
    const dir = path.join(HISTORY, check(name));
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+\.md$/.test(f)).map((f) => Number(f.slice(0, -3))).sort((a, b) => b - a) : [];
  };
  const historyContent = (name, at) => fs.readFileSync(path.join(HISTORY, check(name), `${Number(at)}.md`), 'utf8');

  function save(name, content) {
    check(name);
    if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('技能内容不能为空'), { status: 400 });
    const dir = path.join(LIVE, name);
    if (fs.existsSync(dir)) snapshot(name); else fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content.endsWith('\n') ? content : content + '\n');
    return status(name);
  }

  // 恢复成出厂说明（连带脚本等文件）
  function reset(name) {
    check(name);
    const def = path.join(DEFAULTS, name);
    if (!fs.existsSync(def)) throw Object.assign(new Error('这是你自己加的技能，没有出厂版本'), { status: 400 });
    snapshot(name);
    copyDir(def, path.join(LIVE, name)); copyDir(def, path.join(BASE, name));
    return status(name);
  }

  // 出厂说明更新了、你也改过：content 是合并后的结果（或者你决定保留自己的版本）。
  // 出厂版本里新加的脚本等文件一起带过来，SKILL.md 用你确认的内容；之后以新的出厂说明为基准
  function acceptUpdate(name, content) {
    check(name);
    const def = path.join(DEFAULTS, name), live = path.join(LIVE, name);
    if (!fs.existsSync(def)) throw Object.assign(new Error('这是你自己加的技能，没有出厂版本'), { status: 400 });
    snapshot(name);
    for (const f of files(def)) {
      if (f === 'SKILL.md') continue;
      fs.mkdirSync(path.dirname(path.join(live, f)), { recursive: true });
      fs.copyFileSync(path.join(def, f), path.join(live, f));
    }
    if (typeof content === 'string' && content.trim()) fs.writeFileSync(path.join(live, 'SKILL.md'), content.endsWith('\n') ? content : content + '\n');
    copyDir(def, path.join(BASE, name));
    return status(name);
  }

  // 三方合并要用的三份：装的时候的出厂说明、新的出厂说明、你现在的版本
  function mergeInputs(name) {
    check(name);
    return { base: read(path.join(BASE, name)), next: read(path.join(DEFAULTS, name)), mine: read(path.join(LIVE, name)) };
  }

  return { sync, list, get, save, reset, acceptUpdate, mergeInputs, historyContent, LIVE };
}
