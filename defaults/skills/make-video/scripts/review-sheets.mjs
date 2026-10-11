#!/usr/bin/env node
// 渲染前审片用的拼图：把 `hyperframes snapshot --at ...` 截的图（frame-NN-at-X.XXs.png）按时间排好，
// 有解说员角色层的就叠上同一时刻的那一帧（看得出她挡没挡住内容），每张标上时间码，拼成几张大图。
// 用法：node review-sheets.mjs --snapshots review/shots [--presenter presenter/frames] [--fps 30] --out review
// 输出：review/sheet-01.jpg …（竖屏一张 6×3，横屏一张 4×3），并打印每张图里各格对应的时间
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const fail = (m) => { console.error(m); process.exit(1); };
const shotsDir = arg('--snapshots'), presDir = arg('--presenter'), outDir = arg('--out') || 'review';
const FPS = Number(arg('--fps')) || 30;
if (!shotsDir || !fs.existsSync(shotsDir)) fail('用法：node review-sheets.mjs --snapshots review/shots [--presenter presenter/frames] --out review');

const shots = fs.readdirSync(shotsDir).map((f) => ({ f, m: f.match(/^frame-\d+-at-([\d.]+)s\.png$/) })).filter((x) => x.m)
  .map((x) => ({ file: path.join(shotsDir, x.f), t: Number(x.m[1]) })).sort((a, b) => a.t - b.t);
if (!shots.length) fail(`${shotsDir} 里没有 frame-NN-at-X.XXs.png 截图`);

const [W, H] = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', shots[0].file]).toString().trim().split(',').map(Number);
const landscape = W > H, COLS = landscape ? 4 : 6, ROWS = 3, PER = COLS * ROWS;
const TW = landscape ? 480 : 300, TH = Math.round((TW * H) / W / 2) * 2;
const FONT = ['/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find((f) => fs.existsSync(f));
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;

const tmp = path.join(outDir, '.tiles');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
let withPresenter = 0;
shots.forEach((s, i) => {
  const pf = presDir && path.join(presDir, `${String(Math.min(Math.round(s.t * FPS), 99999)).padStart(5, '0')}.png`);
  const hasP = pf && fs.existsSync(pf);
  if (hasP) withPresenter++;
  const label = FONT ? `,drawtext=fontfile='${FONT}':text='${fmt(s.t).replace(/:/g, '\\:')}':fontsize=${Math.round(TH / 9)}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6:x=8:y=8` : '';
  const filter = hasP ? `[0][1]overlay=0:0,scale=${TW}:${TH}${label}` : `[0]scale=${TW}:${TH}${label}`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', s.file, ...(hasP ? ['-i', pf] : []), '-filter_complex', filter, '-frames:v', '1', path.join(tmp, `${String(i).padStart(4, '0')}.png`)]);
});

fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (/^sheet-\d+\.jpg$/.test(f)) fs.rmSync(path.join(outDir, f));
const sheets = [];
for (let k = 0; k * PER < shots.length; k++) {
  const out = path.join(outDir, `sheet-${String(k + 1).padStart(2, '0')}.jpg`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-start_number', String(k * PER), '-i', path.join(tmp, '%04d.png'), '-frames:v', '1',
    '-vf', `tile=${COLS}x${ROWS}:padding=6:color=0x202020`, '-q:v', '3', out]);
  sheets.push({ sheet: out, times: shots.slice(k * PER, (k + 1) * PER).map((s) => fmt(s.t)) });
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify({ shots: shots.length, withPresenter, layout: `${COLS}x${ROWS}`, sheets }, null, 2));
