#!/usr/bin/env node
// 成片体检：只读成片 mp4，量三样容易做坏的地方，给审片当线索。只报告、不拦片。
// 用法：node film-check.mjs renders/video.mp4 [--cuts 3.2,7.3,...] [--json]
//   --cuts：每个镜头的起点（秒）。给了就把起点前后 0.35 秒的转场排除掉，不把转场算成镜头内运动
//   1. 镜头内快速运动帧占比：太低就是「翻页式 PPT」——每镜匀速慢推、要点逐条淡入，一直没有真正的画面事件
//   2. 中段的空画面：连续 0.3 秒以上整帧几乎没有边缘和纹理（纯色、黑场、空景）
//   3. 蓝紫底画面占比：蓝紫渐变、深紫星空、霓虹青紫，一眼 AI 味
// 指标和阈值参考 huashu-art-motion 的 film_gate.py（MIT，alchaincyf），那边用作者表过态的十几支片标定；
// 我们的片子风格不同，所以这里只当线索，最终以看抽帧和审片为准。依赖 ffmpeg、ffprobe。
import { spawn, execFileSync } from 'node:child_process';

const file = process.argv[2];
const asJson = process.argv.includes('--json');
if (!file || file.startsWith('--')) { console.error('用法：node film-check.mjs renders/video.mp4 [--cuts 3.2,7.3,...] [--json]'); process.exit(1); }
const ci = process.argv.indexOf('--cuts');
const cutTimes = ci > 0 ? String(process.argv[ci + 1] || '').split(',').map(Number).filter((t) => t > 0) : [];

const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]).toString());
const { width, height } = probe.streams[0];
const duration = Number(probe.format.duration);
const W = 320, H = Math.round((height / width) * W / 2) * 2;

