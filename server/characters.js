// 解说员角色库：一张参考图 → 一整套表情差分（每种表情：闭嘴、张嘴、半闭眼、闭眼），给做视频时驱动表情、嘴型和眨眼。
// 每个角色一个目录 data/characters/<id>/：ref.<扩展名>、各张差分图、character.json（清单和生成进度）。
// 只在设置角色时生成一次（用「设置 → 连接」里的图片接口，带参考图走 /images/edits），之后每条视频直接用，不再花钱。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateImage } from '../tools/img.mjs';
import { imageConfig } from './secrets.js';

export const ID_RE = /^[a-z0-9]{6,40}$/;

// 表情和姿势。prompt 只写表情和动作，角色、服装、画幅由公共部分保证一致
export const EXPRESSIONS = [
  { key: 'talk', label: '讲解', prompt: 'explaining something to the viewer with a bright friendly look, mouth closed in a gentle smile, one hand raised to chest height with the index finger pointing up and to the side as if presenting something beside her, the other arm relaxed' },
  { key: 'smug', label: '得意', prompt: 'playful smug confident look, one eye winking, closed-mouth confident smile, one hand on the hip, the other hand making a small V sign near the face' },
  { key: 'surprised', label: '惊讶', prompt: 'genuinely surprised, eyes wide open, eyebrows raised, mouth closed in a small round pursed shape, both hands raised near the cheeks with fingers spread, slight lean back' },
  { key: 'think', label: '疑惑', prompt: 'puzzled and thinking, head slightly tilted, eyes looking up to one side, mouth closed in a small uncertain pout, one hand under the chin, the other arm folded across the waist' },
  { key: 'shrug', label: '无奈', prompt: 'helpless shrug, both palms turned up at waist height, eyebrows raised in resignation, a wry closed-mouth smile' },
  { key: 'roast', label: '吐槽', prompt: 'deadpan unimpressed look for roasting something, half-lidded eyes, flat closed mouth slightly turned down, arms crossed over the chest' },
  { key: 'serious', label: '认真', prompt: 'serious and focused, calm steady gaze at the viewer, mouth closed in a firm line, hands loosely clasped in front of the waist' },
  { key: 'cheer', label: '开心', prompt: 'excited and happy, big bright smile with mouth closed, both fists raised at shoulder height in a small cheer' },
];
// 每种表情的变体：closed 是表情本身；其余以它为参考只改嘴或眼
export const VARIANTS = [
  { key: 'closed', label: '表情' },
  { key: 'open', label: '张嘴', prompt: 'the mouth: open it naturally mid-speech, a small open mouth showing a hint of the tongue, as if saying "ah". Keep the eyes and everything else exactly the same.' },
  { key: 'half', label: '半闭眼', prompt: 'the eyes: both eyes half closed mid-blink — the upper eyelids lowered halfway so only the lower half of each iris is visible, eyelashes following the lowered lid. Eyebrows and mouth unchanged.' },
  { key: 'shut', label: '闭眼', prompt: 'the eyes: both eyes fully closed in a natural relaxed blink — the upper eyelids lowered all the way, eyelashes resting on a soft gently-curved lid line that follows the shape of the open eye (a calm closed eye, NOT a smiling ^^ arc). Eyebrows and mouth unchanged.' },
];
const SIZE = '1024x1536';
// 按官方价估的单张费用（美元）：竖版高质量出图约 0.04，带参考图输入再加一些
export const COST_PER_IMAGE = 0.06;

const BASE_PROMPT = 'Same character as the reference image, identical face, hair, accessories, outfit and colors. Waist-up portrait for a video presenter: framed from the top of the head (with a little margin above the hair) down to just below the waist, character centered, facing the viewer, relaxed friendly neutral expression with a soft closed-mouth smile, arms relaxed at the sides. Clean illustration style matching the reference exactly. Fully transparent background, no text, no props, no shadow on the ground.';
const EXPR_PROMPT = (p) => `Same character, same outfit, same art style and colors as the references. Keep exactly the same waist-up framing, scale and head position as the second reference image (the waist-up base). Fully transparent background, no text, no props. Expression and pose: ${p}.`;
const VARIANT_PROMPT = (p) => `Reproduce this exact image as faithfully as possible: identical pose, hands, hair strands, outfit, framing, lighting and transparent background. Change ONLY ${p}`;

