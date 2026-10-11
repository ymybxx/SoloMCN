#!/usr/bin/env node
// 原片剪辑：把同一首歌的多个舞台（直拍、不同场次、不同造型）对齐到同一条音轨上，按拍子切换，做成「一键换装」或多舞台混剪。
// 不用 HyperFrames 渲染：几十上百个切点直接用 ffmpeg 逐段截取、拼接，画面帧精确，几分钟就能出片。
//
//   node montage.mjs align  --master <音轨来源.mp4> <片段1.mp4> <片段2.mp4> ...   各片段相对主音轨的时间差，带可信度
//   node montage.mjs beats  --master <音轨来源.mp4> [--from 秒] [--to 秒]              主音轨的 BPM 和每一拍的时间
//   node montage.mjs skips  --master <音轨来源> --within 90,150                     找能无缝砍掉的整数个八拍（成片超时长时用，写进 audio.skip）
//   node montage.mjs track  --spec montage.json                                         认主角：每条片段里主角在哪、哪些时段拍到别人或太小（写进 autoExclude，配合 reframe 自动居中放大）
//   node montage.mjs audit  --spec montage.json [--fix [--only 5.4,22.5] --out x.json] 成片体检：哪几刀画面不是主角（会有误报，先看图）；--fix 只把这几刀（或 --only 指定的成片时间）换成同一时刻认得出主角的另一场
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
  if ([...(s.exclude || []), ...(s.autoExclude || [])].some(([x, y]) => a < y && b > x)) return null;
  const segs = s.segments?.length ? s.segments : [{ from: -Infinity, to: Infinity, offset: s.offset }];
  const seg = segs.find((g) => a >= g.from - 0.01 && b <= g.to + 0.01);
  if (!seg) return null;
  return a + seg.offset >= 0.05 && b + seg.offset <= (s.duration ?? Infinity) - 0.05 ? seg.offset : null;
}

