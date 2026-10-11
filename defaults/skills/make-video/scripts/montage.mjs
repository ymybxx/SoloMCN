#!/usr/bin/env node
// 原片剪辑：把同一首歌的多个舞台（直拍、不同场次、不同造型）对齐到同一条音轨上，按拍子切换，做成「一键换装」或多舞台混剪。
// 不用 HyperFrames 渲染：几十上百个切点直接用 ffmpeg 逐段截取、拼接，画面帧精确，几分钟就能出片。
//
//   node montage.mjs align  --master <音轨来源.mp4> <片段1.mp4> <片段2.mp4> ...   各片段相对主音轨的时间差，带可信度
//   node montage.mjs beats  --master <音轨来源.mp4> [--from 秒] [--to 秒]              主音轨的 BPM 和每一拍的时间
//   node montage.mjs compare --spec montage.json --at 30,60,90                         同一时刻各片段的画面拼成对比图（查对齐、调构图）
//   node montage.mjs plan   --spec montage.json                                         按 spec 排切点，写回 spec 的 cuts（不渲染）
//   node montage.mjs render --spec montage.json [--out renders/video.mp4]               渲染成片，顺带出切点表和缩略图拼图
//
// 时间约定：所有 at / from / to 都是「主音轨时间」（秒）。片段的 offset = 片段时间 − 主音轨时间。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const RATE = 4000; // 对齐用的音频采样率
const HOP = 40; // 10ms 一格
const ENV_HZ = RATE / HOP;
const FONT = ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc'].find((f) => fs.existsSync(f));

const die = (m) => { console.error(m); process.exit(1); };
function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) o[k] = true; else { o[k] = n; i++; } } else o._.push(a);
  }
  return o;
}
const r3 = (x) => Math.round(x * 1000) / 1000;
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', f]).toString());
const duration = (f) => Number(probe(f).format.duration);

// ---------- 音频特征 ----------
// 低频（鼓、贝斯）的起音包络：现场直拍里观众尖叫集中在高频，低频基本只有伴奏，对齐最稳
function envelope(file, band = 'lowpass=f=180,highpass=f=35') {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-af', band, '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (out.status !== 0) die(`读不了音频：${file}\n${out.stderr}`);
  const s = new Float32Array(out.stdout.buffer, out.stdout.byteOffset, out.stdout.length / 4);
  const n = Math.floor(s.length / HOP);
  const e = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = i * HOP; j < (i + 1) * HOP; j++) sum += s[j] * s[j];
    const v = Math.log(1e-6 + sum / HOP);
    e[i] = Math.max(0, v - prev);
    prev = v;
  }
  // 去均值、归一化
  let m = 0; for (const v of e) m += v; m /= n || 1;
  let sd = 0; for (let i = 0; i < n; i++) { e[i] -= m; sd += e[i] * e[i]; }
  sd = Math.sqrt(sd / (n || 1)) || 1;
  for (let i = 0; i < n; i++) e[i] /= sd;
  return e;
}

function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inv ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// 互相关：返回 lag（格）-> 相关值，lag 为正表示 b 比 a 晚（b 的时间 = a 的时间 + lag）
function xcorr(a, b) {
  let n = 1; while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a); br.set(b);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < n; i++) { const r = br[i] * ar[i] + bi[i] * ai[i]; const im = bi[i] * ar[i] - br[i] * ai[i]; ar[i] = r; ai[i] = im; }
  fft(ar, ai, true);
  return { c: ar, n };
}

function bestLag(a, b, maxLag) {
  const { c, n } = xcorr(a, b);
  const at = (lag) => c[(lag + n) % n];
  let best = 0, bestV = -Infinity;
  const vals = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) { const v = at(lag); vals.push(v); if (v > bestV) { bestV = v; best = lag; } }
  // 可信度：峰值比其他位置高出多少个标准差（离峰 0.3 秒以外）
  const far = vals.filter((_, i) => Math.abs(i - maxLag - best) > ENV_HZ * 0.3);
  const mean = far.reduce((s, v) => s + v, 0) / far.length;
  const sd = Math.sqrt(far.reduce((s, v) => s + (v - mean) ** 2, 0) / far.length) || 1;
  // 抛物线插值到格以下
  const y0 = at(best - 1), y1 = at(best), y2 = at(best + 1);
  const frac = (y0 - y2) / (2 * (y0 - 2 * y1 + y2)) || 0;
  return { lag: best + (Math.abs(frac) < 1 ? frac : 0), z: (bestV - mean) / sd };
}

