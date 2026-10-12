#!/usr/bin/env node
// 原片剪辑：把同一首歌的多个舞台（直拍、不同场次、不同造型）对齐到同一条音轨上，按拍子切换，做成「一键换装」或多舞台混剪。
// 不用 HyperFrames 渲染：几十上百个切点直接用 ffmpeg 逐段截取、拼接，画面帧精确，几分钟就能出片。
//
//   node montage.mjs align  --master <音轨来源.mp4> <片段1.mp4> <片段2.mp4> ...   各片段相对主音轨的时间差，带可信度
//   node montage.mjs beats  --master <音轨来源.mp4> [--from 秒] [--to 秒]              主音轨的 BPM 和每一拍的时间
//   node montage.mjs vet    --file <素材.mp4>                                          直拍体检：认得出、在中间、被挡、景别稳不稳、内部剪辑，给 0–100 分
//   node montage.mjs check  --spec montage.json --video renders/video.mp4              成片核对：每个切点前后他的位置、大小有没有跳，哪些时段他被挡住或认不出
//   node montage.mjs fx     --spec montage.json                                         按段落地图给每一刀挑换装转场（扫描、残影、光门、甩切、脉冲、叠化），写进 cuts[].fx
//   node montage.mjs sections --master <音轨来源>                                       段落地图：小节、乐句、每段能量（0 安静–3 高潮）、爆点
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

// ---------- 段落地图：小节、乐句、能量、爆点 ----------
// 换装落在小节第一拍（强拍）上，密度跟着段落能量走。小节按 4 拍、乐句按 4 小节算（舞蹈的「两个八拍」）。
function rms(file) {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const x = new Float32Array(out.stdout.buffer, out.stdout.byteOffset, out.stdout.length / 4);
  return (a, b) => { const i0 = Math.max(0, Math.floor(a * RATE)), i1 = Math.min(x.length, Math.floor(b * RATE)); let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return 10 * Math.log10(1e-9 + s / Math.max(1, i1 - i0)); };
}

function sections(master, { from = 0, to = Infinity } = {}) {
  const bt = beats(master);
  const env = envelope(master);
  const level = rms(master);
  const B = bt.beats;
  // 小节第一拍：4 种相位里，低频起音最强的那种
  let best = 0, bestS = -Infinity;
  for (let ph = 0; ph < 4; ph++) {
    let s = 0;
    for (let i = ph; i < B.length; i += 4) { const k = Math.round(B[i] * ENV_HZ); for (let d = -2; d <= 2; d++) s += Math.max(0, env[k + d] || 0); }
    if (s > bestS) { bestS = s; best = ph; }
  }
  const bars = [];
  for (let i = best; i + 4 < B.length + 1; i += 4) bars.push(B[i]);
  const end = Math.min(to, B.at(-1) + bt.period);
  // 每个乐句（4 小节）的响度，按全曲分位数分成 0–3 级
  const phrases = [];
  for (let i = 0; i < bars.length; i += 4) {
    const a = bars[i], b = bars[i + 4] ?? end;
    if (b <= from || a >= end) continue;
    phrases.push({ from: r3(Math.max(a, from)), to: r3(Math.min(b, end)), db: level(Math.max(a, from), Math.min(b, end)) });
  }
  const sorted = phrases.map((p) => p.db).sort((x, y) => x - y);
  const q = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
  const [q1, q2, q3] = [q(0.25), q(0.5), q(0.8)];
  for (const p of phrases) p.energy = p.db >= q3 ? 3 : p.db >= q2 ? 2 : p.db >= q1 ? 1 : 0;
  // 相邻同级的乐句合成段落；能量比上一句跳升 2 级以上的起点记为爆点
  const secs = [];
  for (const p of phrases) {
    const cur = secs.at(-1);
    if (cur && cur.energy === p.energy) cur.to = p.to;
    else secs.push({ from: p.from, to: p.to, energy: p.energy });
  }
  const drops = phrases.filter((p, i) => i > 0 && p.energy - phrases[i - 1].energy >= 2).map((p) => p.from);
  const names = ['安静', '平稳', '推进', '高潮'];
  return {
    bpm: bt.bpm, period: bt.period, firstDownbeat: bars[0], bars: bars.filter((t) => t >= from - 0.01 && t <= end),
    sections: secs.map((x) => ({ ...x, label: names[x.energy] })), drops,
    phrases: phrases.map(({ db, ...p }) => ({ ...p, db: Math.round(db * 10) / 10 })),
  };
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
  // 全局挑换装点（丝滑换装）：写了 schedule 就交给它
  if (spec.schedule) { const r = schedule(spec, dir); console.log('全局挑点：' + JSON.stringify({ cuts: r.cuts })); return { cuts: spec.cuts, beats: {}, structureMap: spec.structureMap }; }
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
  let per = (t) => (auto.sections || []).find((x) => t >= x.from && t < x.to)?.beatsPerCut ?? auto.beatsPerCut ?? 4;
  // 按段落地图排（"structure": true，或写成 {"pace": {"0": 8, "1": 8, "2": 8, "3": 4}, "dropBurst": 2}）：
  // 切点都落在小节第一拍，每段按能量定几拍换一次，爆点之后那一句加快
  if (spec.structure) {
    const st = typeof spec.structure === 'object' ? spec.structure : {};
    const pace = { 0: 8, 1: 8, 2: 8, 3: 4, ...(st.pace || {}) };
    const sm = sections(master, { from, to });
    spec.structureMap = { bpm: sm.bpm, sections: sm.sections, drops: sm.drops };
    const B = bt.beats, first = B.findIndex((t) => Math.abs(t - sm.firstDownbeat) < 0.02);
    const times = new Set([r3(from)]);
    for (const sec of sm.sections) {
      for (let i = Math.max(0, first); i < B.length && B[i] < sec.to - 0.01; i++) {
        if (B[i] < sec.from - 0.01 || (i - first) % 4) continue; // 只要小节第一拍
        const burst = sm.drops.some((d) => B[i] >= d - 0.01 && B[i] < d + 16 * bt.period - 0.01);
        const step = burst ? (st.dropBurst ?? 2) : pace[sec.energy] ?? 4;
        const k = (i - Math.max(0, first)) % Math.max(4, step); // 8 拍一换：只取偶数小节
        if (step >= 4 && k) continue;
        times.add(r3(B[i]));
        if (step < 4) for (let j = 1; j * step < 4 && B[i + j * step]; j++) times.add(r3(B[i + j * step]));
      }
    }
    const pieceStarts = P.map((pp) => r3(pp.from));
    grid.length = 0;
    grid.push(...[...times, ...pieceStarts].filter((t) => inPiece(t)).sort((a, b) => a - b).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.05));
    per = () => 1;
  }
  const rand = rng(auto.seed || 1);
  // 挑场次时顺带看画面：主角在这一刀里清不清楚、在不在中间（人体检测的结果缓存在 track/，第一次要几分钟）。
  // 只当偏好，不排除素材、不放大；"preferClear": false 关掉
  const clear = spec.preferClear === false ? null : (scanPeople(spec, dir), (s, off, a, b) => {
    const h = cutHealth(dir, s.id, a + off, b + off);
    return h ? h.ok / h.n - h.frame : null;
  });
  // 按动作挑：结构模式下默认开（"matchMotion": false 关掉）。新场次优先选和上一套动作最一致的，并挪到最一致的接点
  const motion = spec.structure && spec.matchMotion !== false ? posesOf(spec, dir) : null;
  // 统一大小：主角在各场里的身体大小（骨架算的，占画面高的比例）。全程锁定时只用能缩放到同一大小的镜头，
  // 目标大小选「能覆盖最多镜头」的那个，写进 lock.torso 给渲染用
  let sizeOk = null, edgeOk = null;
  if (motion && spec.lock?.mode === 'full') { const L = lockFns(spec, motion); sizeOk = L.sizeOk; edgeOk = L.edgeOk; spec.lock.torso = L.T; }
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
    let cover = srcs.map((s) => ({ s, off: usable(s, at, end) })).filter((x) => x.off != null);
    let fitted = false;
    if (sizeOk) { const fit = cover.filter((x) => sizeOk(x.s, x.off, at, end)); if (fit.length) { cover = fit; fitted = true; } }
    if (!cover.length) die(`${r3(at)}–${r3(end)} 秒没有片段能覆盖，检查对齐结果或缩短 audio 范围`);
    const fresh = cover.filter((x) => !recent.slice(-2).includes(x.s.id));
    const pool = fresh.length ? fresh : cover.filter((x) => x.s.id !== recent.at(-1)).length ? cover.filter((x) => x.s.id !== recent.at(-1)) : cover;
    const min = Math.min(...pool.map((x) => used.get(x.s.id) || 0));
    let cand = pool.filter((x) => (used.get(x.s.id) || 0) <= min + (clear || motion ? 1 : 0));
    const prevCut = cuts.at(-1);
    if (motion && prevCut) {
      // 动作一致度为主、主角清楚为辅：分数 = 动作差（越小越好）- 清楚程度 × 0.3
      const outT = at + prevCut.offset + (prevCut.nudge || 0);
      for (const x of cand) {
        x.q = clear ? clear(x.s, x.off, at, end) ?? 0 : 0;
        x.m = bestShift(motion[prevCut.src], outT, motion[x.s.id], at + x.off);
        x.score = (Number.isFinite(x.m.dist) ? x.m.dist : 1.5) - x.q * 0.3 + (used.get(x.s.id) || 0) * 0.01;
      }
      cand.sort((a, b) => a.score - b.score);
      // 宁可少换、不乱换：没有合格的（锁得住、动作差在 0.3 以内），当前这套还能继续用、也锁得住，就先不换，多停几拍（最多约 10 秒）
      const cur = srcs.find((x) => x.id === prevCut.src);
      const curOff = cur && usable(cur, at, end);
      const held = at - prevCut.at;
      const good = fitted && cand[0] && Number.isFinite(cand[0].m.dist) && cand[0].m.dist <= (spec.matchMax ?? 0.3);
      if (!good && curOff != null && (!sizeOk || sizeOk(cur, curOff, at, end)) && held < (spec.maxHold ?? 10)) {
        if (nextPin) { while (i < grid.length && grid[i] < nextPin.from - 0.01) i++; if (Math.abs((grid[i] ?? Infinity) - nextPin.from) > 0.05) grid.splice(i, 0, nextPin.from); }
        else i = stopAt === -1 ? grid.length : stopAt;
        continue;
      }
      cand = [cand[0]];
    } else if (clear) {
      for (const x of cand) x.q = clear(x.s, x.off, at, end) ?? 0;
      const best = Math.max(...cand.map((x) => x.q));
      cand = cand.filter((x) => x.q >= best - 0.1);
      const fewest = Math.min(...cand.map((x) => used.get(x.s.id) || 0));
      cand = cand.filter((x) => (used.get(x.s.id) || 0) === fewest);
    }
    const pick = cand[Math.floor(rand() * cand.length)];
    used.set(pick.s.id, (used.get(pick.s.id) || 0) + 1);
    cuts.push({ at: r3(at), src: pick.s.id, offset: pick.off, ...(pick.m?.shift ? { nudge: pick.m.shift } : {}), ...(pick.m && Number.isFinite(pick.m.dist) ? { motion: r3(pick.m.dist) } : {}) });
    recent.push(pick.s.id);
    if (nextPin) { while (i < grid.length && grid[i] < nextPin.from - 0.01) i++; if (Math.abs((grid[i] ?? Infinity) - nextPin.from) > 0.05) grid.splice(i, 0, nextPin.from); }
    else i = stopAt === -1 ? grid.length : stopAt;
  }
  // 连着两刀是同一场（候选太少时会发生），合成一刀，不然就是同一场里跳一下
  const merged = cuts.filter((c, k) => k === 0 || c.src !== cuts[k - 1].src || c.pinned);
  return { cuts: merged, beats: { bpm: bt.bpm, period: bt.period, first: bt.first }, structureMap: spec.structureMap };
}