// 主音轨实际用到的几段：[start, end] 去掉 audio.skip 里砍掉的部分。out 是这一段在成片里的起点
function pieces(spec, from, to) {
  const skips = (spec.audio.skip || []).map(([a, b]) => [Math.max(from, a), Math.min(to, b)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const list = [];
  let t = from, o = 0;
  for (const [a, b] of skips) {
    if (a > t) { list.push({ from: t, to: a, out: o }); o += a - t; }
    t = Math.max(t, b);
  }
  if (to > t) list.push({ from: t, to, out: o });
  return list;
}
// 主音轨时间 -> 成片时间（落在砍掉的部分里，就算到下一段开头）
function toOut(P, t) {
  for (const p of P) if (t >= p.from - 1e-6 && t <= p.to + 1e-6) return p.out + (t - p.from);
  const n = P.find((p) => p.from >= t);
  return n ? n.out : P.at(-1).out + P.at(-1).to - P.at(-1).from;
}

// 找能无缝砍掉的一段：砍点前后的声音接得上（砍掉的是整数个八拍，后面那段和被砍掉的开头听起来一样，比如重复的副歌、间奏）
function findSkips(master, { within = [0, Infinity], min = 5, max = 30, top = 6, step = 8 } = {}) {
  const bt = beats(master);
  const bands = [envelope(master), envelope(master, 'highpass=f=250,lowpass=f=4000')];
  const W = Math.round(3 * ENV_HZ);
  const corr = (e, a, b) => {
    if (a < 0 || b < 0 || a + W > e.length || b + W > e.length) return -1;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < W; i++) { sab += e[a + i] * e[b + i]; saa += e[a + i] ** 2; sbb += e[b + i] ** 2; }
    return sab / Math.sqrt(saa * sbb || 1);
  };
  const B = bt.beats.filter((t) => t >= within[0] && t <= within[1]);
  const out = [];
  for (let i = 0; i < B.length; i++) {
    for (let j = i + step; j < B.length; j += step) {
      const len = B[j] - B[i];
      if (len < min) continue;
      if (len > max) break;
      const ti = Math.round(B[i] * ENV_HZ), tj = Math.round(B[j] * ENV_HZ);
      // 砍点之后：tj 往后听起来要像 ti 往后；砍点之前：tj 往前要像 ti 往前（两边都接得上才自然）
      const score = bands.reduce((s, e) => s + corr(e, ti, tj) + corr(e, ti - W, tj - W), 0) / (bands.length * 2);
      out.push({ from: B[i], to: B[j], length: r3(len), beats: j - i, score: Math.round(score * 1000) / 1000 });
    }
  }
  // 去掉互相重叠的，留分高的
  const picked = [];
  for (const c of out.sort((a, b) => b.score - a.score)) {
    if (picked.some((p) => c.from < p.to && c.to > p.from)) continue;
    picked.push(c);
    if (picked.length >= top) break;
  }
  return { bpm: bt.bpm, candidates: picked };
}

function plan(spec, dir) {
  const master = path.resolve(dir, spec.audio.file);
  const from = spec.audio.start ?? 0, to = spec.audio.end ?? duration(master);
  const auto = spec.auto || {};
  // 节拍按整首算（短片段算 BPM 容易落到 3/4、1/2 倍的假峰上），再取用到的这一段
  const bt = spec.beats || beats(master);
  const P = pieces(spec, from, to);
  const inPiece = (t) => P.find((p) => t >= p.from - 0.01 && t < p.to - 0.01);
  // 拍点只取留下来的部分；每段开头（砍点之后）强制切一刀，换一套造型接上
  const grid = [...new Set([...bt.beats.filter((t) => inPiece(t)), ...P.map((p) => p.from)].map(r3))].sort((a, b) => a - b);
  const srcs = spec.sources.filter((s) => s.offset != null && s.use !== false);
  if (srcs.length < 2) die('能用的片段少于 2 个（先 align 填好 offset）');
  const pins = [...(spec.pins || [])].sort((x, y) => x.from - y.from); // 指定某段用某个片段（名场面、定格）
  const per = (t) => (auto.sections || []).find((x) => t >= x.from && t < x.to)?.beatsPerCut ?? auto.beatsPerCut ?? 4;
  const rand = rng(auto.seed || 1);
  // 挑场次时顺带看画面：主角在这一刀里清不清楚、在不在中间（人体检测的结果缓存在 track/，第一次要几分钟）。
  // 只当偏好，不排除素材、不放大；"preferClear": false 关掉
  const clear = spec.preferClear === false ? null : (scanPeople(spec, dir), (s, off, a, b) => {
    const h = cutHealth(dir, s.id, a + off, b + off);
    return h ? h.ok / h.n - h.frame : null;
  });
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
    const piece = inPiece(at) || P.at(-1);
    let end = Math.min(grid[i + n] ?? to, to, piece.to);
    const stopAt = grid.findIndex((t) => t > at + 0.01 && t >= end - 0.01);
    const nextPin = pins.find((p) => p.from > at + 0.01 && p.from < end);
    if (nextPin) end = nextPin.from;
    // 挑一个覆盖这一段、最近两段没用过的片段：出场次数不能比最少的多出 1 次以上（8 套造型轮得匀），
    // 在这里面挑主角最清楚、最居中的；差不多清楚的，挑用得少的，再一样就随机
    const cover = srcs.map((s) => ({ s, off: usable(s, at, end) })).filter((x) => x.off != null);
    if (!cover.length) die(`${r3(at)}–${r3(end)} 秒没有片段能覆盖，检查对齐结果或缩短 audio 范围`);
    const fresh = cover.filter((x) => !recent.slice(-2).includes(x.s.id));
    const pool = fresh.length ? fresh : cover.filter((x) => x.s.id !== recent.at(-1)).length ? cover.filter((x) => x.s.id !== recent.at(-1)) : cover;
    const min = Math.min(...pool.map((x) => used.get(x.s.id) || 0));
    let cand = pool.filter((x) => (used.get(x.s.id) || 0) <= min + (clear ? 1 : 0));
    if (clear) {
      for (const x of cand) x.q = clear(x.s, x.off, at, end) ?? 0;
      const best = Math.max(...cand.map((x) => x.q));
      cand = cand.filter((x) => x.q >= best - 0.1);
      const fewest = Math.min(...cand.map((x) => used.get(x.s.id) || 0));
      cand = cand.filter((x) => (used.get(x.s.id) || 0) === fewest);
    }
    const pick = cand[Math.floor(rand() * cand.length)];
    used.set(pick.s.id, (used.get(pick.s.id) || 0) + 1);
    cuts.push({ at: r3(at), src: pick.s.id, offset: pick.off });
    recent.push(pick.s.id);
    if (nextPin) { while (i < grid.length && grid[i] < nextPin.from - 0.01) i++; if (Math.abs((grid[i] ?? Infinity) - nextPin.from) > 0.05) grid.splice(i, 0, nextPin.from); }
    else i = stopAt === -1 ? grid.length : stopAt;
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

// ---------- 认主角：每条片段里主角在哪、是不是他、能不能用 ----------
// 用 persons.swift（macOS Vision 人体检测）每 0.5 秒取一帧找人；不做人脸识别：
// 直拍的镜头跟着主角走，主角又一直是同一个造型，所以用「整个人的外观（发色、衣服）」+「离画面中心多近」+「前后帧连贯」认人。
const SWIFT = path.join(path.dirname(new URL(import.meta.url).pathname), 'persons.swift');
function personsBin() {
  const st = fs.statSync(SWIFT);
  const bin = path.join(os.tmpdir(), `montage-persons-${Math.round(st.mtimeMs)}`);
  if (!fs.existsSync(bin)) {
    const r = spawnSync('swiftc', ['-O', SWIFT, '-o', bin], { encoding: 'utf8' });
    if (r.status !== 0) die(`编译 persons.swift 失败（要装 Xcode 命令行工具）：${r.stderr}`);
  }
  return bin;
}

const cosd = (a, b) => { if (!a?.length || !b?.length) return 1; let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return 1 - s / Math.sqrt(na * nb || 1); };
const hd = (a, b) => (a?.length && b?.length ? a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / 2 : 0.5); // 颜色分布差多少，0–1
const meanVec = (list) => { const out = new Array(list[0].length).fill(0); for (const v of list) for (let i = 0; i < v.length; i++) out[i] += v[i] / list.length; return out; };

function trackSource(file, step = 0.5) {
  const r = spawnSync(personsBin(), [file, String(step)], { maxBuffer: 1 << 30, encoding: 'utf8' });
  if (r.status !== 0) die(`人体检测失败：${file}\n${r.stderr}`);
  const { samples } = JSON.parse(r.stdout);
  const center = (p) => Math.abs(p.x + p.w / 2 - 0.5);
  const ppl = samples.map((s) => s.people.filter((p) => p.fp?.length && p.h > 0.2));
  // 主角样本：又大又在正中间的人（直拍的镜头跟着主角走），先用它们算出主角的外观
  const seeds = ppl.map((ps) => ps.filter((p) => p.h > 0.5 && center(p) < 0.12).sort((a, b) => b.h - a.h)[0]).filter(Boolean);
  if (seeds.length < 5) return { samples: samples.map((s) => ({ t: s.t, ok: false, why: '找不到主角' })) };
  let model = meanVec(seeds.map((p) => p.fp));
  // 发色：队友常穿同款演出服，分得开的往往只有头发
  let hair = meanVec(seeds.filter((p) => p.hair?.length).map((p) => p.hair));
  let path_ = [];
  for (let round = 0; round < 3; round++) {
    // 维特比：每一帧在「画面里的每个人」和「主角不在画面里」之间选，整段连起来代价最小
    // 代价 = 外观不像（主） + 离中心远 + 和上一帧位置跳得远
    const NONE = { none: true };
    const states = ppl.map((ps) => [...ps, NONE]);
    // 发色只在选出来以后复核（头发区域本身差异就大，放进代价里会让「主角不在画面里」总是更便宜）
    const emit = (p) => (p.none ? 0.32 : cosd(p.fp, model) * 2.2 + center(p) * 0.5 + Math.max(0, 0.5 - p.h) * 0.4);
    const trans = (a, b) => (a.none || b.none ? 0.15 : Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) * 1.2 + Math.abs(a.h - b.h) * 0.5);
    let cost = states[0].map(emit), back = [];
    for (let i = 1; i < states.length; i++) {
      const nc = [], nb = [];
      for (const b of states[i]) {
        let best = Infinity, arg = 0;
        states[i - 1].forEach((a, k) => { const c = cost[k] + trans(a, b); if (c < best) { best = c; arg = k; } });
        nc.push(best + emit(b)); nb.push(arg);
      }
      cost = nc; back.push(nb);
    }
    let k = cost.indexOf(Math.min(...cost));
    path_ = new Array(states.length);
    for (let i = states.length - 1; i >= 0; i--) { path_[i] = states[i][k]; if (i > 0) k = back[i - 1][k]; }
    const chosen = path_.filter((p) => !p.none && cosd(p.fp, model) < 0.25);
    if (chosen.length >= 5) { model = meanVec(chosen.map((p) => p.fp)); const hs = chosen.filter((p) => p.hair?.length); if (hs.length >= 5) hair = meanVec(hs.map((p) => p.hair)); }
  }
  const ds = path_.filter((p) => !p.none).map((p) => cosd(p.fp, model)).sort((a, b) => a - b);
  const limit = Math.min(0.35, Math.max(0.15, (ds[Math.floor(ds.length * 0.8)] ?? 0.2) * 1.4));
  const hs = path_.filter((p) => !p.none && p.hair?.length).map((p) => hd(p.hair, hair)).sort((a, b) => a - b);
  const hairLimit = Math.min(0.6, Math.max(0.3, (hs[Math.floor(hs.length * 0.8)] ?? 0.4) * 1.3));
  return {
    samples: samples.map((s, i) => {
      const p = path_[i];
      if (!p || p.none) return { t: s.t, ok: false, why: '画面里找不到主角' };
      const d = cosd(p.fp, model);
      const base = { t: s.t, cx: r3(p.x + p.w / 2), cy: r3(p.y + p.h / 2), h: r3(p.h), w: r3(p.w), d: r3(d) };
      if (d > limit) return { ...base, ok: false, why: '不像主角，可能拍到别人了' };
      if (p.hair?.length && hd(p.hair, hair) > hairLimit) return { ...base, ok: false, why: '发色对不上，可能是穿同款衣服的队友' };
      if (p.h < 0.35) return { ...base, ok: false, why: '主角太小' };
      // 画面里另一个人比他更大、更居中：镜头可能在拍别人
      const rival = ppl[i].find((q) => q !== p && q.h > p.h * 1.15 && center(q) < center(p) - 0.1);
      if (rival) return { ...base, ok: false, why: '画面焦点在别人身上' };
      return { ...base, ok: true };
    }),
  };
}

// 只做人体检测、缓存到 track/<id>.json，不改 spec（排切点挑场次、体检都用它）
function scanPeople(spec, dir, { step = 0.5 } = {}) {
  fs.mkdirSync(path.join(dir, 'track'), { recursive: true });
  for (const s of spec.sources) {
    if (s.offset == null || s.use === false) continue;
    const file = path.join(dir, 'track', `${s.id}.json`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(trackSource(path.resolve(dir, s.file), step)));
  }
}

// 对每条片段跑一遍，结果存到 track/<id>.json；把连续的坏帧变成 autoExclude（主音轨时间）
function track(spec, dir, { step = 0.5 } = {}) {
  fs.mkdirSync(path.join(dir, 'track'), { recursive: true });
  const report = [];
  for (const s of spec.sources) {
    if (s.offset == null || s.use === false) continue;
    const file = path.join(dir, 'track', `${s.id}.json`);
    const t = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : trackSource(path.resolve(dir, s.file), step);
    fs.writeFileSync(file, JSON.stringify(t));
    // 片段时间 -> 主音轨时间：用 segments 的时间差
    const segs = s.segments?.length ? s.segments : [{ from: -Infinity, to: Infinity, offset: s.offset }];
    const toMaster = (ct) => { const g = segs.find((x) => ct - x.offset >= x.from - 0.01 && ct - x.offset <= x.to + 0.01); return g ? ct - g.offset : null; };
    const bad = [];
    for (const x of t.samples) {
      if (x.ok) continue;
      const m = toMaster(x.t);
      if (m == null) continue;
      const last = bad.at(-1);
      if (last && m - last[1] <= step * 1.5 + 0.01) last[1] = r3(m + step / 2);
      else bad.push([r3(m - step / 2), r3(m + step / 2)]);
    }
    s.autoExclude = bad;
    const okRate = t.samples.filter((x) => x.ok).length / Math.max(1, t.samples.length);
    const whys = {};
    for (const x of t.samples) if (!x.ok) whys[x.why] = (whys[x.why] || 0) + 1;
    report.push({ id: s.id, usable: `${Math.round(okRate * 100)}%`, excluded: bad.length, whys });
  }
  return report;
}

// 某个片段在片段时间 ct 附近主角的位置（取前后 1 秒里能用的样本的中位数）
function targetAt(dir, s, ct) {
  const file = path.join(dir, 'track', `${s.id}.json`);
  if (!fs.existsSync(file)) return null;
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  const near = t.samples.filter((x) => x.ok && Math.abs(x.t - ct) <= 1);
  if (!near.length) return null;
  const med = (k) => near.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(near.length / 2)];
  return { cx: med('cx'), cy: med('cy'), h: med('h') };
}