// 一个短窗口在整个片段里的相关曲线：lag 是片段里的位置（格）减去窗口在主音轨里的位置
function scan(win, ec, start) {
  const { c, n } = xcorr(win, ec);
  const lo = -Math.floor(win.length / 2), hi = ec.length - Math.ceil(win.length / 2);
  const vals = new Float64Array(hi - lo + 1);
  for (let lag = lo; lag <= hi; lag++) vals[lag - lo] = c[(lag + n) % n];
  let mean = 0; for (const v of vals) mean += v; mean /= vals.length;
  let sd = 0; for (const v of vals) sd += (v - mean) ** 2; sd = Math.sqrt(sd / vals.length) || 1;
  const z = (lag) => (lag < lo || lag > hi ? -Infinity : (vals[lag - lo] - mean) / sd);
  const peak = (a, b) => { let best = null; for (let l = Math.max(lo, a); l <= Math.min(hi, b); l++) if (!best || z(l) > best.z) best = { lag: l, z: z(l) }; return best; };
  // 返回窗口在片段里的时间差（秒）：offset = 片段时间 − 主音轨时间
  const toOffset = (lag) => (lag - start) / ENV_HZ + start / ENV_HZ - start / ENV_HZ;
  return { z, peak, lo, hi, toOffset };
}

// 对齐：整体时间差 + 分段复核。单场直拍的音轨是连续的，整首用同一个时间差；
// 删减版、多天混剪（中间有接缝）在接缝后时间差会变：每 8 秒一个窗口复核，
// 连续 3 个以上窗口都明确指向另一个位置，才认为这里有接缝，另起一段（副歌重复会造成假匹配，所以门槛高）。
function align(master, clips, { maxShift = 120, debug = false } = {}) {
  const em = envelope(master);
  const W = 8 * ENV_HZ, HOPW = 4 * ENV_HZ;
  const out = [];
  for (const f of clips) {
    const ec = envelope(f);
    const dur = ec.length / ENV_HZ;
    const g = bestLag(em, ec, Math.round(maxShift * ENV_HZ));
    const G = g.lag / ENV_HZ;
    const windows = [];
    for (let s = 0; s + W <= em.length; s += HOPW) {
      const t0 = s / ENV_HZ, t1 = (s + W) / ENV_HZ;
      if (t0 + G < 0 || t1 + G > dur) continue; // 片段没覆盖到
      const sc = scan(em.subarray(s, s + W), ec, s);
      const near = sc.peak(Math.round(s + g.lag) - 3 * ENV_HZ, Math.round(s + g.lag) + 3 * ENV_HZ);
      const any = sc.peak(sc.lo, sc.hi);
      const w = { from: t0, to: t1, near: near && { offset: (near.lag - s) / ENV_HZ, z: near.z }, far: any && { offset: (any.lag - s) / ENV_HZ, z: any.z } };
      const nearOk = w.near && Math.abs(w.near.offset - G) < 0.06;
      w.state = nearOk && w.near.z >= 3 ? 'match'
        : w.far && w.far.z >= 8 && w.far.z >= (nearOk ? w.near.z : 0) + 4 && Math.abs(w.far.offset - G) > 0.06 ? 'shift'
          : 'unknown';
      windows.push(w);
    }
    // 连续 3 个以上、时间差一致的 shift 才算接缝
    for (let i = 0; i < windows.length; i++) {
      if (windows[i].state !== 'shift') continue;
      let j = i;
      while (j + 1 < windows.length && windows[j + 1].state === 'shift' && Math.abs(windows[j + 1].far.offset - windows[i].far.offset) < 0.05) j++;
      // 前后最近的可信窗口都还在原来的时间差上，说明中间没有接缝（接缝之后时间差会一直变着）：
      // 远处的峰多半是 UP 主片头里放过的同一段歌，或者副歌重复
      const before = windows.slice(0, i).reverse().find((w) => w.state !== 'unknown');
      const after = windows.slice(j + 1).find((w) => w.state !== 'unknown');
      const sandwiched = before?.state === 'match' && after?.state === 'match';
      if (j - i + 1 < 3 || sandwiched) for (let k = i; k <= j; k++) windows[k].state = 'unknown';
      i = j;
    }
    // 拼段：match/unknown 用整体时间差，shift 用自己的时间差；接缝两边各收 1 秒
    const segs = [];
    for (const w of windows) {
      const off = w.state === 'shift' ? w.far.offset : G;
      const cur = segs.at(-1);
      if (cur && Math.abs(cur.offset - off) < 0.05 && w.from <= cur.to) { cur.to = w.to; cur.states.push(w.state); }
      else segs.push({ from: w.from, to: w.to, offset: off, states: [w.state] });
    }
    const segments = segs.map((x, i) => ({
      from: r3(Math.max(x.from + (i > 0 ? 1 : 0), -x.offset + 0.2)),
      to: r3(Math.min(x.to - (i < segs.length - 1 ? 1 : 0), dur - x.offset - 0.2)),
      offset: r3(x.offset),
      matched: Math.round((x.states.filter((s) => s !== 'unknown').length / x.states.length) * 100) / 100,
    })).filter((x) => x.to - x.from >= 3 && x.matched >= 0.3);
    const covered = r3(segments.reduce((a, x) => a + x.to - x.from, 0));
    out.push({
      file: f, offset: r3(G), z: Math.round(g.z * 10) / 10, segments, covered,
      ...(debug ? { windows: windows.map((w) => ({ at: w.from, state: w.state, near: w.near && [r3(w.near.offset), Math.round(w.near.z * 10) / 10], far: w.far && [r3(w.far.offset), Math.round(w.far.z * 10) / 10] })) } : {}),
      // 整体可信度低、或者大部分窗口都对不上，就别用
      ok: g.z >= 8 && covered >= 20,
    });
  }
  return out;
}