// ---------- 换装转场：按段落地图给每一刀挑转场 ----------
// 段落开头：扫描换装 / 节拍光门；爆点：节拍光门；高潮段：残影 / 甩切 / 色彩脉冲；推进段：偶尔甩切、脉冲；安静段：偶尔叠化；其余硬切。
// 特效转场（不含叠化）不超过总刀数的 budget（默认 20%），扫描换装全片最多 4 次，同一种不连用。cut.fxManual 为 true 的不动。
const FX_FRAMES = { scan: 8, echo: 9, gate: 8, whip: 6, pulse: 4, dissolve: 4, flash: 5 };
function assignFx(spec) {
  const cuts = [...spec.cuts].sort((a, b) => a.at - b.at);
  const sm = spec.structureMap;
  if (!sm) die('先按段落地图排切点（"structure": true 再 plan），才能自动挑转场');
  const opt = spec.fx || {};
  const budget = Math.round(cuts.length * (opt.budget ?? 0.2));
  const caps = { scan: opt.style === 'silky' ? 6 : 4, echo: 4, ...(opt.caps || {}) };
  const rand = rng((spec.auto?.seed || 1) * 7 + 3);
  const secOf = (t) => sm.sections.find((x) => t >= x.from - 0.01 && t < x.to - 0.01) || sm.sections.at(-1);
  const isStart = (t) => sm.sections.some((x) => Math.abs(x.from - t) < 0.06);
  const isDrop = (t) => sm.drops.some((d) => Math.abs(d - t) < 0.06);
  const used = {}; let special = 0, last = null;
  const pick = (types) => types.filter((x) => x !== last && (used[x] || 0) < (caps[x] ?? Infinity));
  for (const [i, c] of cuts.entries()) {
    if (c.fxManual) { last = c.fx?.type || null; continue; }
    delete c.fx;
    if (i === 0) continue;
    const sec = secOf(c.at);
    let cand = [], prob = 0;
    if (opt.style === 'silky') {
      // 丝滑换装：只用作用在人身上的转场，不强调「换场景」；大部分是对准动作的硬切
      if (isDrop(c.at) || isStart(c.at)) { cand = pick(['scan']); prob = 0.9; }
      else if (sec.energy === 3) { cand = pick(['echo']); prob = 0.2; }
    } else if (isDrop(c.at)) { cand = pick(['gate', 'scan']); prob = 1; }
    else if (isStart(c.at)) { cand = pick(sec.energy >= 2 ? ['scan', 'gate'] : ['scan', 'dissolve']); prob = 0.9; }
    else if (sec.energy === 3) { cand = pick(['echo', 'whip', 'pulse']); prob = 0.35; }
    else if (sec.energy === 2) { cand = pick(['whip', 'pulse']); prob = 0.15; }
    else { cand = pick(['dissolve']); prob = 0.25; }
    if (!cand.length || rand() > prob) { last = null; continue; }
    const type = cand[Math.floor(rand() * cand.length)];
    if (type !== 'dissolve' && special >= budget) { last = null; continue; }
    c.fx = { type, frames: FX_FRAMES[type] };
    used[type] = (used[type] || 0) + 1;
    if (type !== 'dissolve') special++;
    last = type;
  }
  spec.cuts = cuts;
  return { total: cuts.length, special, budget, used };
}

// 能不能锁住主角（全程锁定用）：统一大小 T、某一刻能不能放到画面正中、某一段能不能用
function lockFns(spec, motion) {
  let sizeOk, edgeOk;
  const zMin = spec.lock.zoomMin ?? 1.15, zMax = spec.lock.zoomMax ?? 1.6;
  const all = Object.values(motion).flatMap((P) => P.samples.filter((x) => x.ok).map((x) => x.torso)).sort((a, b) => a - b);
  let T = spec.lock.torso, bestN = -1;
  if (!T) for (let i = 0; i < all.length; i += Math.max(1, Math.floor(all.length / 200))) {
    const c = all[i] * zMin, lo = c / zMax, hi = c / zMin;
    const n = all.filter((v) => v >= lo && v <= hi).length;
    if (n > bestN) { bestN = n; T = c; }
  }
  // 能不能锁住：这段里大部分时刻，主角能缩放到统一大小，而且放大后裁切框能把他放到画面中间（不会顶到原画边上）
  const ty = spec.lock.y ?? 0.3, aspect = 16 / 9;
  // 切点前后 0.25 秒（a 附近）这一小段能不能放到正中：换装那一刻最要紧，比整段的比例更严（偏差只允许 5%）
  const fitAt = (x, tol) => {
    if (!x?.ok || x.joints.filter(Boolean).length < (spec.lock.minJoints ?? 7)) return false;
    const z = T / x.torso;
    if (z < zMin * 0.92 || z > zMax * 1.08) return false;
    const zc = Math.min(zMax, Math.max(zMin, z)), nx = x.neck[0], ny = x.neck[1];
    return nx >= 0.5 / zc - tol && nx <= 1 - 0.5 / zc + tol && ny >= ty / zc - tol && ny <= 1 - (1 - ty) / zc + tol;
  };
  edgeOk = (s, off, t) => {
    const xs = motion[s.id].samples.filter((x) => Math.abs(x.t - (t + off)) <= 0.25);
    return xs.length >= 3 && xs.filter((x) => fitAt(x, 0.05)).length / xs.length >= 0.8;
  };
  sizeOk = (s, off, a, b) => {
    if (!edgeOk(s, off, a) || !edgeOk(s, off, b)) return false;
    const xs = motion[s.id].samples.filter((x) => x.t >= a + off && x.t <= b + off);
    if (xs.length < 3) return false;
    const ok = xs.filter((x) => {
      if (!x.ok) return false;
      // 被挡住：12 个主要关节里看得见的少于 7 个，多半是前面有人挡着他
      if (x.joints.filter(Boolean).length < (spec.lock.minJoints ?? 7)) return false;
      const z = T / x.torso;
      if (z < zMin * 0.92 || z > zMax * 1.08) return false;
      const zc = Math.min(zMax, Math.max(zMin, z)), nx = x.neck[0], ny = x.neck[1];
      // 允许偏离画面中心一点（posTol，默认 8%）：素材里他常常不在正中，强求正中会把很多场都筛掉
      const tol = spec.lock.posTol ?? 0.08;
      return nx >= 0.5 / zc - tol && nx <= 1 - 0.5 / zc + tol && ny >= ty / zc - tol && ny <= 1 - (1 - ty) / zc + tol;
    }).length;
    return ok / xs.length >= 0.65;
  };
    // 某一刻他在成片里能被放到哪些位置：按统一大小缩放后，裁切框能在原画范围里移动，脖子能落到的区间
  const reach = (s, off, t) => {
    const xs = motion[s.id].samples.filter((x) => Math.abs(x.t - (t + off)) <= 0.25 && x.ok && x.joints.filter(Boolean).length >= (spec.lock.minJoints ?? 7));
    if (xs.length < 3) return null;
    let x0 = -Infinity, x1 = Infinity, y0 = -Infinity, y1 = Infinity;
    for (const x of xs) {
      const z = T / x.torso;
      if (z < zMin * 0.92 || z > zMax * 1.08) return null;
      const zc = Math.min(zMax, Math.max(zMin, z));
      x0 = Math.max(x0, x.neck[0] * zc - (zc - 1)); x1 = Math.min(x1, x.neck[0] * zc);
      y0 = Math.max(y0, x.neck[1] * zc - (zc - 1)); y1 = Math.min(y1, x.neck[1] * zc);
    }
    return x0 <= x1 && y0 <= y1 ? { x0, x1, y0, y1 } : null;
  };
  // 这一段能不能用（不要求放到正中）：大部分时刻大小对得上、没被挡
  const usableSeg = (s, off, a, b) => {
    const xs = motion[s.id].samples.filter((x) => x.t >= a + off && x.t <= b + off);
    if (xs.length < 3) return false;
    // 停留期间大小可以比统一大小差得多一些（直拍自己会推拉镜头，他看得清就行）；换装那一刻的大小另外由 edgeOk 卡严
    const slack = spec.lock.holdSlack ?? 1.35;
    const ok = xs.filter((x) => x.ok && x.joints.filter(Boolean).length >= (spec.lock.minJoints ?? 7) && T / x.torso >= zMin * 0.92 / slack && T / x.torso <= zMax * 1.08 * slack).length;
    // 全程锁定时，这一段大部分时刻还要能把他放回画面中间（放大倍数小、他又走到边上，裁切框挪不过去，画面中间就成了别人）
    const centered = xs.filter((x) => fitAt(x, spec.lock.centerTol ?? 0.08)).length;
    return ok / xs.length >= 0.65 && centered / xs.length >= (spec.lock.centerShare ?? 0.7);
  };
  // 只看位置：按能放大到的倍数，他能不能放回画面中间（大小差一些也算）
  const centerable = (x, tol) => {
    if (!x?.ok || x.joints.filter(Boolean).length < (spec.lock.minJoints ?? 7)) return false;
    const zc = Math.min(zMax, Math.max(zMin, T / x.torso)), nx = x.neck[0], ny = x.neck[1];
    return nx >= 0.5 / zc - tol && nx <= 1 - 0.5 / zc + tol && ny >= ty / zc - tol && ny <= 1 - (1 - ty) / zc + tol;
  };
  return { T: r3(T), sizeOk, edgeOk, reach, usableSeg, centerable };
}

