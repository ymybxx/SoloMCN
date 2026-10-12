#!/usr/bin/env node
// 解说员：把角色库里的表情差分做成会动的角色层，叠到成片上。
// 用法：node presenter.mjs --spec presenter/spec.json [--overlay renders/video.mp4] [--workers 4] [--force]
//   不带 --overlay：只画角色层（presenter/frames/*.png，透明背景）。配音和表情定下来就可以在后台先画
//   带 --overlay：叠到这个成片上；原片先改名为 *-base.mp4，叠好的写回原文件名
//   参数、配音、角色图都没变时，直接复用画好的角色层（几秒），不重画；--force 强制重画
//   画幅：spec 里写了 width/height 就用它；没写就读 --overlay 成片的尺寸，再没有就读项目 index.html 的 data-width/height
//
// 让一张立绘「活」起来的做法：
//   - 张嘴、半闭眼、闭眼图只取和表情图不同的那一小块（嘴、眼），当补丁叠上去，身体和头发边缘不受影响
//   - 网格变形（WebGL 整体贴图）：头部转动和点头、呼吸、头发两侧摆动、身体随说话轻晃
//   - 嘴型跟配音音量平滑开合；眨眼按 半闭→闭→闭→半闭 4 帧直接换图；换表情时按权重淡入再轻轻弹一下
//   - 说话带动的动作先把音量做平滑再用，点头用起步速度为 0 的曲线，不会抖
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SOLOMCN_ROOT || path.resolve(HERE, '../../../..'); // 工作台根目录（.claude/skills/explainer-video/scripts 往上四层）
const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'playwright-core', 'index.mjs')).href);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const fail = (m) => { console.error(m); process.exit(1); };
const specPath = arg('--spec'), overlay = arg('--overlay');
if (!specPath) fail('用法：node presenter.mjs --spec presenter/spec.json [--overlay renders/video.mp4]');
let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch (e) { fail(`读不了参数文件：${e.message}`); }

// 画幅：spec → 成片 → 项目 index.html。默认值会画错（横屏片按竖屏画），所以宁可报错
function frameSize() {
  if (Number(spec.width) > 0 && Number(spec.height) > 0) return [Number(spec.width), Number(spec.height)];
  if (overlay && fs.existsSync(overlay)) {
    const [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', overlay]).toString().trim().split(',').map(Number);
    if (w > 0 && h > 0) return [w, h];
  }
  const idx = path.resolve('index.html');
  if (fs.existsSync(idx)) {
    const html = fs.readFileSync(idx, 'utf8'), w = html.match(/data-width="(\d+)"/), h = html.match(/data-height="(\d+)"/);
    if (w && h) return [Number(w[1]), Number(h[1])];
  }
  fail('不知道画幅：在 spec 里写 "width" 和 "height"（和成片一样，例如横屏 1920、1080）');
}
const FPS = Number(spec.fps) || 30, [W, H] = frameSize();
const charDir = path.isAbsolute(spec.character || '') ? spec.character : path.join(ROOT, spec.character || '');
if (!fs.existsSync(path.join(charDir, 'character.json'))) fail(`找不到角色目录：${spec.character}（用 get_item 返回的 presenter.dir）`);
const duration = Number(spec.duration);
if (!(duration > 0 && duration <= 600)) fail('duration 写成片总时长（秒）');
const outDir = path.resolve(path.dirname(specPath), spec.out || 'frames');

// ---------- 表情和图片 ----------
const cues = (spec.cues || [{ at: 0, expr: 'talk' }]).map((c) => ({ at: Number(c.at) || 0, expr: c.expr })).sort((a, b) => a.at - b.at);
const exprs = [...new Set(cues.map((c) => c.expr))];
const IMGS = {};
for (const e of exprs) {
  const f = path.join(charDir, `${e}-closed.png`);
  if (!fs.existsSync(f)) fail(`角色没有「${e}」这个表情（看 get_item 的 presenter.expressions）`);
  for (const v of ['closed', 'open', 'half', 'shut']) {
    const p = path.join(charDir, `${e}-${v}.png`);
    if (fs.existsSync(p)) IMGS[`${e}-${v}`] = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  }
}

// ---------- 配音音量包络（每帧一个值）----------
const SR = 24000, nFrames = Math.ceil(duration * FPS);
const mix = new Float32Array(Math.ceil(duration * SR) + SR);
const voices = spec.voices || (spec.voice ? [{ file: spec.voice, start: 0 }] : []);
if (!voices.length) fail('voices 写配音文件和起点：[{ "file": "assets/voice/01.wav", "start": 0 }]');
for (const v of voices) {
  const real = path.resolve(v.file); // 相对项目目录（在项目目录里运行）
  if (!fs.existsSync(real)) fail(`找不到配音文件：${v.file}`);
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', real, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 29 });
  const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), o = Math.round(Number(v.start || 0) * SR);
  for (let i = 0; i < s.length && o + i < mix.length; i++) if (o + i >= 0) mix[o + i] += s[i];
}
const rms = [];
for (let f = 0; f < nFrames; f++) {
  const c = Math.round((f / FPS) * SR), half = 480;
  let s = 0, n = 0;
  for (let k = c - half; k < c + half; k++) if (k >= 0 && k < mix.length) { s += mix[k] ** 2; n++; }
  rms.push(n ? Math.sqrt(s / n) : 0);
}
const sorted = rms.filter((r) => r > 1e-4).sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
const env = rms.map((r) => Math.max(0, Math.min(1, (r / p95 - 0.12) / 0.7)));
const accents = [];
for (let f = 6; f < env.length - 2; f++) {
  if (env[f] > 0.85 && env[f] >= env[f - 1] && env[f] >= env[f + 1] && env[f] - Math.min(env[f - 6], env[f - 4]) > 0.4 && (!accents.length || f / FPS - accents[accents.length - 1] > 0.9)) accents.push(f / FPS);
}