// 逐帧读成 raw 像素，边读边算，不把整片放进内存
function frames(fps, w, h, pixFmt, bpp, onFrame) {
  return new Promise((resolve, reject) => {
    const size = w * h * bpp;
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=${w}:${h}:flags=area,format=${pixFmt}`, '-f', 'rawvideo', '-']);
    let buf = Buffer.alloc(0), idx = 0;
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= size) { onFrame(buf.subarray(0, size), idx++); buf = buf.subarray(size); }
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(idx) : reject(new Error(`ffmpeg 退出码 ${code}`))));
  });
}

// ---------- 1、2：12 fps 灰度 ----------
const FPS = 12, SUB = 0.15; // 底部 15% 当字幕带，不计入
const rows = Math.floor(H * (1 - SUB));
const diffs = [], edgeFrac = [];
let prev = null;
await frames(FPS, W, H, 'gray', 1, (f, i) => {
  // 边缘：梯度超过 24 的像素占比
  let edges = 0;
  for (let y = 1; y < rows - 1; y++) for (let x = 1; x < W - 1; x++) {
    const k = y * W + x, gx = f[k + 1] - f[k - 1], gy = f[k + W] - f[k - W];
    if (Math.abs(gx) + Math.abs(gy) > 24) edges++;
  }
  edgeFrac.push(edges / ((rows - 2) * (W - 2)));
  if (prev) {
    let s = 0;
    for (let k = 0; k < rows * W; k++) s += Math.abs(f[k] - prev[k]);
    diffs.push(s / (rows * W));
  }
  prev = Buffer.from(f);
});

// 切点：比前后都大很多的一跳。切点和紧跟的一帧不算镜头内运动
const nearGiven = (i) => cutTimes.some((t) => Math.abs((i + 1) / FPS - t) <= 0.35);
const isCut = diffs.map((d, i) => nearGiven(i) || (d >= 30 && d > 3 * Math.max(diffs[i - 1] ?? 0, diffs[i + 1] ?? 0, 1)));
const cutNear = (i) => isCut[i] || isCut[i - 1];
let fast = 0, counted = 0;
diffs.forEach((d, i) => { if (cutNear(i)) return; counted++; if (d >= 9) fast++; });
const fastRatio = counted ? fast / counted : 0;

const blanks = [];
let runStart = null;
edgeFrac.forEach((e, i) => {
  const t = i / FPS;
  const skip = t < 0.5 || t > duration - 0.5 || cutNear(i) || cutNear(i - 1);
  const blank = !skip && e < 0.002;
  if (blank && runStart == null) runStart = t;
  if (!blank && runStart != null) { if (t - runStart >= 0.3) blanks.push([runStart, t]); runStart = null; }
});
if (runStart != null && duration - 0.5 - runStart >= 0.3) blanks.push([runStart, duration - 0.5]);

// ---------- 3：2 fps 彩色，量蓝紫 ----------
const CW = 160, CH = Math.round((height / width) * CW / 2) * 2;
let bpFrames = 0, colorFrames = 0;
const bpTimes = [];
await frames(2, CW, CH, 'rgb24', 3, (f, i) => {
  let n = 0;
  for (let k = 0; k < CW * CH; k++) {
    const r = f[k * 3] / 255, g = f[k * 3 + 1] / 255, b = f[k * 3 + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, s = mx ? (mx - mn) / mx : 0;
    if (s < 0.3 || v < 0.06 || v > 0.9) continue;
    let h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
    h = (h * 60 + 360) % 360;
    if (h >= 225 && h <= 300) n++;
  }
  colorFrames++;
  if (n / (CW * CH) >= 0.3) { bpFrames++; bpTimes.push(i / 2); }
});
const bpRatio = colorFrames ? bpFrames / colorFrames : 0;

// ---------- 结论 ----------
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const flags = [];
if (fastRatio < 0.035) flags.push({ level: '红', item: '镜头内快速运动太少', detail: `快速运动帧占 ${(fastRatio * 100).toFixed(1)}%：像在翻 PPT。每镜要有画面事件：停住 → 快推/横移/砸入 → 停住，不要全程匀速慢推、逐条淡入` });
else if (fastRatio < 0.06) flags.push({ level: '黄', item: '镜头内快速运动偏少', detail: `快速运动帧占 ${(fastRatio * 100).toFixed(1)}%：看看哪几镜一直在慢推或只有字在淡入` });
if (blanks.length) flags.push({ level: '红', item: '中段有空画面', detail: blanks.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join('、') + '：整帧几乎没有东西，主角或主物要在画里' });
if (bpRatio >= 0.3) flags.push({ level: '红', item: '蓝紫底太多', detail: `蓝紫画面占 ${(bpRatio * 100).toFixed(0)}%：系列没要求蓝紫就换色板` });
else if (bpRatio >= 0.12) flags.push({ level: '黄', item: '蓝紫底偏多', detail: `蓝紫画面占 ${(bpRatio * 100).toFixed(0)}%，例如 ${bpTimes.slice(0, 3).map(fmt).join('、')}` });

const report = {
  file, duration_s: +duration.toFixed(2), cuts: cutTimes.length || isCut.filter(Boolean).length,
  fast_motion_ratio: +fastRatio.toFixed(4), blank_spans: blanks.map(([a, b]) => [+a.toFixed(2), +b.toFixed(2)]),
  blue_purple_ratio: +bpRatio.toFixed(3), flags,
};
if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`成片体检：${file}（${duration.toFixed(1)} 秒，${report.cuts} 个切点）`);
  console.log(`- 镜头内快速运动帧：${(fastRatio * 100).toFixed(1)}%（低于 3.5% 像翻 PPT，6% 以上正常）`);
  console.log(`- 空画面：${blanks.length ? blanks.map(([a, b]) => `${fmt(a)}–${fmt(b)}`).join('、') : '没有'}`);
  console.log(`- 蓝紫画面：${(bpRatio * 100).toFixed(0)}%`);
  console.log(flags.length ? flags.map((f) => `【${f.level}】${f.item}：${f.detail}`).join('\n') : '没发现这三类问题。其余靠看抽帧和审片。');
}