// ---------- 全局挑换装点：只在两场动作几乎一样的那一拍换（动态规划） ----------
// 状态：当前用哪一场、上一场是谁、这一套已经停了几拍。每拍可以「继续」或「换到另一场」：
// 换的代价 = 两场在这一拍附近的动作差（前后各挪 0.3 秒找最像的接点）- 换装奖励；差太大不许换。
// 这一拍这场锁不住（偏到边上、被挡、大小对不上）就不能停在这场。停太久扣分，逼着在合适的地方换。
function schedule(spec, dir) {
  const master = path.resolve(dir, spec.audio.file);
  const from = spec.audio.start ?? 0, to = spec.audio.end ?? duration(master);
  const opt = { minHold: 4, maxHold: 24, softHold: 12, thr: 0.14, bonus: 0.12, ...(spec.schedule || {}) };
  const bt = spec.beats || beats(master);
  const B = bt.beats.filter((t) => t >= from - 0.01 && t < to - 0.2);
  // 按段落能量定节奏：高潮最少停 4 拍、换装奖励高一点；推进段 6 拍；安静、平稳段 8 拍
  const sm = sections(master, { from, to });
  spec.structureMap = { bpm: sm.bpm, sections: sm.sections, drops: sm.drops };
  const energyAt = (t) => (sm.sections.find((x) => t >= x.from - 0.01 && t < x.to - 0.01) || sm.sections.at(-1)).energy;
  // 快切段（主音轨时间 [[起, 止]]）：所有场次都没法长时间看清他的段落，每 1–2 拍换到此刻看得清的一场，换的那一刀只要求位置、大小对得上、动作大致像
  const fast = (opt.fastCut || []).filter((r) => Array.isArray(r) && r.length === 2);
  const inFast = (t) => fast.some(([a, b]) => t >= a - 0.01 && t < b);
  // 舞台模式段（主音轨时间 [[起, 止]]）：所有场次都没法干净锁定他的段落（队形舞、人挤人），不锁定、用原机位的队形画面，
  // 每 stageHold 拍换到此刻最看得清他的一场，换装用扫描光带转场盖住接缝，不要求动作贴合；进出这一段也一样
  const stage = (opt.stage || []).filter((r) => Array.isArray(r) && r.length === 2);
  const inStage = (t) => stage.some(([a, b]) => t >= a - 0.01 && t < b);
  // 分身阵列段（opt.array: [{ span: [起, 止], n: 3 }]）：整段一个画面，几场并排；进去的那一刀不挑场次，出来的那一刀要换到能直接锁定的一场
  const arrays = (opt.array || []).filter((x) => Array.isArray(x?.span) && x.span.length === 2);
  const inArr = (t) => arrays.some(({ span: [a, b] }) => t >= a - 0.01 && t < b);
  const minHoldAt = B.map((t, i) => { if (inArr(t) || (i > 0 && inArr(B[i - 1]))) return 1; if (inStage(t)) return opt.stageHold ?? 8; if (inFast(t)) return opt.fastHold ?? 2; const e = energyAt(t); return Math.max(opt.minHold, e >= 3 ? 4 : e === 2 ? 6 : 8); });
  const bonusAt = B.map((t) => opt.bonus + (energyAt(t) >= 2 ? 0.04 : 0));
  const motion = posesOf(spec, dir);
  const srcs = spec.sources.filter((s) => s.offset != null && s.use !== false);
  const L = lockFns(spec, motion);
  // 每一拍每一场能不能停：这一拍到下一拍之间锁得住
  // 一段时间（素材时间 a–b）里认得准他：逐帧认人 80% 以上的帧确认是他，脖子位置没有突然跳
  const idOk = (sObj, a, b) => {
    const ps = []; for (let t = a; t <= b + 1e-6; t += 0.1) ps.push(poseAt(motion[sObj.id], t));
    if (ps.filter(Boolean).length < ps.length * 0.8) return false;
    const pp = ps.filter(Boolean);
    for (let k = 1; k < pp.length; k++) if (Math.hypot(pp[k].neck[0] - pp[k - 1].neck[0], pp[k].neck[1] - pp[k - 1].neck[1]) > 0.06) return false;
    return true;
  };
  // 快切段里只要求看得清他（认得准、主要关节看得见）而且能放回画面中间，大小差一些也行
  const clearSeg = (s, off, a, b) => { const xs = motion[s.id].samples.filter((x) => x.t >= a + off && x.t <= b + off); return xs.length >= 2 && xs.filter((x) => L.centerable(x, 0.1)).length / xs.length >= 0.65; };
  const seenSeg = (s, off, a, b) => { const xs = motion[s.id].samples.filter((x) => x.t >= a + off && x.t <= b + off); return xs.length >= 2 && xs.filter((x) => x.ok && x.joints.filter(Boolean).length >= 6).length / xs.length >= 0.6; };
  const okAt = srcs.map((s) => B.map((t, i) => { const e = B[i + 1] ?? to; const off = usable(s, t, e); if (off == null) return null; if (inArr(t)) return off; if (inStage(t)) return seenSeg(s, off, t, e) ? off : null; return (inFast(t) ? clearSeg(s, off, t, e) : L.usableSeg(s, off, t, e)) && idOk(s, t + off, e + off) ? off : null; }));
  // 舞台模式段的边界必须换一刀（这一段整段不锁定，前后整段锁定）
  const stageEdge = B.map((t, i) => i > 0 && (inStage(t) !== inStage(B[i - 1]) || inArr(t) !== inArr(B[i - 1])));
  // 造型要轮得全：能用的时间越少的场次，换进去时奖励越多（不然这几场一次都排不上）
  const okN = okAt.map((r) => r.filter((v) => v != null).length), okMax = Math.max(...okN);
  const rare = okN.map((n) => (opt.variety ?? 0.06) * (1 - n / okMax));
  // 换装那一刻两边能不能放到同一个位置：两边能到达的区间有交集，而且交集在画面舒服的区域里（不贴边）
  const comfy = { x0: 0.3, x1: 0.7, y0: 0.15, y1: 0.5 };
  const meet = (ra, rb) => ra && rb && Math.max(ra.x0, rb.x0, comfy.x0) <= Math.min(ra.x1, rb.x1, comfy.x1) && Math.max(ra.y0, rb.y0, comfy.y0) <= Math.min(ra.y1, rb.y1, comfy.y1);
  // 每一拍每对场次的接点：动作差和新场次要挪多少
  const sw = new Map();
  const swCost = (a, b, i) => {
    const key = `${a},${b},${i}`;
    if (sw.has(key)) return sw.get(key);
    const oa = okAt[a][i - 1] ?? okAt[a][i], ob = okAt[b][i];
    let r = { cost: Infinity, why: oa == null ? 'out' : ob == null ? 'in' : '' };
    if (inArr(B[i]) && inArr(B[i - 1])) { sw.set(key, r); return r; } // 阵列段中间不换
    if (inArr(B[i]) && ob != null) { r = { cost: -opt.bonus, shift: 0, dist: null, arrayIn: true }; sw.set(key, r); return r; }
    if (inArr(B[i - 1])) {
      // 从阵列出来：换到这一刻就能锁定的一场（阵列最后一列放大成全屏，正好接上）
      if (ob != null && L.edgeOk(srcs[b], ob, B[i]) && idOk(srcs[b], B[i] + ob - 0.3, B[i] + ob + 1.0)) r = { cost: -opt.bonus, shift: 0, dist: null, arrayOut: true };
      sw.set(key, r); return r;
    }
    if (inStage(B[i]) || inStage(B[i - 1])) {
      // 舞台模式里换场不看动作；这一拍谁都看不清时也允许换（边界必须换一刀），只是贵一些
      const obb = ob ?? usable(srcs[b], B[i], B[i + 1] ?? to);
      if (obb == null) { sw.set(key, r); return r; }
      r = { cost: (ob != null ? 0.05 : 1.5) - opt.bonus, shift: 0, dist: null, stage: true };
      sw.set(key, r);
      return r;
    }
    if (inFast(B[i]) && ob != null && idOk(srcs[b], B[i] + ob - 0.2, B[i] + ob + 0.6)) {
      const sObjA = srcs[a], offA = oa ?? usable(sObjA, B[i] - 0.5, B[i] + 0.5) ?? sObjA.offset;
      const m = bestShift(motion[sObjA.id], B[i] + offA, motion[srcs[b].id], B[i] + ob);
      const ra = L.reach(sObjA, offA, B[i]);
      if ((!Number.isFinite(m.dist) || m.dist <= (opt.fastMax ?? 0.35)) && (!ra || meet(ra, L.reach(srcs[b], ob + (m.shift || 0), B[i])))) {
        r = { cost: (Number.isFinite(m.dist) ? m.dist : 0.35) - opt.bonus, shift: m.shift || 0, dist: Number.isFinite(m.dist) ? m.dist : 1, fast: true };
        sw.set(key, r);
        return r;
      }
    }
    // 脱身：这一场已经认不准他、锁不住（被挡、挤在一起）时，可以从这里换走，但换装那一刻照样要动作贴合、位置对得上（不贴合的刀比多停几拍更难看）
    if (oa == null && ob != null && okAt[a][i] == null && idOk(srcs[b], B[i] + ob - 0.3, B[i] + ob + 1.0) && L.edgeOk(srcs[b], ob, B[i])) {
      const sObjA = srcs[a], offA = usable(sObjA, B[i] - 0.5, B[i] + 0.5) ?? sObjA.offset;
      const m = bestShift(motion[sObjA.id], B[i] + offA, motion[srcs[b].id], B[i] + ob);
      // 动作差可以放宽到 escapeMax（默认 0.3），位置、大小照样要对得上；越不像越贵，只在被挡时才用
      if (Number.isFinite(m.dist) && m.dist <= (opt.escapeMax ?? 0.3) && meet(L.reach(sObjA, offA, B[i]), L.reach(srcs[b], ob + m.shift, B[i]))) {
        r = { cost: m.dist - opt.bonus + Math.max(0, m.dist - opt.thr) * 4 + 0.1, shift: m.shift, dist: m.dist, escape: true };
      }
      sw.set(key, r);
      return r;
    }
    if (oa != null && ob != null && !idOk(srcs[a], B[i] + oa - 0.6, B[i] + oa + 0.3)) r.why = 'idOut';
    else if (oa != null && ob != null && !idOk(srcs[b], B[i] + ob - 0.3, B[i] + ob + 1.0)) r.why = 'idIn';
    else if (oa != null && ob != null) {
      const m = bestShift(motion[srcs[a].id], B[i] + oa, motion[srcs[b].id], B[i] + ob);
      r.why = !Number.isFinite(m.dist) ? 'nopose' : m.dist > (opt.thrMax ?? 0.18) ? 'motion' : 'meet';
      // 动作差 thr 以内正常；到 thrMax 也能换但贵一些（实在找不到更像的才用）
      if (Number.isFinite(m.dist) && m.dist <= (opt.thrMax ?? 0.18) && meet(L.reach(srcs[a], oa, B[i]), L.reach(srcs[b], ob + m.shift, B[i]))) {
        r = { cost: m.dist - opt.bonus + Math.max(0, m.dist - opt.thr) * 2, shift: m.shift, dist: m.dist };
      }
    }
    sw.set(key, r);
    return r;
  };
  const N = srcs.length, H = opt.maxHold;
  // 造型分组：同一套造型的几条（不同座位拍的）之间切换不算换装，不许这样切；source.look 不写就每条一组
  const look = srcs.map((x) => x.look || x.id);
  const idx = (s, p, h) => (s * (N + 1) + p) * (H + 1) + h; // p = N 表示没有上一场
  let cur = new Float64Array(N * (N + 1) * (H + 1)).fill(Infinity);
  const back = [];
  // 片头第一拍必须从一开始就认准他的场次起（都不行时才退而求其次）
  const startOk = srcs.map((x, k) => okAt[k][0] != null && idOk(x, from + okAt[k][0], from + okAt[k][0] + 1.2));
  for (let s = 0; s < N; s++) cur[idx(s, N, 1)] = startOk[s] ? 0 : startOk.some(Boolean) ? Infinity : okAt[s][0] != null ? 0 : 2;
  for (let i = 1; i < B.length; i++) {
    const nxt = new Float64Array(cur.length).fill(Infinity);
    const bk = new Int32Array(cur.length).fill(-1);
    const hold = (h) => (h > opt.softHold ? (h - opt.softHold) * (opt.holdCost ?? 0.05) : 0);
    for (let s = 0; s < N; s++) for (let p = 0; p <= N; p++) for (let h = 1; h <= H; h++) {
      const c = cur[idx(s, p, h)];
      if (!Number.isFinite(c)) continue;
      // 继续用这一场
      {
        // 停到上限以后还能继续停（找不到合适的换装点时），只是每拍扣分越来越多
        const pen = stageEdge[i] ? Infinity : okAt[s][i] == null ? (opt.blockedCost ?? 6) : 0; // 这一拍他被挡、认不准或锁不住：基本不许停在这场，宁可换到看得清的一场
        const v = c + pen + hold(h + 1);
        const k = idx(s, p, Math.min(H, h + 1));
        if (v < nxt[k]) { nxt[k] = v; bk[k] = idx(s, p, h); }
      }
      // 换到另一场（停够 minHold 拍、不回到上一场）
      if (h >= minHoldAt[i]) for (let q = 0; q < N; q++) {
        if (q === s || q === p || look[q] === look[s] || (p < N && look[q] === look[p])) continue;
        const r = swCost(s, q, i);
        if (!Number.isFinite(r.cost)) continue;
        const v = c + r.cost + opt.bonus - bonusAt[i] - rare[q];
        const k = idx(q, s, 1);
        if (v < nxt[k]) { nxt[k] = v; bk[k] = idx(s, p, h); }
      }
    }
    back.push(bk); cur = nxt;
    if (process.env.SCHED_DEBUG && !cur.some(Number.isFinite)) { console.error(`第 ${i} 拍（${r3(B[i])} 秒）之后没有可行的排法；舞台段=${inStage(B[i])} 边界=${stageEdge[i]} 能停的场：${srcs.filter((x, k) => okAt[k][i] != null).map((x) => x.id).join(',')}`); break; }
  }
  let best = -1, bv = Infinity;
  for (let k = 0; k < cur.length; k++) if (cur[k] < bv) { bv = cur[k]; best = k; }
  if (best < 0 || process.env.SCHED_DEBUG) {
    console.error('拍子能不能停（有对齐/锁得住/认得准）：' + srcs.map((x) => { let u = 0, l = 0, d = 0; B.forEach((t, i) => { const e = B[i + 1] ?? to; const off = usable(x, t, e); if (off == null) return; u++; if (!L.usableSeg(x, off, t, e)) return; l++; if (idOk(x, t + off, e + off)) d++; }); return `${x.id}:${u}/${l}/${d}`; }).join(' '));
    console.error('每场能停的拍数：' + srcs.map((x, k) => `${x.id}:${okAt[k].filter((v) => v != null).length}/${B.length}`).join(' '));
    let n = 0; const into = new Array(N).fill(0);
    for (let i = 1; i < B.length; i++) for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) if (a !== b && Number.isFinite(swCost(a, b, i).cost)) { n++; into[b]++; }
    if (process.env.SCHED_SPAN) { const [f0, f1] = process.env.SCHED_SPAN.split(',').map(Number); const why = {}; for (let i = 1; i < B.length; i++) if (B[i] >= f0 && B[i] <= f1) for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) if (a !== b) { const r = swCost(a, b, i); if (!Number.isFinite(r.cost)) why[r.why] = (why[r.why] || 0) + 1; else why.ok = (why.ok || 0) + 1; } console.error('这段换不了的原因：' + JSON.stringify(why)); console.error('这段停不了的原因：' + srcs.map((x) => { const w = { align: 0, lock: 0, id: 0, ok: 0 }; B.forEach((t, i) => { if (t < f0 || t > f1) return; const e = B[i + 1] ?? to; const off = usable(x, t, e); if (off == null) w.align++; else if (!L.usableSeg(x, off, t, e)) w.lock++; else if (!idOk(x, t + off, e + off)) w.id++; else w.ok++; }); return `${x.id}:${JSON.stringify(w)}`; }).join(' ')); console.error('这段每场能停的拍：' + srcs.map((x, k) => `${x.id}:` + B.map((t, i) => (t >= f0 && t <= f1 ? (okAt[k][i] != null ? '█' : '·') : '')).join('')).join('  ')); }
    console.error(`能换的（拍 × 场次对）：${n}；能换进各场的次数：` + srcs.map((x, k) => `${x.id}:${into[k]}`).join(' '));
  }
  if (best < 0) die('这一段找不到能一直锁住主角的排法（素材都偏到边上或被挡），换一段试试');
  // 回溯
  const path_ = [best];
  for (let i = back.length - 1; i >= 0; i--) path_.unshift(back[i][path_[0]]);
  const decode = (k) => { const h = k % (H + 1); const r = (k - h) / (H + 1); const p = r % (N + 1); return { s: (r - p) / (N + 1), p, h }; };
  const cuts = [], arrCuts = [];
  for (let i = 0; i < path_.length; i++) {
    const d = decode(path_[i]);
    if (i === 0 || d.h === 1) {
      const sObj = srcs[d.s];
      const r = i > 0 ? swCost(decode(path_[i - 1]).s, d.s, i) : null;
      const t0 = i === 0 ? from : B[i];
      if (r?.arrayIn) arrCuts.push(cuts.length);
      cuts.push({ at: r3(t0), src: sObj.id, offset: okAt[d.s][i] ?? usable(sObj, t0, B[i + 1] ?? to) ?? sObj.offset, ...(r?.shift ? { nudge: r.shift } : {}), ...(r?.dist != null ? { motion: r3(r.dist) } : {}), ...(inStage(t0) ? { free: true } : {}), ...(r?.stage ? { stageCut: true } : {}) });
    }
  }
  // 换装默认用人形变形过渡（5 帧），可以用 schedule.fx 改（比如 "cut" 硬切）
  for (const [k, c] of cuts.entries()) if (k > 0 && opt.fx !== 'cut') c.fx = c.stageCut ? { type: opt.stageFx || 'scan', frames: opt.stageFxFrames || 12 } : { type: opt.fx || 'morph', frames: opt.fxFrames || 5 };
  for (const c of cuts) delete c.stageCut;
  // 舞台段：按 hold 拍分成时间窗，每个窗换成此刻最清楚（认得准、正脸、没被挡）的一场，他放在画面中间；
  // 两场都很清楚、造型又不同时，偶尔并排成两列（分身）。第一个窗是上一刀的场次，最后一个窗是下一刀的场次
  for (const ci of arrCuts) {
    const c = cuts[ci], prev = cuts[ci - 1], next = cuts[ci + 1];
    const def = arrays.find(({ span: [a, b] }) => c.at >= a - 0.01 && c.at < b);
    if (!def || !prev || !next) continue;
    const hold = def.hold || 4, end = next.at;
    const winB = B.filter((t) => t >= c.at - 0.01 && t < end - 0.01);
    const seen = (sObj, a, b) => { const off = usable(sObj, a, b); if (off == null) return { r: 0, off: null }; const xs = motion[sObj.id].samples.filter((x) => x.t >= a + off && x.t <= b + off); return { r: xs.length ? xs.filter((x) => x.ok && x.front && x.joints.filter(Boolean).length >= 7).length / xs.length : 0, off }; };
    const lookOf = (id) => look[srcs.findIndex((x) => x.id === id)];
    const wins = [];
    for (let w = 0; w < winB.length; w += hold) wins.push([winB[w], winB[w + hold] ?? end]);
    if (wins.length > 1 && wins.at(-1)[1] - wins.at(-1)[0] < 0.6) { const l = wins.pop(); wins.at(-1)[1] = l[1]; }
    const out = [];
    let lastSplit = -9;
    for (const [wi, [a, b]] of wins.entries()) {
      const col = (id) => ({ src: id, offset: usable(srcs.find((x) => x.id === id), a, b) ?? srcs.find((x) => x.id === id).offset });
      if (wi === 0) { out.push({ from: r3(a), to: r3(b), cols: [col(prev.src)] }); continue; }
      if (wi === wins.length - 1) { out.push({ from: r3(a), to: r3(b), cols: [col(next.src)] }); continue; }
      const before = new Set(out.at(-1).cols.map((x) => lookOf(x.src)));
      const cand = srcs.map((x) => ({ id: x.id, look: lookOf(x.id), ...seen(x, a, b) })).filter((x) => x.off != null).sort((p, q) => q.r - p.r);
      // 每个窗都换造型：优先挑和上一个窗不同造型、又看得清的
      // 先保证看得清：只在和最清楚的那场差不多清楚（差 0.1 以内）的里面挑换造型的
      const top = cand[0]?.r ?? 0;
      const fresh = cand.filter((x) => !before.has(x.look) && x.r >= top - 0.1);
      const pool = fresh.length ? fresh : cand;
      const first = pool[0];
      const second = pool.find((x) => x.look !== first.look && x.r >= 0.8);
      if (first.r >= 0.8 && second && wi - lastSplit >= 3 && wi > 1 && wi < wins.length - 2 && (def.split ?? true)) { out.push({ from: r3(a), to: r3(b), cols: [col(first.id), col(second.id)] }); lastSplit = wi; }
      else out.push({ from: r3(a), to: r3(b), cols: [col(first.id)] });
    }
    // 相邻两个窗是同一场就并成一个（不在同一场里自己转场）
    const merged = [];
    for (const w of out) { const l = merged.at(-1); if (l && l.cols.length === w.cols.length && l.cols.every((x, k) => x.src === w.cols[k].src)) l.to = w.to; else merged.push(w); }
    c.array = { windows: merged, ...(def.colTorso ? { colTorso: def.colTorso } : {}) };
    c.fx = { type: 'cut', frames: 1 }; next.fx = { type: 'cut', frames: 1 };
    delete c.motion;
  }
  spec.cuts = cuts;
  spec.lock.torso = L.T;
  return { cuts: cuts.length, cost: r3(bv), motions: cuts.filter((c) => c.motion != null).map((c) => c.motion) };
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
const LOCKFX = path.join(path.dirname(new URL(import.meta.url).pathname), 'lockfx.swift');
const ARRAY_SWIFT = path.join(path.dirname(new URL(import.meta.url).pathname), 'array.swift');
function arrayBin() {
  const st = fs.statSync(ARRAY_SWIFT);
  const bin = path.join(os.tmpdir(), `montage-array-${Math.round(st.mtimeMs)}`);
  if (!fs.existsSync(bin)) {
    const r = spawnSync('swiftc', ['-O', ARRAY_SWIFT, '-o', bin], { encoding: 'utf8' });
    if (r.status !== 0) die(`编译 array.swift 失败：${r.stderr}`);
  }
  return bin;
}
function videoSize(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = r.stdout.trim().split(',').map(Number);
  return [w || 1920, h || 1080];
}
// 各片段在用到的时段里的平均颜色（每秒取 2 帧），拉到所有片段的平均值；和 lockfx 原来的算法一样（0.7 次方、限制在 0.87–1.15）
function gradeGains(spec, dir, segs, fps, total) {
  const srcs = new Map(spec.sources.map((s) => [s.id, s]));
  const ranges = new Map();
  for (let k = 0; k < segs.length; k++) {
    const { c, piece } = segs[k];
    const f0 = Math.round(segs[k].out * fps), f1 = k + 1 < segs.length ? Math.round(segs[k + 1].out * fps) : total;
    const t0 = piece.from + (f0 / fps - piece.out), t1 = t0 + (f1 - f0) / fps;
    const items = c.array ? c.array.windows.flatMap((w) => w.cols.map((sl) => ({ src: sl.src, a: Math.max(t0, w.from) + sl.offset, b: Math.min(t1, w.to) + sl.offset }))) : [{ src: c.src, a: t0 + (c.offset ?? srcs.get(c.src).offset), b: t1 + (c.offset ?? srcs.get(c.src).offset) }];
    for (const it of items) { if (it.b <= it.a) continue; const f = path.resolve(dir, srcs.get(it.src).file); if (!ranges.has(f)) ranges.set(f, []); ranges.get(f).push([it.a, it.b]); }
  }
  const means = new Map();
  for (const [f, rs] of ranges) {
    let sum = [0, 0, 0], n = 0;
    for (const [a, b] of rs) {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, a)), '-t', String(b - a), '-i', f, '-vf', 'fps=2,scale=16:9', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
      const buf = r.stdout || Buffer.alloc(0);
      for (let i = 0; i + 2 < buf.length; i += 3) { sum[0] += buf[i] / 255; sum[1] += buf[i + 1] / 255; sum[2] += buf[i + 2] / 255; n++; }
    }
    if (n) means.set(f, sum.map((v) => v / n));
  }
  if (!means.size) return null;
  const target = [0, 1, 2].map((c) => [...means.values()].reduce((a, m) => a + m[c], 0) / means.size);
  return Object.fromEntries([...means].map(([f, m]) => [f, [0, 1, 2].map((c) => r3(Math.min(1.15, Math.max(0.87, Math.pow(target[c] / Math.max(m[c], 0.01), 0.7)))))]));
}