// ---------- 节拍 ----------
function beats(master, { from = 0, to = Infinity } = {}) {
  const e = envelope(master);
  const a = Math.max(0, Math.floor(from * ENV_HZ)), b = Math.min(e.length, Math.floor((Number.isFinite(to) ? to : e.length / ENV_HZ) * ENV_HZ));
  const x = e.subarray(a, b);
  // 自相关挑周期，70–180 BPM，取最强的（舞曲常见 3/4、1/2 倍的假峰，比较弱）
  let best = null;
  const cand = [];
  for (let lag = Math.round(ENV_HZ * 60 / 180); lag <= Math.round(ENV_HZ * 60 / 70); lag++) {
    let s = 0; for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag];
    const bpm = 60 * ENV_HZ / lag;
    cand.push({ bpm: Math.round(bpm * 10) / 10, s: Math.round((s / x.length) * 1000) / 1000 });
    if (!best || s > best.s) best = { s, lag };
  }
  // 细化周期：在整段上用梳状滤波找最准的小数周期和相位
  let top = null;
  for (let p = best.lag - 1; p <= best.lag + 1; p += 0.01) {
    for (let ph = 0; ph < p; ph += 1) {
      let s = 0; for (let t = ph; t < x.length; t += p) s += x[Math.round(t)] || 0;
      if (!top || s > top.s) top = { s, p, ph };
    }
  }
  const period = top.p / ENV_HZ;
  const first = from + top.ph / ENV_HZ;
  const list = [];
  for (let t = first; t < from + x.length / ENV_HZ; t += period) list.push(r3(t));
  return { bpm: Math.round(600 / period) / 10, period: r3(period), first: r3(first), candidates: cand.sort((a, b) => b.s - a.s).slice(0, 5), beats: list };
}

// ---------- 排切点 ----------
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// 片段在主音轨 [a, b] 这段能不能用：落在某个对齐段里、不在排除范围里。能用就返回这一段的时间差
function usable(s, a, b) {
  if ((s.exclude || []).some(([x, y]) => a < y && b > x)) return null;
  const segs = s.segments?.length ? s.segments : [{ from: -Infinity, to: Infinity, offset: s.offset }];
  const seg = segs.find((g) => a >= g.from - 0.01 && b <= g.to + 0.01);
  if (!seg) return null;
  return a + seg.offset >= 0.05 && b + seg.offset <= (s.duration ?? Infinity) - 0.05 ? seg.offset : null;
}