// ---------- 位置 ----------
// layout：[{ at, side: "right"|"left", size: 0.34, bottom: 0.83, hidden: false }]
//   size：角色图高占画面高的比例；bottom：角色底边在画面高度的哪里（默认 0.83，正好在字幕条上方，下半身渐隐）
//   位置变化在 0.4 秒里滑过去；hidden 时滑出画面
const landscape = W > H;
const layout = (spec.layout || [{ at: 0 }]).map((l) => ({
  at: Number(l.at) || 0, side: l.side === 'left' ? 'left' : 'right', hidden: !!l.hidden,
  size: Math.min(0.9, Math.max(0.15, Number(l.size) || (landscape ? 0.5 : 0.34))),
  bottom: Math.min(1.05, Math.max(0.4, Number(l.bottom) || 0.83)),
})).sort((a, b) => a.at - b.at);

const setup = async ({ IMGS, env, accents, cues, layout, FPS, W, H }) => {
  const load = (src) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = src; });
  const img = {};
  for (const [k, v] of Object.entries(IMGS)) img[k] = await load(v);
  const first = img[`${cues[0].expr}-closed`], IW = first.width, IH = first.height;
  const canvas = (w = IW, h = IH) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const pixels = (i) => { const c = canvas(); const x = c.getContext('2d'); x.drawImage(i, 0, 0, IW, IH); return x.getImageData(0, 0, IW, IH).data; };

  // 补丁：变体只取和表情图差别大的那一块（嘴在下半张脸、眼睛在眼睛那一条），羽化
  const REGION = { mouth: [0.38, 0.62, 0.255, 0.345], eyes: [0.3, 0.7, 0.2, 0.295] };
  const notes = [];
  function patch(baseKey, varKey, part) {
    if (!img[varKey]) return;
    const a = pixels(img[baseKey]), b = pixels(img[varKey]);
    const [rx0, rx1, ry0, ry1] = REGION[part];
    const X0 = Math.round(IW * rx0), X1 = Math.round(IW * rx1), Y0 = Math.round(IH * ry0), Y1 = Math.round(IH * ry1), C = 6;
    let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
    for (let cy = Y0; cy < Y1; cy += C) for (let cx = X0; cx < X1; cx += C) {
      let hit = 0;
      for (let y = cy; y < cy + C; y++) for (let x = cx; x < cx + C; x++) { const k = (y * IW + x) * 4; if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) > 120) hit++; }
      if (hit > C * C * 0.35) { bx0 = Math.min(bx0, cx); by0 = Math.min(by0, cy); bx1 = Math.max(bx1, cx + C); by1 = Math.max(by1, cy + C); }
    }
    if (bx1 < 0) { notes.push(`${varKey}：没找到和表情图不同的地方，不用它`); delete img[varKey]; return; }
    const pad = 10, r = { x: bx0 - pad, y: by0 - pad, w: bx1 - bx0 + pad * 2, h: by1 - by0 + pad * 2 };
    const m = canvas(), mc = m.getContext('2d');
    mc.drawImage(img[varKey], 0, 0, IW, IH);
    mc.globalCompositeOperation = 'destination-in';
    const g = mc.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.35, r.x + r.w / 2, r.y + r.h / 2, Math.max(r.w, r.h) * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    mc.fillStyle = g; mc.fillRect(0, 0, IW, IH);
    img[varKey] = m;
  }
  for (const e of new Set(cues.map((c) => c.expr))) { patch(`${e}-closed`, `${e}-open`, 'mouth'); patch(`${e}-closed`, `${e}-half`, 'eyes'); patch(`${e}-closed`, `${e}-shut`, 'eyes'); }

  const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const bump = (d, peak) => (d <= 0 ? 0 : (d / peak) ** 2 * Math.exp(2 * (1 - d / peak)));
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const blinks = []; for (let t = 1.2; t < 700; t += 2.5 + rnd() * 2.5) { blinks.push(Math.round(t * FPS)); if (rnd() < 0.2) blinks.push(Math.round((t + 0.3) * FPS)); }
  const exprAt = (t) => { let e = cues[0].expr, at = 0, prev = e; for (const c of cues) if (c.at <= t) { prev = e; e = c.expr; at = c.at; } return { e, prev, at }; };
  let mouth = 0;
  const mouthSeries = env.map((v, f) => { const t = f / FPS, syl = 0.6 + 0.4 * Math.abs(Math.sin(Math.PI * t * 5.3)); const target = v > 0.05 ? Math.min(1, v * syl * 1.15) : 0; mouth += (target - mouth) * (target > mouth ? 0.7 : 0.45); return mouth; });
  const energy = []; { let e = 0; for (const v of env) { e += (v - e) * (v > e ? 0.12 : 0.05); energy.push(e); } }

  const src = canvas(), sx = src.getContext('2d');
  const layer = (key, open, blink) => {
    const c = canvas(), x = c.getContext('2d');
    x.drawImage(img[`${key}-closed`], 0, 0, IW, IH);
    if (open > 0.02 && img[`${key}-open`]) { x.globalAlpha = open; x.drawImage(img[`${key}-open`], 0, 0, IW, IH); x.globalAlpha = 1; }
    const lid = blink === 1 ? img[`${key}-half`] : blink === 2 ? img[`${key}-shut`] : null;
    if (lid) x.drawImage(lid, 0, 0, IW, IH);
    return c;
  };

  const COLS = 24, ROWS = 36;
  const neck = { x: IW * 0.5, y: IH * 0.37 }, foot = { x: IW * 0.5, y: IH * 1.1 };
  function deform(t, f, pop) {
    const en = energy[f] || 0, breath = 0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 3.8);
    let nod = 0; for (const a of accents) nod += 0.022 * bump(t - a, 0.35);
    const headA = 0.035 * Math.sin((2 * Math.PI * t) / 4.3) + 0.01 * Math.sin((2 * Math.PI * t) / 2.3 + 1) + nod;
    const bodyA = 0.01 * Math.sin((2 * Math.PI * t) / 5.7) + 0.008 * en * Math.sin((2 * Math.PI * t) / 2.6);
    const bob = -5 * en * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 1.7)) - 3 * breath, scale = 1 + pop;
    return (x, y) => {
      const wh = 1 - ss(IH * 0.33, IH * 0.46, y);
      if (wh > 0) { const a = headA * wh, dx = x - neck.x, dy = y - neck.y; x = neck.x + dx * Math.cos(a) - dy * Math.sin(a); y = neck.y + dx * Math.sin(a) + dy * Math.cos(a); }
      const wb = ss(IH * 0.36, IH * 0.45, y) * (1 - ss(IH * 0.55, IH * 0.75, y));
      y -= 4 * breath * wb; x += (x - IW / 2) * 0.008 * breath * wb;
      const wHair = ss(IW * 0.16, IW * 0.38, Math.abs(x - IW / 2)) * ss(IH * 0.3, IH * 0.85, y);
      x += 6 * wHair * Math.sin((2 * Math.PI * t) / 3.2 + y / 200);
      const dx = x - foot.x, dy = y - foot.y;
      x = foot.x + dx * Math.cos(bodyA) - dy * Math.sin(bodyA); y = foot.y + dx * Math.sin(bodyA) + dy * Math.cos(bodyA) + bob;
      return [(x - IW / 2) * scale + IW / 2, (y - IH) * scale + IH];
    };
  }
  // 位置：按 layout 在 0.4 秒里滑到新位置；hidden 时滑出画面下方
  const place = (l) => { const S = (l.size * H) / IH; return { S, X: l.side === 'left' ? -IW * S * 0.06 : W - IW * S * 0.94, Y: l.hidden ? H + 40 : l.bottom * H - IH * S }; };
  function placement(t) {
    let cur = place(layout[0]), prev = cur, at = 0;
    for (const l of layout) if (l.at <= t) { prev = cur; cur = place(l); at = l.at; }
    const k = ss(at, at + 0.4, t), mixv = (a, b) => a + (b - a) * k;
    return { S: mixv(prev.S, cur.S), X: mixv(prev.X, cur.X), Y: mixv(prev.Y, cur.Y) };
  }

  const glc = document.createElement('canvas'); glc.width = W; glc.height = H;
  const gl = glc.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
  if (!gl) throw new Error('浏览器不支持 WebGL2');
  const sh = (type, s) => { const o = gl.createShader(type); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, '#version 300 es\nin vec2 p; in vec2 uv; out vec2 v; uniform vec2 res;\nvoid main(){ v = uv; gl_Position = vec4(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, 0, 1); }'));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float; in vec2 v; uniform sampler2D tex; out vec4 o;\nvoid main(){ o = texture(tex, v) * (1.0 - smoothstep(0.8, 1.0, v.y)); }'));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.uniform2f(gl.getUniformLocation(prog, 'res'), W, H);
  const nV = (COLS + 1) * (ROWS + 1), uvs = new Float32Array(nV * 2), pos = new Float32Array(nV * 2);
  for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) { const k = (r * (COLS + 1) + c) * 2; uvs[k] = c / COLS; uvs[k + 1] = r / ROWS; }
  const idx = []; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const a = r * (COLS + 1) + c, b = a + 1, d = a + COLS + 1, e = d + 1; idx.push(a, b, d, b, e, d); }
  const buf = (data, loc, dyn) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, dyn ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW); const l = gl.getAttribLocation(prog, loc); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0); return b; };
  buf(uvs, 'uv', false); const posBuf = buf(pos, 'p', true);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const out = document.getElementById('c'), ctx = out.getContext('2d');
  window.renderFrame = (f) => {
    const t = f / FPS, { e, prev, at } = exprAt(t);
    const k = ss(at, at + 0.2, t), pop = at > 0 ? 0.03 * bump(t - at, 0.12) : 0;
    let blink = 0; for (const b of blinks) { const d = f - b; if (d >= 0 && d < 4) blink = [1, 2, 2, 1][d]; }
    sx.clearRect(0, 0, IW, IH);
    if (k < 1 && prev !== e) {
      sx.globalCompositeOperation = 'lighter';
      sx.globalAlpha = 1 - k; sx.drawImage(layer(prev, mouthSeries[f], 0), 0, 0);
      sx.globalAlpha = k; sx.drawImage(layer(e, mouthSeries[f], blink), 0, 0);
      sx.globalCompositeOperation = 'source-over'; sx.globalAlpha = 1;
    } else sx.drawImage(layer(e, mouthSeries[f], blink), 0, 0);
    const { S, X, Y } = placement(t), map = deform(t, f, pop);
    for (let r = 0; r <= ROWS; r++) for (let c = 0; c <= COLS; c++) { const [u, v] = map((c / COLS) * IW, (r / ROWS) * IH), q = (r * (COLS + 1) + c) * 2; pos[q] = X + u * S; pos[q + 1] = Y + v * S; }
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.bindTexture(gl.TEXTURE_2D, tex); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); gl.generateMipmap(gl.TEXTURE_2D);
    gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0); gl.finish();
    ctx.clearRect(0, 0, W, H); ctx.drawImage(glc, 0, 0);
  };
  return { notes, accents: accents.length };
};