function lockfxBin() {
  const st = fs.statSync(LOCKFX);
  const bin = path.join(os.tmpdir(), `montage-lockfx-${Math.round(st.mtimeMs)}`);
  if (!fs.existsSync(bin)) {
    const r = spawnSync('swiftc', ['-O', LOCKFX, '-o', bin], { encoding: 'utf8' });
    if (r.status !== 0) die(`编译 lockfx.swift 失败（要装 Xcode 命令行工具）：${r.stderr}`);
  }
  return bin;
}
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

// ---------- 动作：逐帧骨架（每秒 10 帧），换装时找新旧两场动作最一致的接点 ----------
const POSE_SWIFT = path.join(path.dirname(new URL(import.meta.url).pathname), 'pose.swift');
function poseBin() {
  const st = fs.statSync(POSE_SWIFT);
  const bin = path.join(os.tmpdir(), `montage-pose-${Math.round(st.mtimeMs)}`);
  if (!fs.existsSync(bin)) {
    const r = spawnSync('swiftc', ['-O', POSE_SWIFT, '-o', bin], { encoding: 'utf8' });
    if (r.status !== 0) die(`编译 pose.swift 失败：${r.stderr}`);
  }
  return bin;
}
// 逐帧认主角：画面里每个人的骨架和外观都有，挑出整条片段里「最常出现、最靠中间的那个外观」当主角（直拍跟着他拍），
// 再逐帧连起来：外观像、不瞬移；认不准的帧宁可当「不在画面里」，不硬跟旁边的人
const cosdN = (a, b) => (a?.length && b?.length ? cosd(a, b) : null);
const hdN = (a, b) => (a?.length && b?.length ? hd(a, b) : null);
const medOf = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
function resolveSubject(samples,{aspect=16/9,none=3.0,gap=2.5,sure=1.4,loose=2.6,anchor=1.5,margin=0.15}={}){
  const all=[];samples.forEach((s,i)=>s.c.forEach((c)=>{c.i=i;all.push(c);}));
  const cen=(c)=>Math.abs(c.neck[0]-0.5);
  const dist=(a,b)=>Math.hypot((a.neck[0]-b.neck[0])*aspect,a.neck[1]-b.neck[1]);
  // 1) 最常出现、最靠中间的那个外观 = 主角（直拍跟着他拍）
  const F=all.filter((c)=>c.fp?.length&&c.torso>0.08);
  let rnd=7;const R=()=>{rnd=(rnd*16807)%2147483647;return rnd/2147483647;};
  let best=null;
  for(let rs=0;rs<4;rs++){
    let C=[F[Math.floor(R()*F.length)].fp];
    while(C.length<6){const d=F.map((x)=>Math.min(...C.map((c)=>cosdN(x.fp,c))));const tot=d.reduce((a,b)=>a+b*b,0);let r=R()*tot,j=0;for(;j<d.length-1;j++){r-=d[j]*d[j];if(r<=0)break;}C.push(F[j].fp);}
    let as=[];
    for(let it=0;it<12;it++){as=F.map((x)=>{let b=0,bd=9;C.forEach((c,j)=>{const d=cosdN(x.fp,c);if(d<bd){bd=d;b=j;}});return b;});C=C.map((c,j)=>{const m=F.filter((_,q)=>as[q]===j);return m.length?meanVec(m.map((x)=>x.fp)):c;});}
    const inert=F.reduce((a,x,q)=>a+cosdN(x.fp,C[as[q]]),0);
    if(!best||inert<best.inert)best={inert,C,as};
  }
  const score=best.C.map((_,j)=>F.filter((_,q)=>best.as[q]===j).reduce((a,x)=>a+x.torso*Math.max(0,1-1.6*cen(x)),0));
  const top=score.indexOf(Math.max(...score));
  let members=F.filter((_,q)=>best.as[q]===top);
  // 短轨迹：前后帧里同一个人（脖子挪得很少、附近没有第二个候选）连成一串；交叉、挤在一起的地方断开
  for(let i=0;i<samples.length;i++){
    const cur=samples[i].c,prev=i?samples[i-1].c:[],k=Math.max(1,i?(samples[i].t-samples[i-1].t)/0.1:1);
    cur.forEach((c,ci)=>{
      const near=prev.filter((o)=>dist(o,c)<0.04*k);
      const ok1=near.length===1&&cur.every((o)=>o===c||dist(o,c)>=0.06)&&prev.filter((o)=>dist(o,near[0])<0.06).length===1;
      c.tid=ok1?near[0].tid:`${i}-${ci}`;
    });
  }
  const tracks=new Map();for(const c of all){if(!tracks.has(c.tid))tracks.set(c.tid,[]);tracks.get(c.tid).push(c);}
  // 外观差 = 整体特征、头发颜色、上身颜色、脸部特征四项，按「这一场哪项最能把他和别人分开」加权（有的场次头发最管用，有的衣服、脸最管用）
  let wt=[1.2,1,1,1.5],path=null;
  for(let round=0;round<4;round++){
    const fc=members.filter((x)=>x.face?.length);const M={face:fc.length>=5?meanVec(fc.map((x)=>x.face)):null,fp:meanVec(members.filter((x)=>x.fp?.length).map((x)=>x.fp)),hair:meanVec(members.filter((x)=>x.hair?.length).map((x)=>x.hair)),cloth:meanVec(members.filter((x)=>x.cloth?.length).map((x)=>x.cloth))};
    const sF=medOf(members.map((x)=>cosdN(x.fp,M.fp)))||0.1,sH=medOf(members.map((x)=>hdN(x.hair,M.hair)))||0.2,sC=medOf(members.map((x)=>hdN(x.cloth,M.cloth)))||0.2,sX=medOf(members.map((x)=>cosdN(x.face,M.face)))||0.1;
    for(const c of all)c.pz=[cosdN(c.fp,M.fp),hdN(c.hair,M.hair),hdN(c.cloth,M.cloth),cosdN(c.face,M.face)].map((v,j)=>v==null?null:Math.min(4,v/[sF,sH,sC,sX][j]));
    if(path){
      // 用上一轮认出来的结果估计每项的区分度：他（很像的帧）和同一帧里旁边的人比，这一项「他更小」的比例
      const A=[[],[],[],[]],O=[[],[],[],[]];
      path.forEach((c,i)=>{if(c.none||c.idz>=sure)return;c.pz.forEach((v,j)=>v!=null&&A[j].push(v));for(const o of samples[i].c)if(o!==c&&dist(o,c)>0.05)o.pz.forEach((v,j)=>v!=null&&O[j].push(v));});
      wt=[0,1,2,3].map((j)=>{if(A[j].length<20||O[j].length<20)return wt[j];let w=0,n=0;for(let q=0;q<3000;q++){const a=A[j][(q*7919)%A[j].length],o=O[j][(q*104729)%O[j].length];n++;if(a<o)w++;else if(a===o)w+=0.5;}const auc=Math.min(0.99,Math.max(0.5,w/n));return Math.max(0.1,Math.log(auc/(1-auc)));});
      if(process.env.ID_DEBUG)console.error(`round ${round} 区分度权重 外观=${wt[0].toFixed(2)} 头发=${wt[1].toFixed(2)} 衣服=${wt[2].toFixed(2)} 脸=${wt[3].toFixed(2)}`);
    }
    for(const c of all){const ps=c.pz.map((v,j)=>[v,wt[j]]).filter((p)=>p[0]!=null);const w=ps.reduce((a,p)=>a+p[1],0);c.raw=w?ps.reduce((a,p)=>a+p[0]*p[1],0)/w:2;}
    // 一串短轨迹里前后各 0.6 秒取平均（有整体特征、脸部特征的帧算两份）：单帧糊了、转身了不会突然认成别人
    for(const xs of tracks.values())xs.forEach((c,k)=>{let a=0,n=0;for(let q=Math.max(0,k-6);q<=Math.min(xs.length-1,k+6);q++){const w=xs[q].pz[0]!=null?2:1;a+=w*xs[q].raw;n+=w;}c.idz=a/n;});
    // 2) 逐帧连起来：外观像 + 不瞬移；认不准就「不在画面里」，不硬跟别人
    const NONE={none:true};
    const emit=(c)=>c.none?none:c.idz+cen(c)*0.6+Math.max(0,0.12-c.torso)*5;
    const trans=(a,b,dt)=>{
      if(a.none&&b.none)return 0; if(a.none||b.none)return gap;
      return 40*Math.max(0,dist(a,b)-0.035*Math.max(1,dt/0.1))+3*Math.abs(Math.log(b.torso/a.torso));
    };
    const st=samples.map((s)=>[...s.c,NONE]);
    let cost=st[0].map(emit);const back=[];
    for(let i=1;i<st.length;i++){
      const dt=samples[i].t-samples[i-1].t,nc=[],nb=[];
      for(const b of st[i]){let bc=Infinity,arg=0;st[i-1].forEach((a,k)=>{const v=cost[k]+trans(a,b,dt);if(v<bc){bc=v;arg=k;}});nc.push(bc+emit(b));nb.push(arg);}
      cost=nc;back.push(nb);
    }
    let k=cost.indexOf(Math.min(...cost));path=new Array(st.length);
    for(let i=st.length-1;i>=0;i--){path[i]=st[i][k];if(i>0)k=back[i-1][k];}
    const sel=path.filter((c)=>!c.none&&c.idz<sure);
    if(sel.length>=20)members=sel;
  }
  // 这一帧他旁边没有别人也像他（差不到 margin）：两个人挤在一起、外观又近，就不算认准（太近的多半是同一个人被识别了两次）
  const alone=path.map((c,i)=>c.none||samples[i].c.every((o)=>o===c||dist(o,c)<=0.05||dist(o,c)>=0.5||o.idz>c.idz+margin));
  // 确认是他：很像（sure）且旁边没人也像；或者还算像（loose 以内）、而且和前后 anchor 秒内「认准」的帧连成一段没断过
  const run=new Array(path.length).fill(-1);let r=0;
  for(let i=0;i<path.length;i++){if(path[i].none){r++;continue;}run[i]=r;if(i+1<path.length&&path[i+1].none)r++;}
  const sureAt=path.map((c,i)=>!c.none&&c.idz<sure&&alone[i]);
  const ok=path.map((c,i)=>{
    if(c.none||!alone[i])return false; if(sureAt[i])return true; if(c.idz>=loose)return false;
    for(let j=i-1;j>=0&&samples[i].t-samples[j].t<=anchor&&run[j]===run[i];j--)if(sureAt[j]){for(let k=i+1;k<path.length&&samples[k].t-samples[i].t<=anchor&&run[k]===run[i];k++)if(sureAt[k])return true;break;}
    return false;
  });
  return samples.map((s,i)=>{const c=path[i];
    if(c.none)return{t:s.t,ok:false};
    return{t:s.t,ok:ok[i],neck:c.neck,torso:c.torso,joints:c.joints,front:c.front?1:0,id:Math.round(c.idz*100)/100};});
}