function plan(spec, dir) {
  const master = path.resolve(dir, spec.audio.file);
  const from = spec.audio.start ?? 0, to = spec.audio.end ?? duration(master);
  const auto = spec.auto || {};
  // 节拍按整首算（短片段算 BPM 容易落到 3/4、1/2 倍的假峰上），再取用到的这一段
  const bt = spec.beats || beats(master);
  const grid = bt.beats.filter((t) => t >= from - 0.01 && t <= to);
  if (!grid.length || grid[0] - from > 0.05) grid.unshift(from);
  const srcs = spec.sources.filter((s) => s.offset != null && s.use !== false);
  if (srcs.length < 2) die('能用的片段少于 2 个（先 align 填好 offset）');
  const pins = [...(spec.pins || [])].sort((x, y) => x.from - y.from); // 指定某段用某个片段（名场面、定格）
  const per = (t) => (auto.sections || []).find((x) => t >= x.from && t < x.to)?.beatsPerCut ?? auto.beatsPerCut ?? 4;
  const rand = rng(auto.seed || 1);
  const cuts = [];
  const used = new Map();
  const recent = [];
  let i = 0;
  while (i < grid.length) {
    const at = grid[i];
    const pin = pins.find((p) => at >= p.from - 0.01 && at < p.to);
    if (pin) {
      const s = srcs.find((x) => x.id === pin.src) || die(`pins 里的片段 ${pin.src} 不存在或没对齐`);
      const off = usable(s, at, Math.min(pin.to, to));
      if (off == null) die(`pins：${pin.src} 在 ${r3(at)}–${r3(pin.to)} 秒用不了（没对齐或被排除）`);
      cuts.push({ at: r3(at), src: s.id, offset: off, pinned: true });
      recent.push(s.id);
      while (i < grid.length && grid[i] < pin.to - 0.01) i++;
      if (i < grid.length && Math.abs(grid[i] - pin.to) > 0.05) grid.splice(i, 0, pin.to);
      continue;
    }
    const n = per(at);
    let end = Math.min(grid[i + n] ?? to, to);
    const nextPin = pins.find((p) => p.from > at + 0.01 && p.from < end);
    if (nextPin) end = nextPin.from;
    // 挑一个覆盖这一段、最近两段没用过、总共用得最少的片段（同样少的随机挑）
    const cover = srcs.map((s) => ({ s, off: usable(s, at, end) })).filter((x) => x.off != null);
    if (!cover.length) die(`${r3(at)}–${r3(end)} 秒没有片段能覆盖，检查对齐结果或缩短 audio 范围`);
    const fresh = cover.filter((x) => !recent.slice(-2).includes(x.s.id));
    const pool = fresh.length ? fresh : cover.filter((x) => x.s.id !== recent.at(-1)).length ? cover.filter((x) => x.s.id !== recent.at(-1)) : cover;
    const min = Math.min(...pool.map((x) => used.get(x.s.id) || 0));
    const cand = pool.filter((x) => (used.get(x.s.id) || 0) === min);
    const pick = cand[Math.floor(rand() * cand.length)];
    used.set(pick.s.id, (used.get(pick.s.id) || 0) + 1);
    cuts.push({ at: r3(at), src: pick.s.id, offset: pick.off });
    recent.push(pick.s.id);
    if (nextPin) { while (i < grid.length && grid[i] < nextPin.from - 0.01) i++; if (Math.abs((grid[i] ?? Infinity) - nextPin.from) > 0.05) grid.splice(i, 0, nextPin.from); }
    else i += n;
  }
  return { cuts, beats: { bpm: bt.bpm, period: bt.period, first: bt.first } };
}

// 对比图：同一个主音轨时间，各片段的画面排在一起，看动作是不是同一拍（对齐对不对）、人在画面哪里（调 x / zoom）
function compare(spec, dir, times, out) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'montage-cmp-'));
  const srcs = spec.sources.filter((s) => s.offset != null && s.use !== false);
  const files = [];
  for (const [ti, t] of times.entries()) {
    for (const [si, s] of srcs.entries()) {
      const f = path.join(tmp, `${String(ti).padStart(3, '0')}-${String(si).padStart(3, '0')}.jpg`);
      const off = usable(s, t, t + 0.04);
      const vf = `scale=360:202:force_original_aspect_ratio=decrease,pad=360:202:(ow-iw)/2:(oh-ih)/2,drawtext=fontfile='${FONT}':text='${esc(`${t}s ${s.id}`)}':x=6:y=6:fontsize=18:fontcolor=yellow:shadowcolor=black:shadowx=1:shadowy=1`;
      const r = off == null ? { status: 1 } : spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t + off), '-i', path.resolve(dir, s.file), '-frames:v', '1', '-vf', vf, f]);
      if (r.status !== 0) spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x222222:s=360x202', '-frames:v', '1', '-vf', `drawtext=fontfile='${FONT}':text='${esc(`${t}s ${s.id} 用不了`)}':x=6:y=6:fontsize=18:fontcolor=gray`, f]);
      files.push(f);
    }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-pattern_type', 'glob', '-i', path.join(tmp, '*.jpg'), '-vf', `tile=${srcs.length}x${times.length}`, '-frames:v', '1', out]);
  fs.rmSync(tmp, { recursive: true, force: true });
  return { out, rows: times.map((t) => `${t}s`), cols: srcs.map((s) => s.id) };
}