// ---------- 画角色层（参数没变就复用）----------
const files = (dir, pre) => fs.readdirSync(dir).filter((f) => f.startsWith(pre)).sort();
const stamp = (f) => { const st = fs.statSync(f); return `${path.basename(f)}:${st.size}:${Math.round(st.mtimeMs)}`; };
const key = createHash('sha1').update(JSON.stringify({
  v: 2, W, H, FPS, duration, cues, layout,
  voices: voices.map((v) => [stamp(path.resolve(v.file)), Number(v.start || 0)]),
  chars: exprs.flatMap((e) => files(charDir, `${e}-`).map((f) => stamp(path.join(charDir, f)))),
})).digest('hex');
const keyFile = path.join(outDir, '.key');
const have = fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key && fs.existsSync(path.join(outDir, `${String(nFrames - 1).padStart(5, '0')}.png`));
const result = { frames: nFrames, size: `${W}x${H}`, dir: outDir };
if (have && !process.argv.includes('--force')) {
  result.reused = true;
} else {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  // 多个页面并行画：每帧的画面只由帧号决定，互不依赖，按连续的帧段分给各个页面
  const workers = Math.max(1, Math.min(8, Number(arg('--workers')) || Math.min(4, Math.floor(os.cpus().length / 2))));
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--use-angle=metal', '--enable-gpu-rasterization'] });
  const t0 = Date.now();
  const per = Math.ceil(nFrames / workers);
  const notes = new Set();
  await Promise.all(Array.from({ length: workers }, async (_, w) => {
    const from = w * per, to = Math.min(nFrames, from + per);
    if (from >= to) return;
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    await page.setContent(`<html><body style="margin:0;background:transparent"><canvas id="c" width="${W}" height="${H}"></canvas></body></html>`);
    const r = await page.evaluate(setup, { IMGS, env, accents, cues, layout, FPS, W, H });
    r.notes.forEach((n) => notes.add(n));
    const el = await page.$('#c');
    for (let f = from; f < to; f++) {
      await page.evaluate((f) => window.renderFrame(f), f);
      await el.screenshot({ path: path.join(outDir, `${String(f).padStart(5, '0')}.png`), omitBackground: true });
    }
    await page.close();
  }));
  await browser.close();
  fs.writeFileSync(keyFile, key);
  Object.assign(result, { workers, seconds: Math.round((Date.now() - t0) / 1000), notes: [...notes] });
}