// ---------- 体检：已经渲染好的成片里，哪几刀画面不是主角 ----------
// 不改剪辑，只对照 track 的结果逐刀查；--fix 时只把有问题的那几刀换成同一时刻认得出主角的另一场，其余原样
const STRONG = new Set(['不像主角，可能拍到别人了', '发色对不上，可能是穿同款衣服的队友', '画面焦点在别人身上', '主角太小']);
function cutHealth(dir, src, t0, t1) {
  const file = path.join(dir, 'track', `${src}.json`);
  if (!fs.existsSync(file)) return null;
  const all = JSON.parse(fs.readFileSync(file, 'utf8')).samples;
  let xs = all.filter((x) => x.t >= t0 - 0.05 && x.t <= t1 + 0.05);
  if (!xs.length) xs = all.filter((x) => Math.abs(x.t - (t0 + t1) / 2) <= 0.5);
  if (!xs.length) return null;
  const strong = xs.filter((x) => !x.ok && STRONG.has(x.why)).length;
  const bad = xs.filter((x) => !x.ok).length;
  // 构图：主角全身入画、站在中间最好；顶天立地的近景（头脚都出框）和偏到一边的扣分
  const okx = xs.filter((x) => x.ok);
  const frame = okx.length ? okx.reduce((a, x) => a + (x.h > 0.95 ? 0.3 : 0) + Math.abs(x.cx - 0.5), 0) / okx.length : 0.5;
  return { n: xs.length, ok: xs.length - bad, strong, frame, why: [...new Set(xs.filter((x) => !x.ok).map((x) => x.why))] };
}