// ---------- 渲染 ----------
function esc(t) { return String(t).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%'); }

function render(spec, dir, out) {
  const [W, H] = spec.size || [1920, 1080];
  const fps = spec.fps || 30;
  const master = path.resolve(dir, spec.audio.file);
  const from = spec.audio.start ?? 0, to = spec.audio.end ?? duration(master);
  const srcs = new Map(spec.sources.map((s) => [s.id, s]));
  const cuts = [...spec.cuts].sort((a, b) => a.at - b.at);
  if (!cuts.length || cuts[0].at > from + 0.001) die('cuts 要从 audio.start 开始');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'montage-'));
  const total = Math.round((to - from) * fps);
  const list = [];
  const table = [];
  for (let k = 0; k < cuts.length; k++) {
    const c = cuts[k];
    const s = srcs.get(c.src) || die(`切点 ${c.at} 用了不存在的片段 ${c.src}`);
    // 用帧号算起止，避免累计误差
    const f0 = Math.round((c.at - from) * fps);
    const f1 = k + 1 < cuts.length ? Math.round((cuts[k + 1].at - from) * fps) : total;
    if (f1 <= f0) continue;
    const st = from + f0 / fps + (c.offset ?? s.offset) + (c.nudge || 0);
    const zoom = c.zoom ?? s.zoom ?? 1;
    const cx = c.x ?? s.x ?? 0.5, cy = c.y ?? s.y ?? 0.5;
    // 先等比铺满画面，再按 zoom 放大，以 (x, y) 为中心裁出 W×H
    const vf = [
      `scale=${Math.round(W * zoom)}:${Math.round(H * zoom)}:force_original_aspect_ratio=increase:flags=lanczos`,
      `crop=${W}:${H}:'max(0,min(iw-${W},iw*${cx}-${W / 2}))':'max(0,min(ih-${H},ih*${cy}-${H / 2}))'`,
      `fps=${fps}`, 'setsar=1', 'format=yuv420p',
    ];
    if (spec.grade?.[s.id] || s.grade) vf.push(spec.grade?.[s.id] || s.grade);
    const label = c.label ?? s.label;
    if (spec.labels !== false && label && FONT) {
      vf.push(`drawtext=fontfile='${FONT}':text='${esc(label)}':x=${Math.round(W * 0.03)}:y=h-${Math.round(H * 0.075)}-th:fontsize=${Math.round(H * 0.03)}:fontcolor=white@0.92:shadowcolor=black@0.6:shadowx=2:shadowy=2`);
    }
    const seg = path.join(tmp, `${String(k).padStart(4, '0')}.mp4`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, st)), '-i', path.resolve(dir, s.file), '-frames:v', String(f1 - f0), '-an', '-vf', vf.join(','), '-c:v', 'libx264', '-preset', 'fast', '-crf', '16', '-r', String(fps), seg]);
    if (r.status !== 0) die(`切点 ${c.at}（${c.src}）渲染失败：${r.stderr}`);
    list.push(`file '${seg}'`);
    table.push({ at: r3(c.at), out: r3(f0 / fps), dur: r3((f1 - f0) / fps), src: c.src, srcTime: r3(st), label: label || '' });
  }
  fs.writeFileSync(path.join(tmp, 'list.txt'), list.join('\n'));
  const joined = path.join(tmp, 'joined.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-c', 'copy', joined]);

  // 片头片尾字、整体标题
  const overlays = [];
  for (const t of spec.texts || []) {
    if (!FONT) break;
    const size = Math.round(H * (t.size || 0.06));
    const y = t.y != null ? `${Math.round(H * t.y)}` : '(h-th)/2';
    const a = r3(t.from - from), b = r3(t.to - from), fade = t.fade ?? 0.3;
    const alpha = `if(lt(t,${a}),0,if(lt(t,${a + fade}),(t-${a})/${fade},if(lt(t,${b - fade}),1,if(lt(t,${b}),(${b}-t)/${fade},0))))`;
    overlays.push(`drawtext=fontfile='${FONT}':text='${esc(t.text)}':x=(w-tw)/2:y=${y}:fontsize=${size}:fontcolor=${t.color || 'white'}:alpha='${alpha}':shadowcolor=black@0.55:shadowx=3:shadowy=3:borderw=${t.border ?? 0}:bordercolor=black@0.5`);
  }
  // 开头结尾压暗淡入淡出
  const fadeIn = spec.audio.fadeIn ?? 0.4, fadeOut = spec.audio.fadeOut ?? 1.2, len = (to - from);
  overlays.push(`fade=t=in:st=0:d=${fadeIn}`, `fade=t=out:st=${r3(len - fadeOut)}:d=${fadeOut}`);
  const af = [`afade=t=in:st=0:d=${Math.min(fadeIn, 0.3)}`, `afade=t=out:st=${r3(len - fadeOut)}:d=${fadeOut}`, 'loudnorm=I=-14:TP=-1.5:LRA=11'];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', joined, '-ss', String(from), '-t', String(len), '-i', master,
    '-map', '0:v:0', '-map', '1:a:0', '-vf', overlays.join(','), '-af', af.join(','),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', '-shortest', out]);
  fs.rmSync(tmp, { recursive: true, force: true });

  const base = out.replace(/\.mp4$/, '');
  fs.writeFileSync(`${base}-cuts.json`, JSON.stringify(table, null, 1));
  // 缩略图拼图：每个切点后 0.3 秒一张
  const sheetDir = path.join(dir, 'snapshots');
  fs.mkdirSync(sheetDir, { recursive: true });
  const pts = table.filter((_, i) => i % Math.max(1, Math.ceil(table.length / 40)) === 0).map((x) => x.out + Math.min(0.3, x.dur / 2));
  const sel = pts.map((t) => `between(t,${r3(t)},${r3(t + 1 / fps)})`).join('+');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-vf', `select='${sel}',scale=384:-2,tile=8x${Math.ceil(pts.length / 8)}`, '-frames:v', '1', '-vsync', 'vfr', path.join(sheetDir, 'contact-sheet.jpg')]);
  return { out, duration: r3(len), cuts: table.length, perSource: Object.fromEntries([...srcs.keys()].map((id) => [id, table.filter((x) => x.src === id).length])) };
}