if (overlay) {
  if (!fs.existsSync(overlay)) fail(`找不到成片：${overlay}`);
  const [vw, vh] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', overlay]).toString().trim().split(',').map(Number);
  if (vw !== W || vh !== H) fail(`角色层是 ${W}x${H}，成片是 ${vw}x${vh}：把 spec 的 width/height 改成和成片一样（或删掉让它自己读），再跑一次`);
  // 原片存成 *-base.mp4。video.mp4 是上次叠出来的（标记里的大小和时间对得上）就从原片重叠；对不上说明重新渲染过，用新的当原片
  const base = overlay.replace(/\.mp4$/, '-base.mp4'), mark = overlay + '.presenter';
  const st = fs.statSync(overlay), sig = `${st.size}:${Math.round(st.mtimeMs)}`;
  const ours = fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === sig && fs.existsSync(base);
  if (!ours) fs.renameSync(overlay, base);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', base, '-framerate', String(FPS), '-i', path.join(outDir, '%05d.png'),
    '-filter_complex', `[1]format=rgba[p];[0][p]overlay=0:0:format=auto:eof_action=pass,format=yuv420p[v]`,
    '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart', overlay], { stdio: 'inherit' });
  const st2 = fs.statSync(overlay); fs.writeFileSync(mark, `${st2.size}:${Math.round(st2.mtimeMs)}`);
  result.video = overlay;
  result.base = base;
}
console.log(JSON.stringify(result, null, 2));