export function createCharacters({ root }) {
  const DIR = path.join(root, 'data', 'characters');
  const dirOf = (id) => path.join(DIR, id);
  const manifestPath = (id) => path.join(dirOf(id), 'character.json');
  const jobs = new Map(); // id -> { stop: boolean }

  const check = (id) => {
    if (!ID_RE.test(id || '') || !fs.existsSync(manifestPath(id))) throw Object.assign(new Error('找不到这个角色'), { status: 404 });
    return id;
  };
  const read = (id) => JSON.parse(fs.readFileSync(manifestPath(check(id)), 'utf8'));
  const write = (m) => { m.updatedAt = Date.now(); fs.writeFileSync(manifestPath(m.id), JSON.stringify(m, null, 2)); return m; };
  const fileOf = (key, variant) => (key === 'base' ? 'base.png' : `${key}-${variant}.png`);
  const has = (id, f) => fs.existsSync(path.join(dirOf(id), f));

  // 一整套要哪些图：基准半身 + 每种表情 × 每个变体
  function plan(id) {
    const list = [{ key: 'base', variant: 'closed', file: 'base.png' }];
    for (const e of EXPRESSIONS) for (const v of VARIANTS) list.push({ key: e.key, variant: v.key, file: fileOf(e.key, v.key) });
    return list.map((x) => ({ ...x, done: has(id, x.file) }));
  }

  function view(id) {
    const m = read(id), p = plan(id), job = jobs.get(id);
    const missing = p.filter((x) => !x.done).length;
    return {
      ...m,
      dir: path.relative(root, dirOf(id)),
      expressions: EXPRESSIONS.map((e) => ({ key: e.key, label: e.label, variants: Object.fromEntries(VARIANTS.map((v) => [v.key, has(id, fileOf(e.key, v.key)) ? fileOf(e.key, v.key) : null])) })),
      base: has(id, 'base.png') ? 'base.png' : null,
      total: p.length, missing, estimate: +(missing * COST_PER_IMAGE).toFixed(2),
      running: !!job,
    };
  }

  function list() {
    if (!fs.existsSync(DIR)) return [];
    return fs.readdirSync(DIR).filter((d) => ID_RE.test(d) && fs.existsSync(manifestPath(d))).map((d) => view(d)).sort((a, b) => b.createdAt - a.createdAt);
  }

  // 新建：参考图从 data/uploads/ 里来（页面先上传）
  function create({ name, ref }) {
    const n = String(name || '').trim().slice(0, 30);
    if (!n) throw Object.assign(new Error('给角色起个名字'), { status: 400 });
    if (!/^data\/uploads\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(ref || '') || !fs.existsSync(path.join(root, ref))) throw Object.assign(new Error('先上传一张角色参考图'), { status: 400 });
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    fs.mkdirSync(dirOf(id), { recursive: true });
    const refFile = `ref${path.extname(ref)}`;
    fs.copyFileSync(path.join(root, ref), path.join(dirOf(id), refFile));
    return view(write({ id, name: n, ref: refFile, createdAt: Date.now(), job: null }).id);
  }

  function rename(id, name) {
    const m = read(id), n = String(name || '').trim().slice(0, 30);
    if (!n) throw Object.assign(new Error('名字不能空'), { status: 400 });
    m.name = n;
    write(m);
    return view(id);
  }

  // 删掉某一张（重画就是删掉再补齐）
  function removeFile(id, key, variant) {
    check(id);
    if (!(key === 'base' || (EXPRESSIONS.some((e) => e.key === key) && VARIANTS.some((v) => v.key === variant)))) throw Object.assign(new Error('没有这张图'), { status: 400 });
    fs.rmSync(path.join(dirOf(id), fileOf(key, variant)), { force: true });
    return view(id);
  }

  function remove(id) {
    check(id);
    if (jobs.has(id)) throw Object.assign(new Error('还在生成，先停下'), { status: 409 });
    fs.rmSync(dirOf(id), { recursive: true, force: true });
    return { ok: true };
  }

  // 补齐缺的图：先基准半身，再各表情，再各变体；同时最多 3 张。中途停下或失败，下次接着补
  function generate(id) {
    const m = read(id);
    if (jobs.has(id)) throw Object.assign(new Error('已经在生成了'), { status: 409 });
    if (!imageConfig().apiKey) throw Object.assign(new Error('先在「设置 → 连接」里填图片生成的 key'), { status: 400 });
    const todo = plan(id).filter((x) => !x.done);
    if (!todo.length) return view(id);
    const job = { stop: false };
    jobs.set(id, job);
    m.job = { status: 'running', total: todo.length, done: 0, failed: [], startedAt: Date.now() };
    write(m);
    const d = dirOf(id), ref = path.join(d, m.ref), base = path.join(d, 'base.png');
    const step = async (x) => {
      if (job.stop) return;
      const out = path.join(d, x.file);
      try {
        if (x.key === 'base') await generateImage({ prompt: BASE_PROMPT, refs: [ref], out, size: SIZE, background: 'transparent' });
        else if (x.variant === 'closed') await generateImage({ prompt: EXPR_PROMPT(EXPRESSIONS.find((e) => e.key === x.key).prompt), refs: [ref, base], out, size: SIZE, background: 'transparent' });
        else await generateImage({ prompt: VARIANT_PROMPT(VARIANTS.find((v) => v.key === x.variant).prompt), refs: [path.join(d, fileOf(x.key, 'closed'))], out, size: SIZE, background: 'transparent' });
        const cur = read(id); cur.job.done++; write(cur);
      } catch (err) {
        const cur = read(id); cur.job.failed.push({ file: x.file, error: String(err.message || err).slice(0, 200) }); write(cur);
      }
    };
    const pool = async (items) => {
      const queue = [...items];
      await Promise.all(Array.from({ length: 3 }, async () => { while (queue.length && !job.stop) await step(queue.shift()); }));
    };
    (async () => {
      // 有依赖：基准 → 表情（要基准）→ 变体（要对应表情）。前一层没出来的，后一层跳过
      await pool(todo.filter((x) => x.key === 'base'));
      if (has(id, 'base.png')) await pool(todo.filter((x) => x.key !== 'base' && x.variant === 'closed'));
      await pool(todo.filter((x) => x.variant !== 'closed' && x.key !== 'base' && has(id, fileOf(x.key, 'closed'))));
    })().finally(() => {
      jobs.delete(id);
      const cur = read(id);
      cur.job.status = job.stop ? 'stopped' : cur.job.failed.length ? 'partial' : 'done';
      cur.job.finishedAt = Date.now();
      write(cur);
    });
    return view(id);
  }

  function stop(id) {
    check(id);
    const job = jobs.get(id);
    if (job) job.stop = true;
    return view(id);
  }

  // 图片文件：只认清单里会出现的文件名
  function file(id, name) {
    check(id);
    if (!/^(ref\.(png|jpg|webp)|base\.png|[a-z]{2,20}-(closed|open|half|shut)\.png)$/.test(name || '')) return null;
    const f = path.join(dirOf(id), name);
    return fs.existsSync(f) ? f : null;
  }

  return { dirOf, list, view, create, rename, removeFile, remove, generate, stop, file, plan };
}