// 每条片段的骨架，缓存在 pose/<id>.json（逐帧认好的主角，v:2）；画面里所有人的原始数据在 pose/<id>.cands.json
function posesOf(spec, dir) {
  scanPeople(spec, dir);
  fs.mkdirSync(path.join(dir, 'pose'), { recursive: true });
  const all = {};
  for (const s of spec.sources) {
    if (s.offset == null || s.use === false) continue;
    const file = path.join(dir, 'pose', `${s.id}.json`);
    const cfile = path.join(dir, 'pose', `${s.id}.cands.json`);
    let cached = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    if (cached?.v !== 3) {
      if (!fs.existsSync(cfile)) {
        const job = path.join(os.tmpdir(), `pose-job-${process.pid}-${s.id}.json`);
        fs.writeFileSync(job, JSON.stringify({ file: path.resolve(dir, s.file), step: 0.1, fpEvery: 5 }));
        const r = spawnSync(poseBin(), [job], { maxBuffer: 1 << 30, encoding: 'utf8' });
        fs.rmSync(job, { force: true });
        if (r.status !== 0) die(`骨架提取失败：${s.file}\n${r.stderr}`);
        fs.writeFileSync(cfile, r.stdout);
      }
      cached = { v: 3, samples: resolveSubject(JSON.parse(fs.readFileSync(cfile, 'utf8')).samples) };
      fs.writeFileSync(file, JSON.stringify(cached));
    }
    const samples = cached.samples;
    all[s.id] = { samples, step: 0.1, t0: samples[0]?.t ?? 0 };
  }
  return all;
}
// 按真实时间二分查找（素材帧率不同，采样间隔不一定正好 0.1 秒，不能用下标推算）
function poseAt(P, t) {
  if (!P) return null;
  const xs = P.samples;
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m].t < t) lo = m + 1; else hi = m; }
  let best = null;
  for (const i of [lo - 1, lo]) { const x = xs[i]; if (x && (!best || Math.abs(x.t - t) < Math.abs(best.t - t))) best = x; }
  return best && Math.abs(best.t - t) <= 0.07 && best.ok ? best : null;
}
function poseDist(a, b) {
  let sum = 0, n = 0;
  for (let i = 0; i < a.joints.length; i++) { const p = a.joints[i], q = b.joints[i]; if (p && q) { sum += Math.hypot(p[0] - q[0], p[1] - q[1]); n++; } }
  return n >= 5 ? sum / n : Infinity;
}
// 一小段动作有多像：切点前后各 0.3 秒，每 0.1 秒比一次姿势
function motionDist(Pa, ta, Pb, tb) {
  let sum = 0, n = 0;
  for (let d = -0.3; d <= 0.301; d += 0.1) { const a = poseAt(Pa, ta + d), b = poseAt(Pb, tb + d); if (a && b) { const x = poseDist(a, b); if (Number.isFinite(x)) { sum += x; n++; } } }
  return n >= 4 ? sum / n : Infinity;
}
// 新场次在 ±range 秒里挪多少，和旧场次的动作最一致
function bestShift(Pout, tOut, Pin, tIn, range = 0.3) {
  let best = { shift: 0, dist: motionDist(Pout, tOut, Pin, tIn) };
  for (let sft = -range; sft <= range + 1e-6; sft += 0.1) {
    const d = motionDist(Pout, tOut, Pin, tIn + sft) + Math.abs(sft) * 0.15; // 能不挪就不挪
    if (d < best.dist) best = { shift: r3(sft), dist: d };
  }
  return best;
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

// ---------- 直拍体检：一条素材适不适合做贴合换装 ----------
// 认人（外观 + 居中 + 连贯）→ 逐帧骨架 → 算：认得出的比例、在画面中间的比例、被挡的比例、景别稳不稳、内部有没有剪辑
function vetFootage(file) {
  const t = trackSource(file, 0.5);
  const tr = t.samples.filter((x) => x.ok && x.w != null).map((x) => [x.t, x.cx, x.cy, x.w, x.h]);
  const job = path.join(os.tmpdir(), `vet-job-${process.pid}.json`);
  fs.writeFileSync(job, JSON.stringify({ file, step: 0.2, track: tr }));
  const r = spawnSync(poseBin(), [job], { maxBuffer: 1 << 28, encoding: 'utf8' });
  fs.rmSync(job, { force: true });
  if (r.status !== 0) die(`骨架提取失败：${r.stderr}`);
  const S = JSON.parse(r.stdout).samples;
  const n = Math.max(1, S.length);
  const ok = S.filter((x) => x.ok);
  const visible = ok.filter((x) => x.joints.filter(Boolean).length >= 7);
  const centered = ok.filter((x) => Math.abs(x.neck[0] - 0.5) <= 0.15);
  const tor = ok.map((x) => x.torso).sort((a, b) => a - b);
  const q = (f) => tor[Math.min(tor.length - 1, Math.floor(tor.length * f))] || 0;
  const spread = tor.length ? q(0.9) / Math.max(q(0.1), 0.01) : 9; // 大小 90 分位 / 10 分位，越接近 1 景别越稳
  // 内部剪辑：画面整体突变的次数（多机位、精剪会很多；直拍正常只有灯光变化）
  const sc = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-vf', "scale=320:-2,select='gt(scene,0.45)',showinfo", '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const cuts = (sc.stderr.match(/pts_time:/g) || []).length;
  const dur = duration(file);
  const cutsPerMin = r3(cuts / Math.max(dur / 60, 0.1));
  const pr = probe(file).streams.find((x) => x.codec_type === 'video') || {};
  const m = { found: r3(ok.length / n), visible: r3(visible.length / n), centered: r3(centered.length / n), sizeSpread: r3(spread), cutsPerMin, size: `${pr.width}×${pr.height}` };
  // 综合分：0–100
  // 景别稳定、没有内部剪辑最要紧（统一大小、对齐全靠它），其次是在中间、不被挡
  const score = Math.round(100 * (0.15 * m.found + 0.25 * m.visible + 0.25 * m.centered + 0.2 * Math.max(0, Math.min(1, 1 - (spread - 1.2) / 0.8)) + 0.15 * Math.max(0, 1 - cutsPerMin / 5)));
  const why = [];
  if (m.centered < 0.6) why.push('他常常不在画面中间');
  if (m.visible < 0.6) why.push('经常被挡或认不全');
  if (spread > 1.6) why.push('景别忽远忽近（可能是多机位或推拉很多）');
  if (cutsPerMin > 3) why.push('疑似多机位或精剪（内部切换多）');
  if (pr.height && pr.height < 1080 && pr.width < 1920) why.push('分辨率偏低');
  return { score, verdict: score >= 70 && !why.length ? '适合' : score >= 55 ? '能用但一般' : '不适合', why, ...m };
}

// ---------- 成片核对：量成片里每个切点前后他的位置、大小，找出跳位的刀和被挡的时段 ----------
function checkVideo(spec, dir, video, table) {
  const lock = spec.lock || {};
  const tx = lock.x ?? 0.5, ty = lock.y ?? 0.3;
  const len = duration(video);
  const job = path.join(os.tmpdir(), `check-job-${process.pid}.json`);
  fs.writeFileSync(job, JSON.stringify({ file: video, step: 1 / 15, fpEvery: 1000000 }));
  const r = spawnSync(poseBin(), [job], { maxBuffer: 1 << 30, encoding: 'utf8' });
  fs.rmSync(job, { force: true });
  if (r.status !== 0) die(`成片骨架提取失败：${r.stderr}`);
  // 成片里他应该在锁定的位置附近：每帧取离锁定位置最近的那个人（偏太远就当认不出）
  const S = JSON.parse(r.stdout).samples.map((x) => {
    const c = x.c.map((c) => ({ c, d: Math.hypot((c.neck[0] - tx) * 16 / 9, c.neck[1] - ty) })).filter((o) => o.d < 0.35).sort((p, q) => p.d - q.d)[0]?.c;
    return c ? { t: x.t, ok: true, neck: c.neck, torso: c.torso, joints: c.joints } : { t: x.t, ok: false };
  });
  const at = (t) => S.reduce((b, x) => (Math.abs(x.t - t) < Math.abs(b.t - t) ? x : b), S[0]);
  const vis = (x) => x?.ok && x.joints.filter(Boolean).length >= (lock.minJoints ?? 7);
  const jumps = [];
  for (const c of table.slice(1)) {
    const a = at(c.out - 0.1), b = at(c.out + 0.1);
    if (!a?.ok || !b?.ok) { jumps.push({ out: c.out, src: c.src, why: '切点前后认不出他' }); continue; }
    const dx = (b.neck[0] - a.neck[0]) * 16 / 9, dy = b.neck[1] - a.neck[1], d = Math.hypot(dx, dy);
    const ratio = Math.max(a.torso, b.torso) / Math.min(a.torso, b.torso);
    if (d > (spec.checkJump ?? 0.08) || ratio > 1.3) jumps.push({ out: c.out, src: c.src, jump: r3(d), size: r3(ratio), why: d > 0.08 ? '位置跳了' : '大小跳了' });
  }
  // 连续 1 秒以上认不出或者被挡住
  const blocked = [];
  let start = null;
  for (const x of S) {
    if (!vis(x)) { if (start == null) start = x.t; }
    else if (start != null) { if (x.t - start >= 1) blocked.push([r3(start), r3(x.t)]); start = null; }
  }
  if (start != null && len - start >= 1) blocked.push([r3(start), r3(len)]);
  return { cuts: table.length, jumps, blocked };
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
    for (const c of [active, ...inside].filter(Boolean)) segs.push({ c, piece: p, out: p.out + Math.max(0, c.at - p.from), isStart: c.at >= p.from - 0.001 });
  }
  const list = [];
  const table = [];
  const joined = path.join(tmp, 'joined.mp4');
  const lock = spec.lock ? { transition: 'dissolve', frames: 6, ...(spec.lock === true ? {} : spec.lock) } : null;
  if (lock) {
    // 原地换装：交给 lockfx 逐帧锁定主角、处理背景、做过渡，直接出整条无声画面
    scanPeople(spec, dir);
    const motion = posesOf(spec, dir);
    const jobSegs = [];
    // 统一调色：各片段在用到的时段里的平均颜色，拉到同一个目标（lockfx 和分身阵列用同一套增益，不会在进出阵列时跳色）
    const gains = lock.grade ?? lock.mode === 'cut' ? gradeGains(spec, dir, segs, fps, total) : null;
    for (let k = 0; k < segs.length; k++) {
      const { c, piece } = segs[k];
      const s = srcs.get(c.src) || die(`切点 ${c.at} 用了不存在的片段 ${c.src}`);
      const f0 = Math.round(segs[k].out * fps);
      const f1 = k + 1 < segs.length ? Math.round(segs[k + 1].out * fps) : total;
      if (f1 <= f0) continue;
      const st = piece.from + (f0 / fps - piece.out) + (c.offset ?? s.offset) + (c.nudge || 0);
      const dur = (f1 - f0) / fps;
      const tr = JSON.parse(fs.readFileSync(path.join(dir, 'track', `${s.id}.json`), 'utf8')).samples
        .filter((x) => x.ok && x.w != null && x.t >= st - 0.3 && x.t <= st + dur + 0.5).map((x) => [r3(x.t - st), x.cx, x.cy, x.w, x.h]);
      const mid = tr.length ? tr[Math.floor(tr.length / 2)] : null;
      if (c.array && segs[k].isStart) {
        const clip = path.join(tmp, `array-${k}.mp4`);
        const zOf = (cut, a, b) => {
          const so = srcs.get(cut.src), xs = motion[so.id].samples.filter((x) => x.ok && x.t >= a + (cut.offset ?? so.offset) && x.t <= b + (cut.offset ?? so.offset)).map((x) => x.torso).sort((p, q) => p - q);
          const [sw0, sh0] = videoSize(path.resolve(dir, so.file)), s0 = Math.max(W / sw0, H / sh0);
          const p75 = (xs[Math.floor(xs.length * 0.75)] ?? 0.3) * sh0;
          return s0 * Math.min(lock.zoomMax ?? 1.45, Math.max(lock.zoomMin ?? 1.1, (spec.lock.torso * H) / (p75 * s0)));
        };
        const prevCut = segs[k - 1]?.c, nextCut = segs[k + 1]?.c;
        const tAt = piece.from + (f0 / fps - piece.out);
        const fr = (t) => Math.round((t - tAt) * fps);
        const wins = c.array.windows;
        const aj = {
          out: clip, size: [W, H], fps, frames: f1 - f0, y: lock.y ?? 0.3, fullTorso: spec.lock.torso, colTorso: c.array.colTorso ?? 0.3, tr: Math.round(fps * 0.4),
          ...(spec.theme?.colors ? { theme: spec.theme.colors } : {}), ...(gains ? { gains } : {}),
          windows: wins.map((w, wi) => ({
            from: Math.max(0, fr(w.from)), to: wi + 1 < wins.length ? fr(wins[wi + 1].from) - 1 : f1 - f0 - 1,
            cols: w.cols.map((cl) => {
              const so = srcs.get(cl.src), start = tAt + cl.offset;
              const scale = wi === 0 && prevCut ? zOf(prevCut, prevCut.at, tAt) : wi === wins.length - 1 && nextCut ? zOf(nextCut, nextCut.at, Math.min(to, nextCut.at + 4)) : undefined;
              return { file: path.resolve(dir, so.file), start: r3(start), ...(scale ? { scale } : {}), necks: motion[so.id].samples.filter((x) => x.ok && x.t >= start + w.from - tAt - 0.5 && x.t <= start + w.to - tAt + 1).map((x) => [r3(x.t - start), x.neck[0], x.neck[1], x.torso]) };
            }),
          })),
        };
        fs.writeFileSync(path.join(tmp, `array-${k}.json`), JSON.stringify(aj));
        const ar = spawnSync(arrayBin(), [path.join(tmp, `array-${k}.json`)], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
        if (ar.status !== 0) die('分身阵列渲染失败');
        jobSegs.push({ file: clip, start: 0, frames: f1 - f0, hint: null, track: [], necks: [], free: true, array: true, strong: false, keep: [], fx: { type: 'cut', frames: 1 } });
        table.push({ at: r3(tAt), out: r3(f0 / fps), dur: r3(dur), src: 'stage:' + c.array.windows.map((w) => w.cols.map((x) => x.src).join('+')).join('>'), srcTime: 0, label: '舞台段' });
        continue;
      }
      const necks = motion ? motion[s.id].samples.filter((x) => x.ok && x.t >= st - 0.4 && x.t <= st + dur + 0.6).map((x) => [r3(x.t - st), x.neck[0], x.neck[1]]) : [];
      jobSegs.push({ file: path.resolve(dir, s.file), start: r3(st), frames: f1 - f0, hint: mid ? { cx: mid[1], cy: mid[2] } : null, track: tr, necks, free: !!c.free, strong: !!(c.pinned || (lock.strongEvery && jobSegs.length % lock.strongEvery === 0)), keep: s.keep || [],
        ...(c.fx && segs[k].isStart ? { fx: c.fx } : spec.cuts.some((x) => x.fx) ? { fx: { type: 'cut', frames: 1 } } : {}) });
      table.push({ at: r3(piece.from + (f0 / fps - piece.out)), out: r3(f0 / fps), dur: r3(dur), src: c.src, srcTime: r3(st), label: c.label ?? s.label ?? '' });
    }
    const job = {
      size: [W, H], fps, out: joined,
      target: { x: lock.x ?? 0.5, y: lock.y ?? 0.3, ...(lock.torso ? { torso: lock.torso } : {}) }, // torso：plan 按动作挑场次时算好的统一大小
      zoomMin: lock.zoomMin ?? 1.1, zoomMax: lock.zoomMax ?? 1.45, smooth: lock.smooth ?? 0.3,
      // 背景虚化：全程锁定默认开（旧版本的效果），换装瞬间对齐默认关（保留舞台）
      background: lock.background === false || (lock.background === undefined && lock.mode === 'cut') ? null : { blur: 14, dim: 0.55, desat: 0.35, ...(lock.background || {}) },
      mode: lock.mode || 'full', ease: lock.ease ?? 0.5, grade: lock.grade ?? lock.mode === 'cut', matchCut: lock.matchCut ?? (lock.mode === 'cut' ? 3 : 0),
      flash: { light: 0.6, strong: 1.5, frames: 5, punch: 0.06, ...(lock.flash || {}) },
      transition: { type: lock.transition, frames: lock.frames },
      ...(spec.theme?.colors ? { theme: { colors: spec.theme.colors } } : {}),
      ...(gains ? { gains } : {}),
      segments: jobSegs,
    };
    fs.writeFileSync(path.join(tmp, 'job.json'), JSON.stringify(job));
    const r = spawnSync(lockfxBin(), [path.join(tmp, 'job.json')], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
    if (r.status !== 0) die('原地换装渲染失败（lockfx）');
    const rep = JSON.parse(r.stdout);
    fs.mkdirSync(path.join(dir, 'review'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'review', 'lock-report.json'), JSON.stringify(rep, null, 1));
  }
  for (let k = 0; !lock && k < segs.length; k++) {
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
  if (!lock) {
    fs.writeFileSync(path.join(tmp, 'list.txt'), list.join('\n'));
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-c', 'copy', joined]);
  }

  // 片头片尾字、整体标题
  const overlays = [];
  // 原地换装的场次小字在这里统一画（普通路线是每段各自画）
  if (lock && spec.labels !== false && FONT) {
    for (const [i, x] of table.entries()) {
      if (!x.label || (i > 0 && table[i - 1].label === x.label)) continue;
      let j = i; while (j + 1 < table.length && table[j + 1].label === x.label) j++;
      overlays.push(`drawtext=fontfile='${FONT}':text='${esc(x.label)}':x=${Math.round(W * 0.03)}:y=h-${Math.round(H * 0.075)}-th:fontsize=${Math.round(H * 0.03)}:fontcolor=white@0.92:shadowcolor=black@0.6:shadowx=2:shadowy=2:enable='between(t,${x.out},${r3(table[j].out + table[j].dur)})'`);
    }
  }
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
  // 转场体检：各类转场用了几次、特效占比、同一种有没有连用
  const fxs = [...spec.cuts].sort((a, b) => a.at - b.at).map((c) => c.fx?.type || 'cut');
  const fxCount = fxs.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {});
  const BASIC = ['cut', 'dissolve', 'morph']; // 人形变形是换装的基本衔接，不算特效
  const specialN = fxs.filter((t) => !BASIC.includes(t)).length;
  const repeats = fxs.filter((t, i) => i > 0 && t === fxs[i - 1] && !BASIC.includes(t)).length;
  return { out, duration: r3(len), cuts: table.length, perSource: Object.fromEntries([...srcs.keys()].map((id) => [id, table.filter((x) => x.src === id).length])),
    fx: { count: fxCount, specialShare: r3(specialN / Math.max(1, fxs.length)), repeats, ok: specialN / Math.max(1, fxs.length) <= 0.25 && repeats === 0 } };
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
} else if (cmd === 'vet') {
  if (!o.file) die('用法：montage.mjs vet --file <素材.mp4>（直拍体检：适不适合做贴合换装）');
  console.log(JSON.stringify(vetFootage(path.resolve(o.file))));
} else if (cmd === 'schedule') {
  if (!o.spec) die('用法：montage.mjs schedule --spec montage.json（全局挑换装点，写进 cuts）');
  const file = path.resolve(o.spec); const dir = path.dirname(file);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of spec.sources) s.duration ??= duration(path.resolve(dir, s.file));
  const r = schedule(spec, dir);
  fs.writeFileSync(file, JSON.stringify(spec, null, 1));
  console.log(JSON.stringify(r));
} else if (cmd === 'check') {
  if (!o.spec) die('用法：montage.mjs check --spec montage.json [--video renders/video.mp4] [--cuts renders/video-cuts.json]');
  const file = path.resolve(o.spec); const dir = path.dirname(file);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const video = path.resolve(dir, o.video || 'renders/video.mp4');
  const table = JSON.parse(fs.readFileSync(path.resolve(dir, o.cuts || video.replace(/\.mp4$/, '-cuts.json')), 'utf8'));
  console.log(JSON.stringify(checkVideo(spec, dir, video, table), null, 1));
} else if (cmd === 'fx') {
  if (!o.spec) die('用法：montage.mjs fx --spec montage.json（按段落地图重新给每一刀挑转场，切点不动）');
  const file = path.resolve(o.spec);
  const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = assignFx(spec);
  fs.writeFileSync(file, JSON.stringify(spec, null, 1));
  console.log(JSON.stringify(r));
} else if (cmd === 'sections') {
  if (!o.master) die('用法：montage.mjs sections --master <音轨来源> [--from 秒] [--to 秒]');
  const r = sections(o.master, { from: Number(o.from) || 0, to: o.to ? Number(o.to) : Infinity });
  console.log(JSON.stringify({ ...r, bars: `${r.bars.length} 小节（第一个强拍 ${r.firstDownbeat}s）`, phrases: o.all ? r.phrases : `${r.phrases.length} 句（加 --all 列出）` }, null, 1));
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
    if (p.structureMap) spec.structureMap = p.structureMap;
    if (spec.structure && spec.fx !== false) console.log('转场：' + JSON.stringify(assignFx(spec)));
    fs.writeFileSync(file, JSON.stringify(spec, null, 1));
    console.log(`排好 ${p.cuts.length} 个切点（${p.beats.bpm} BPM），写回 ${o.spec}`);
    if (cmd === 'plan') process.exit(0);
  }
  console.log(JSON.stringify(render(spec, dir, path.resolve(dir, o.out || 'renders/video.mp4')), null, 1));
} else {
  die('用法：montage.mjs align|beats|plan|render（见文件开头说明）');
}