function audit(spec, dir, table, { fix = false, only = null } = {}) {
  const srcs = spec.sources.filter((s) => s.offset != null && s.use !== false);
  const flagged = [];
  for (const [i, c] of table.entries()) {
    const h = cutHealth(dir, c.src, c.srcTime, c.srcTime + c.dur);
    if (!h) continue;
    // 一半以上的取样明确是别人 / 太小，或者整刀都认不出主角
    if (h.strong * 2 >= h.n || h.ok === 0) flagged.push({ i, out: c.out, dur: c.dur, at: c.at, src: c.src, label: c.label, why: h.why });
  }
  if (!fix) return { flagged };
  // only：人看过之后指定要换的几刀（成片时间，秒）；体检会有误报，也会漏掉被路人挡住的镜头
  const todo = only ? table.map((c, i) => ({ c, i })).filter(({ c }) => only.some((t) => Math.abs(t - c.out) < 0.06 || (t > c.out && t < c.out + c.dur))).map(({ c, i }) => ({ i, out: c.out, dur: c.dur, at: c.at, src: c.src, label: c.label, why: ['人工指定'] })) : flagged;
  const cuts = [...spec.cuts].sort((a, b) => a.at - b.at);
  const used = new Map();
  for (const c of table) used.set(c.src, (used.get(c.src) || 0) + 1);
  const changes = [];
  const cur = table.map((c) => c.src); // 边换边更新，前后刀按换过之后的算，免得相邻两刀换成同一场
  // 候选少的刀先挑，免得相邻两刀抢同一个替补
  const options = (f) => srcs.filter((s) => s.id !== f.src && (() => { const off = usable(s, f.at, f.at + f.dur); if (off == null) return false; const h = cutHealth(dir, s.id, f.at + off, f.at + f.dur + off); return h && h.ok / h.n >= 0.6; })()).length;
  todo.sort((a, b) => options(a) - options(b));
  for (const f of todo) {
    // 成片里的这一刀对应 spec 里哪个切点（同一切点被砍点分成两刀时一起换）
    // 切点表里的时间按帧取过整，和 spec 里的切点差零点零几秒：取最近的、且不晚于这一刀结束的那个
    const k = cuts.reduce((best, c, j) => (c.at < f.at + f.dur - 0.05 && (best < 0 || Math.abs(c.at - f.at) < Math.abs(cuts[best].at - f.at)) ? j : best), -1);
    if (k < 0) continue;
    const prev = cur[f.i - 1], next = cur[f.i + 1];
    const cand = srcs.filter((s) => s.id !== f.src && s.id !== prev && s.id !== next).map((s) => {
      const off = usable(s, f.at, f.at + f.dur);
      if (off == null) return null;
      const h = cutHealth(dir, s.id, f.at + off, f.at + f.dur + off);
      if (!h || h.ok / h.n < 0.6) return null;
      return { s, off, score: h.ok / h.n - h.frame - (used.get(s.id) || 0) * 0.01 };
    }).filter(Boolean).sort((a, b) => b.score - a.score);
    if (!cand.length) { changes.push({ out: f.out, from: f.src, to: null, note: '没有能换的场次，原样保留' }); continue; }
    const pick = cand[0];
    changes.push({ out: f.out, from: f.src, to: pick.s.id });
    cur[f.i] = pick.s.id;
    used.set(pick.s.id, (used.get(pick.s.id) || 0) + 1);
    cuts[k] = { ...cuts[k], src: pick.s.id, offset: pick.off, fixed: true };
  }
  return { flagged, changes, cuts };
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
  const P = pieces(spec, from, to);
  const len = P.reduce((a, p) => a + p.to - p.from, 0);
  const total = Math.round(len * fps);
  // 切点换算到成片时间轴：每一段主音轨里生效的切点（段开头接着用上一个切点的片段）
  const segs = [];
  for (const p of P) {
    const active = [...cuts].reverse().find((c) => c.at <= p.from + 0.001);
    const inside = cuts.filter((c) => c.at > p.from + 0.001 && c.at < p.to - 0.001);
    for (const c of [active, ...inside].filter(Boolean)) segs.push({ c, piece: p, out: p.out + Math.max(0, c.at - p.from) });
  }
  const list = [];
  const table = [];
  for (let k = 0; k < segs.length; k++) {
    const { c, piece } = segs[k];
    const s = srcs.get(c.src) || die(`切点 ${c.at} 用了不存在的片段 ${c.src}`);
    // 用帧号算起止，避免累计误差
    const f0 = Math.round(segs[k].out * fps);
    const f1 = k + 1 < segs.length ? Math.round(segs[k + 1].out * fps) : total;
    if (f1 <= f0) continue;
    const st = piece.from + (f0 / fps - piece.out) + (c.offset ?? s.offset) + (c.nudge || 0);
    // reframe：按这一镜中间那一刻主角的位置，放大到主角占画面 reframe 高度并居中（换装时主角的位置、大小前后接得上）
    let auto = null;
    if (spec.reframe && c.zoom == null && c.x == null) {
      const tg = targetAt(dir, s, st + (f1 - f0) / fps / 2);
      if (tg) {
        const want = typeof spec.reframe === 'number' ? spec.reframe : 0.82;
        const z = Math.max(1, Math.min(spec.maxZoom || 1.3, want / Math.max(tg.h, 0.1)));
        auto = { zoom: r3(z), x: tg.cx, y: Math.min(tg.cy, 0.5) };
      }
    }
    const zoom = c.zoom ?? auto?.zoom ?? s.zoom ?? 1;
    const cx = c.x ?? auto?.x ?? s.x ?? 0.5, cy = c.y ?? auto?.y ?? s.y ?? 0.5;
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
    table.push({ at: r3(piece.from + (f0 / fps - piece.out)), out: r3(f0 / fps), dur: r3((f1 - f0) / fps), src: c.src, srcTime: r3(st), label: label || '' });
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
    const a = r3(toOut(P, t.from)), b = r3(toOut(P, t.to)), fade = t.fade ?? 0.3;
    const alpha = `if(lt(t,${a}),0,if(lt(t,${a + fade}),(t-${a})/${fade},if(lt(t,${b - fade}),1,if(lt(t,${b}),(${b}-t)/${fade},0))))`;
    overlays.push(`drawtext=fontfile='${FONT}':text='${esc(t.text)}':x=(w-tw)/2:y=${y}:fontsize=${size}:fontcolor=${t.color || 'white'}:alpha='${alpha}':shadowcolor=black@0.55:shadowx=3:shadowy=3:borderw=${t.border ?? 0}:bordercolor=black@0.5`);
  }
  // 开头结尾压暗淡入淡出
  const fadeIn = spec.audio.fadeIn ?? 0.4, fadeOut = spec.audio.fadeOut ?? 1.2;
  overlays.push(`fade=t=in:st=0:d=${fadeIn}`, `fade=t=out:st=${r3(len - fadeOut)}:d=${fadeOut}`);
  // 主音轨按段截取再接起来，接缝处各淡 15 毫秒，免得爆音
  const X = 0.015;
  const parts = P.map((p, i) => `[1:a]atrim=start=${r3(p.from)}:end=${r3(p.to)},asetpts=PTS-STARTPTS${P.length > 1 ? `,afade=t=in:st=0:d=${X},afade=t=out:st=${r3(p.to - p.from - X)}:d=${X}` : ''}[p${i}]`);
  const fc = [...parts, `${P.map((_, i) => `[p${i}]`).join('')}concat=n=${P.length}:v=0:a=1,afade=t=in:st=0:d=${Math.min(fadeIn, 0.3)},afade=t=out:st=${r3(len - fadeOut)}:d=${fadeOut},loudnorm=I=-14:TP=-1.5:LRA=11[a]`, `[0:v]${overlays.join(',')}[v]`].join(';');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', joined, '-i', master,
    '-filter_complex', fc, '-map', '[v]', '-map', '[a]',
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
} else if (cmd === 'track') {
  if (!o.spec) die('用法：montage.mjs track --spec montage.json [--step 0.5]');
  const file = path.resolve(o.spec); const dir = path.dirname(file);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of spec.sources) s.duration ??= duration(path.resolve(dir, s.file));
  const rep = track(spec, dir, { step: Number(o.step) || 0.5 });
  fs.writeFileSync(file, JSON.stringify(spec, null, 1));
  console.log(JSON.stringify(rep, null, 1));
} else if (cmd === 'audit') {
  if (!o.spec) die('用法：montage.mjs audit --spec montage.json [--cuts renders/video-cuts.json] [--fix --out montage-fixed.json]');
  const file = path.resolve(o.spec); const dir = path.dirname(file);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of spec.sources) s.duration ??= duration(path.resolve(dir, s.file));
  if (!spec.sources.every((s) => s.use === false || fs.existsSync(path.join(dir, 'track', `${s.id}.json`)))) track(spec, dir);
  const table = JSON.parse(fs.readFileSync(path.resolve(dir, o.cuts || 'renders/video-cuts.json'), 'utf8'));
  const r = audit(spec, dir, table, { fix: !!o.fix, only: o.only ? String(o.only).split(',').map(Number) : null });
  if (o.fix) {
    const outSpec = { ...spec, cuts: r.cuts };
    for (const s of outSpec.sources) delete s.autoExclude; // 只换问题刀，不改其余的选择
    fs.writeFileSync(path.resolve(dir, o.out || 'montage-fixed.json'), JSON.stringify(outSpec, null, 1));
  }
  console.log(JSON.stringify({ flagged: r.flagged.map((f) => ({ out: f.out, dur: f.dur, src: f.src, label: f.label, why: f.why })), changes: r.changes }, null, 1));
} else if (cmd === 'skips') {
  if (!o.master) die('用法：montage.mjs skips --master <音轨来源> [--within 90,150] [--min 5] [--max 30] [--step 8]');
  const w = o.within ? String(o.within).split(',').map(Number) : [0, Infinity];
  console.log(JSON.stringify(findSkips(o.master, { within: w, min: Number(o.min) || 5, max: Number(o.max) || 30, step: Number(o.step) || 8 }), null, 1));
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