// ---------- 入口 ----------
const o = args(process.argv.slice(2));
const cmd = o._.shift();
if (cmd === 'align') {
  if (!o.master || !o._.length) die('用法：montage.mjs align --master <音轨来源> <片段...>');
  console.log(JSON.stringify(align(o.master, o._, { maxShift: Number(o['max-shift']) || 120, debug: !!o.debug }), null, 1));
} else if (cmd === 'beats') {
  if (!o.master) die('用法：montage.mjs beats --master <音轨来源> [--from 秒] [--to 秒]');
  const b = beats(o.master, { from: Number(o.from) || 0, to: o.to ? Number(o.to) : Infinity });
  console.log(JSON.stringify({ ...b, beats: o.all ? b.beats : `${b.beats.length} 拍（加 --all 全部列出）` }, null, 1));
} else if (cmd === 'compare') {
  if (!o.spec || !o.at) die('用法：montage.mjs compare --spec montage.json --at 30,60,90 [--out review/compare.jpg]');
  const file = path.resolve(o.spec); const dir = path.dirname(file);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of spec.sources) s.duration ??= duration(path.resolve(dir, s.file));
  console.log(JSON.stringify(compare(spec, dir, String(o.at).split(',').map(Number), path.resolve(dir, o.out || 'review/compare.jpg'))));
} else if (cmd === 'plan' || cmd === 'render') {
  if (!o.spec) die(`用法：montage.mjs ${cmd} --spec montage.json`);
  const file = path.resolve(o.spec);
  const dir = path.dirname(file);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of spec.sources) s.duration ??= duration(path.resolve(dir, s.file));
  if (cmd === 'plan' || !spec.cuts?.length) {
    const p = plan(spec, dir);
    spec.cuts = p.cuts;
    spec.beatsInfo = p.beats;
    fs.writeFileSync(file, JSON.stringify(spec, null, 1));
    console.log(`排好 ${p.cuts.length} 个切点（${p.beats.bpm} BPM），写回 ${o.spec}`);
    if (cmd === 'plan') process.exit(0);
  }
  console.log(JSON.stringify(render(spec, dir, path.resolve(dir, o.out || 'renders/video.mp4')), null, 1));
} else {
  die('用法：montage.mjs align|beats|plan|render（见文件开头说明）');
}
