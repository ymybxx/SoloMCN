#!/usr/bin/env node
// 代码合成配乐和音效：不用采样、不联网、不花钱，同一份参数每次生成的音频逐字节一致。
// 用法：node synth-bgm.mjs --spec bgm.json --out-dir assets/audio
// 输出：
//   bgm.wav            配乐，响度对齐到 -14 LUFS（和曲库音乐一样响），混音时按曲库音乐的音量用
//   sfx-NN-<名字>.wav   每个音效一个文件
//   bgm.json           节拍网格、各段实际起点、音效清单，以及可以直接并进 audio_meta.json 的条目
// 参数文件的写法见 explainer-video 技能的 references/bgm.md。
import fs from 'node:fs';
import path from 'node:path';

const SR = 48000;
const TAU = Math.PI * 2;

function fail(msg) { console.error(msg); process.exit(1); }
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

// ---------- 情绪预设：调式、速度、和弦进行、音色 ----------
// 和弦进行写音阶级数（0 = 主和弦）；'4+' 表示把三音升高半音（小调里的属和弦变大三和弦）
const MOODS = {
  tech:    { mode: 'minor', bpm: 112, prog: [0, 5, 2, 6], seventh: true, cutoff: 1800, arp: 16, drums: 'four', lead: 'pluck', bass: 'saw' },
  upbeat:  { mode: 'major', bpm: 120, prog: [0, 4, 5, 3], seventh: false, cutoff: 2600, arp: 8, drums: 'pop', lead: 'keys', bass: 'saw' },
  calm:    { mode: 'major', bpm: 84, prog: [0, 5, 3, 4], seventh: true, cutoff: 1400, arp: 8, drums: 'soft', lead: 'keys', bass: 'sine' },
  tense:   { mode: 'minor', bpm: 96, prog: [0, 5, 3, '4+'], seventh: false, cutoff: 1100, arp: 16, drums: 'pulse', lead: 'pluck', bass: 'saw' },
  playful: { mode: 'major', bpm: 128, prog: [0, 3, 4, 0], seventh: false, cutoff: 3000, arp: 8, drums: 'bounce', lead: 'pluck', bass: 'square' },
};
const SCALES = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] };
const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

// 鼓的节奏型：一小节 16 个十六分音符位置，按能量级分
const DRUMS = {
  four:   { 2: { kick: [0, 4, 8, 12], hat: [2, 6, 10, 14] }, 3: { kick: [0, 4, 8, 12], clap: [4, 12], hat: [2, 6, 10, 14], hat16: true } },
  pop:    { 2: { kick: [0, 8], hat: [0, 2, 4, 6, 8, 10, 12, 14] }, 3: { kick: [0, 8, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] } },
  soft:   { 2: { kick: [0], shaker: [2, 6, 10, 14] }, 3: { kick: [0, 8], snare: [12], shaker: [0, 2, 4, 6, 8, 10, 12, 14] } },
  pulse:  { 2: { kick: [0, 8], tick: [0, 2, 4, 6, 8, 10, 12, 14] }, 3: { kick: [0, 3, 8, 11], snare: [8], tick: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] } },
  bounce: { 2: { kick: [0, 6, 8], hat: [2, 6, 10, 14] }, 3: { kick: [0, 6, 8], clap: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] } },
};
const BASS_STEPS = {
  four: { 2: [0, 4, 8, 12], 3: [2, 6, 10, 14] },
  pop: { 2: [0, 8], 3: [0, 6, 8, 14] },
  soft: { 2: [0], 3: [0, 8] },
  pulse: { 2: [0, 2, 4, 6, 8, 10, 12, 14], 3: [0, 2, 4, 6, 8, 10, 12, 14] },
  bounce: { 2: [0, 6, 8], 3: [0, 3, 6, 8, 11, 14] },
};

// 音效：名字 -> 默认音量（混音里的 volume）
const SFX = {
  impact: 0.5, boom: 0.5, whoosh: 0.4, riser: 0.4, ding: 0.35, success: 0.35,
  pop: 0.35, tick: 0.35, typing: 0.3, glitch: 0.35, buzz: 0.35, shutter: 0.35,
};

// ---------- 读参数 ----------
const specPath = arg('--spec');
const outDir = arg('--out-dir');
if (!specPath || !outDir) fail('用法：node synth-bgm.mjs --spec bgm.json --out-dir assets/audio');
let spec;
try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); } catch (e) { fail(`读不了参数文件：${e.message}`); }

const preset = MOODS[spec.mood || 'tech'];
if (!preset) fail(`mood 只能是：${Object.keys(MOODS).join('、')}`);
const frames = Array.isArray(spec.frames) ? spec.frames.map(Number) : null;
if (frames && frames.some((d) => !(d > 0))) fail('frames 是每个镜头的时长（秒），都要大于 0');
const frameStarts = frames ? frames.reduce((a, d) => [...a, a[a.length - 1] + d], [0]) : null;
const duration = Number(spec.duration) || (frames ? frameStarts[frameStarts.length - 1] : 0);
if (!(duration > 0 && duration <= 600)) fail('duration 要写成片总时长（秒，最长 600），或者给 frames');

// 时间可以写 at（全片第几秒），也可以写 frame（第几个镜头，从 1 开始）加 offset（镜头内第几秒）
function timeOf(x, what) {
  if (x.at != null) return Number(x.at);
  if (x.frame != null) {
    if (!frameStarts) fail(`${what} 用了 frame，参数里要给 frames`);
    const f = Number(x.frame);
    if (!(f >= 1 && f <= frames.length)) fail(`${what} 的 frame ${x.frame} 超出了镜头数 ${frames.length}`);
    return frameStarts[f - 1] + Number(x.offset || 0);
  }
  fail(`${what} 要写 at 或 frame`);
}

const mode = spec.mode || preset.mode;
if (!SCALES[mode]) fail('mode 只能是 major 或 minor');
const keyPc = PC[spec.key || (mode === 'minor' ? 'D' : 'C')];
if (keyPc == null) fail(`key 写音名，例如 C、D、F#、Bb`);
const bpm = Number(spec.bpm) || preset.bpm;
if (!(bpm >= 60 && bpm <= 180)) fail('bpm 要在 60 到 180 之间');
const BEAT = 60 / bpm, BAR = BEAT * 4, STEP = BEAT / 4;

// ---------- 随机数（只用种子，结果固定） ----------
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(Number(spec.seed) || 1);
const noise = () => rng() * 2 - 1;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

// ---------- 滤波器 ----------
function biquad(type, f, q = 0.707) {
  const w = (TAU * Math.min(Math.max(f, 10), SR * 0.45)) / SR, c = Math.cos(w), s = Math.sin(w), a = s / (2 * q);
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
  else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
  else { b0 = a; b1 = 0; b2 = -a; }
  const a0 = 1 + a;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * c) / a0, a2: (1 - a) / a0, x1: 0, x2: 0, y1: 0, y2: 0 };
}
function retune(flt, type, f, q) { Object.assign(flt, { ...biquad(type, f, q), x1: flt.x1, x2: flt.x2, y1: flt.y1, y2: flt.y2 }); }
function run(f, x) { const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2; f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y; return y; }

// ---------- 混音总线 ----------
function bus(n) { return { L: new Float32Array(n), R: new Float32Array(n), send: new Float32Array(n) }; }
function put(b, start, mono, gain, pan = 0, send = 0) {
  const s0 = Math.round(start * SR), gl = gain * Math.cos(((pan + 1) * Math.PI) / 4), gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < mono.length; i++) {
    const k = s0 + i;
    if (k < 0) continue;
    if (k >= b.L.length) break;
    b.L[k] += mono[i] * gl; b.R[k] += mono[i] * gr;
    if (send) b.send[k] += mono[i] * gain * send;
  }
}
function putStereo(b, start, [l, r], gain, send = 0) {
  const s0 = Math.round(start * SR);
  for (let i = 0; i < l.length; i++) {
    const k = s0 + i;
    if (k < 0) continue;
    if (k >= b.L.length) break;
    b.L[k] += l[i] * gain; b.R[k] += r[i] * gain;
    if (send) b.send[k] += (l[i] + r[i]) * 0.5 * gain * send;
  }
}

// 简化的 Freeverb：每声道 4 个梳状滤波 + 2 个全通
function reverb(b, size = 1, wet = 0.3) {
  const sc = (SR / 44100) * size;
  const chan = (offset, out) => {
    const combs = [1557, 1617, 1491, 1422].map((d) => ({ buf: new Float32Array(Math.round((d + offset) * sc)), i: 0, lp: 0 }));
    const aps = [556, 441].map((d) => ({ buf: new Float32Array(Math.round((d + offset) * (SR / 44100))), i: 0 }));
    for (let k = 0; k < b.send.length; k++) {
      const x = b.send[k] * 0.25;
      let y = 0;
      for (const c of combs) { const v = c.buf[c.i]; c.lp = v * 0.75 + c.lp * 0.25; c.buf[c.i] = x + c.lp * 0.82; c.i = (c.i + 1) % c.buf.length; y += v; }
      for (const a of aps) { const v = a.buf[a.i]; const o = -y + v; a.buf[a.i] = y + v * 0.5; a.i = (a.i + 1) % a.buf.length; y = o; }
      out[k] += y * wet;
    }
  };
  chan(0, b.L); chan(23, b.R);
}

// ---------- 乐器 ----------
const saw = (p) => 2 * p - 1;
function envAR(i, att, hold, rel) { return i < att ? i / att : i < hold ? 1 : Math.max(0, 1 - (i - hold) / rel); }

function pad(freq, dur, cutoff) {
  const n = Math.floor((dur + 1.2) * SR), L = new Float32Array(n), R = new Float32Array(n);
  const fs_ = [-0.11, 0, 0.12].map((c) => freq * 2 ** (c / 12)), ph = fs_.map(() => rng());
  const fl = biquad('lp', cutoff, 0.6), fr = biquad('lp', cutoff, 0.6);
  const att = 0.35 * SR, hold = dur * SR, rel = 1.2 * SR;
  for (let i = 0; i < n; i++) {
    const e = envAR(i, att, hold, rel) ** 1.5;
    const s = ph.map((p, j) => { ph[j] = (p + fs_[j] / SR) % 1; return saw(p); });
    L[i] = run(fl, (s[0] + 0.6 * s[1]) * e); R[i] = run(fr, (s[2] + 0.6 * s[1]) * e);
  }
  return [L, R];
}
// 减法合成的拨弦：滤波器从亮到暗，音准准确
function pluck(freq, dur, bright = 4000) {
  const n = Math.floor((dur + 0.4) * SR), out = new Float32Array(n), f = biquad('lp', bright, 1.1);
  let p1 = rng(), p2 = rng();
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if (i % 32 === 0) retune(f, 'lp', 350 + bright * Math.exp(-t * 14), 1.1);
    p1 = (p1 + freq / SR) % 1; p2 = (p2 + (freq * 1.004) / SR) % 1;
    const osc = saw(p1) * 0.6 + (p2 < 0.5 ? 0.4 : -0.4);
    const e = Math.min(1, i / (0.003 * SR)) * Math.exp(-t * 5) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.08) : 1);
    out[i] = run(f, osc) * e;
  }
  return out;
}
// FM 电钢琴（ratio 1）或钟（ratio 3.5）
function fm(freq, dur, ratio = 1, index = 1.6, decay = 2.5) {
  const n = Math.floor((dur + 1.5) * SR), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR, I = index * Math.exp(-t * 4) + 0.15;
    const e = Math.min(1, i / (0.004 * SR)) * Math.exp(-t * decay) * (t > dur ? Math.max(0, 1 - (t - dur) / 0.6) : 1);
    out[i] = Math.sin(TAU * freq * t + I * Math.sin(TAU * freq * ratio * t)) * e;
  }
  return out;
}
function bass(freq, dur, kind) {
  const n = Math.floor((dur + 0.15) * SR), out = new Float32Array(n), f = biquad('lp', 650, 0.8);
  let p = 0;
  for (let i = 0; i < n; i++) {
    p = (p + freq / SR) % 1;
    const s = Math.sin(TAU * p);
    const osc = kind === 'saw' ? s * 0.8 + saw(p) * 0.45 : kind === 'square' ? s * 0.6 + (p < 0.5 ? 0.35 : -0.35) : s + 0.15 * Math.sin(2 * TAU * p);
    out[i] = run(f, osc) * envAR(i, 0.004 * SR, dur * SR, 0.1 * SR);
  }
  return out;
}
function kick(soft = false) {
  const n = Math.floor(0.45 * SR), out = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; ph += (48 + (soft ? 70 : 120) * Math.exp(-t * 35)) / SR;
    out[i] = Math.tanh(1.5 * (Math.sin(TAU * ph) * Math.exp(-t * 6.5) + noise() * Math.exp(-t * 400) * (soft ? 0.1 : 0.3)));
  }
  return out;
}
function noiseHit(type, f, q, decay, dur, tone = 0) {
  const n = Math.floor(dur * SR), out = new Float32Array(n), flt = biquad(type, f, q);
  for (let i = 0; i < n; i++) { const t = i / SR; out[i] = run(flt, noise()) * Math.exp(-t * decay) + (tone ? Math.sin(TAU * tone * t) * Math.exp(-t * 30) * 0.5 : 0); }
  return out;
}
const snare = () => noiseHit('bp', 1800, 0.7, 20, 0.25, 190);
const hat = (open = false) => noiseHit('hp', 7500, 0.7, open ? 14 : 70, open ? 0.3 : 0.06);
const shaker = () => noiseHit('bp', 6000, 1.5, 45, 0.07);
const tickHit = () => noiseHit('bp', 3500, 2, 300, 0.03);
const crash = () => noiseHit('hp', 5000, 0.5, 2.2, 2.2);
function clap() {
  const n = Math.floor(0.3 * SR), out = new Float32Array(n), flt = biquad('bp', 1200, 1.2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e = 0;
    for (const t0 of [0, 0.011, 0.022]) if (t >= t0) e = Math.max(e, Math.exp(-(t - t0) * 180));
    if (t >= 0.022) e = Math.max(e, Math.exp(-(t - 0.022) * 16) * 0.6);
    out[i] = run(flt, noise()) * e * 2;
  }
  return out;
}

// ---------- 和声 ----------
const scale = SCALES[mode];
const deg = (i) => 12 * Math.floor(i / 7) + scale[((i % 7) + 7) % 7];
function chordTones(d) {
  const raise = String(d).endsWith('+'), r = parseInt(d, 10);
  const tones = [r, r + 2, r + 4, ...(preset.seventh ? [r + 6] : [])].map(deg);
  if (raise) tones[1] += 1;
  return tones.map((x) => x + keyPc);
}
const inRange = (pcs, lo, hi) => { const out = []; for (let m = lo; m < hi; m++) if (pcs.some((p) => ((m - p) % 12 + 12) % 12 === 0)) out.push(m); return out; };
function voicing(d) {
  const t = chordTones(d), pcs = t.map((x) => ((x % 12) + 12) % 12);
  const root = pcs[0];
  return {
    pad: t.map((x) => { let m = 55 + ((((x - 55) % 12) + 12) % 12); return m; }),
    bass: 36 + ((((root - 36) % 12) + 12) % 12),
    arp: inRange(pcs, 62, 86),
    lead: inRange(pcs, 72, 88),
  };
}

// ---------- 段落（能量曲线） ----------
// energy：-1 停（空一段制造停顿），0 只有铺底，1 加琶音和低音，2 加鼓和旋律，3 全开
// 段落起点吸到拍子上：离小节线很近就吸到小节线，否则吸到最近的一拍，误差不超过半拍；不和前一段吸到同一点
function snap(t, prev) {
  const kb = Math.round(t / BAR) * BAR, kt = Math.round(t / BEAT) * BEAT;
  if (Math.abs(kb - t) <= Math.min(0.25, BAR / 8) && kb > prev + 1e-6) return kb;
  if (kt > prev + 1e-6) return kt;
  return prev + BEAT;
}
const rawSections = Array.isArray(spec.sections) && spec.sections.length ? spec.sections : [{ at: 0, energy: 1 }, { at: BAR * 2, energy: 2 }];
const sections = rawSections.map((s, i) => {
  const e = Number(s.energy);
  if (![-1, 0, 1, 2, 3].includes(e)) fail(`sections 第 ${i + 1} 段的 energy 只能是 -1、0、1、2、3`);
  return { requested: +timeOf(s, `sections 第 ${i + 1} 段`).toFixed(3), energy: e };
}).sort((a, b) => a.requested - b.requested);
sections.forEach((s, i) => { s.at = +(i === 0 ? Math.max(0, snap(s.requested, -1)) : snap(s.requested, sections[i - 1].at)).toFixed(3); });
const energyAt = (t) => { let e = sections[0].at <= t + 1e-6 ? sections[0].energy : -1; for (const s of sections) if (s.at <= t + 1e-6) e = s.energy; return e; };

// ---------- 结尾 ----------
const endMode = spec.end || 'ring';
if (!['ring', 'stop', 'fade'].includes(endMode)) fail('end 只能是 ring（落一个主和弦余音）、stop（卡点急停）、fade（淡出）');
const musicEnd = Math.min(spec.stop != null ? Number(spec.stop) : duration, duration);
let lastT = musicEnd, ringT = null;
if (endMode === 'ring') {
  ringT = Math.floor((musicEnd - 1.2) / BAR) * BAR;
  if (ringT < musicEnd - BAR - 1.2) ringT += BAR;
  ringT = Math.max(0, ringT);
  lastT = ringT;
} else if (endMode === 'stop') lastT = Math.max(BEAT, Math.round(musicEnd / BEAT) * BEAT);

// ---------- 编曲 ----------
const N = Math.ceil((duration + 0.5) * SR);
const M = bus(N);
const motifIdx = [0, ...[0, 1, 2].map(() => Math.floor(rng() * 4))];
const motifRhythm = [[0, 2, 4, 8], [0, 3, 6, 8], [0, 4, 6, 10]][Math.floor(rng() * 3)];
const style = preset.drums;
let arpCount = 0;
const human = () => (rng() - 0.5) * 0.006;
const vel = (base) => base * (0.9 + rng() * 0.2);

for (let s = 0; s * STEP < lastT - 1e-6; s++) {
  const t = s * STEP, pos = s % 16, barIdx = Math.floor(s / 16), e = energyAt(t);
  if (e < 0) continue;
  const v = voicing(preset.prog[barIdx % preset.prog.length]);
  const barEnd = Math.min((barIdx + 1) * BAR, lastT);
  // 铺底：每小节一个和弦；从停顿里回来时在当拍补上
  if (pos === 0 || (pos % 4 === 0 && energyAt(t - BEAT) < 0)) {
    const cut = preset.cutoff * (e >= 3 ? 1.5 : e === 0 ? 0.7 : 1);
    for (const m of v.pad) putStereo(M, t, pad(mtof(m), barEnd - t, cut), e === 0 ? 0.12 : 0.1, 0.35);
  }
  // 低音
  if (e === 1 && pos === 0) put(M, t, bass(mtof(v.bass), (barEnd - t) * 0.9, preset.bass), 0.32);
  if (e >= 2 && BASS_STEPS[style][e].includes(pos)) put(M, t, bass(mtof(v.bass), STEP * (style === 'pulse' ? 1.6 : 3), preset.bass), 0.34);
  // 琶音
  const arpEvery = e >= 2 && preset.arp === 16 ? 1 : 2;
  if (e >= 1 && pos % arpEvery === 0) {
    const seq = [...v.arp, ...v.arp.slice(1, -1).reverse()];
    const m = seq[arpCount++ % seq.length];
    put(M, t + human(), pluck(mtof(m), STEP * arpEvery * 0.9, 2500 + e * 600), vel(e >= 2 ? 0.12 : 0.1), (arpCount % 2 ? -0.35 : 0.35), 0.3);
  }
  // 旋律动机：能量 2 每两小节一次，能量 3 每小节一次
  if (e >= 2 && (e === 3 || barIdx % 2 === 0)) {
    const k = motifRhythm.indexOf(pos);
    if (k >= 0 && v.lead.length) {
      const m = v.lead[motifIdx[k] % v.lead.length];
      const len = (k < 3 ? motifRhythm[k + 1] - pos : 6) * STEP;
      const note = preset.lead === 'keys' ? fm(mtof(m), len, 1, 1.6, 2.2) : pluck(mtof(m), len, 3200);
      put(M, t, note, preset.lead === 'keys' ? 0.16 : 0.13, 0.1, 0.4);
    }
  }
  // 鼓
  if (e >= 2) {
    const d = DRUMS[style][e];
    if (d.kick?.includes(pos)) put(M, t, kick(style === 'soft'), style === 'soft' ? 0.55 : 0.8);
    if (d.snare?.includes(pos)) put(M, t + human(), snare(), 0.32, 0.05, 0.2);
    if (d.clap?.includes(pos)) put(M, t + human(), clap(), 0.3, -0.05, 0.25);
    if (d.hat?.includes(pos) || (d.hat16 && pos % 2 === 1)) put(M, t + human(), hat(false), vel(d.hat16 && pos % 2 === 1 ? 0.06 : 0.1), 0.25, 0.05);
    if (d.shaker?.includes(pos)) put(M, t + human(), shaker(), vel(0.09), -0.3, 0.05);
    if (d.tick?.includes(pos)) put(M, t + human(), tickHit(), vel(pos % 4 === 0 ? 0.12 : 0.07), 0.3);
  }
}

// 结尾
const fadeMask = (from, len) => { const a = Math.round(from * SR), l = Math.round(len * SR); for (let k = a; k < N; k++) { const g = k < a + l ? 1 - (k - a) / l : 0; M.L[k] *= g; M.R[k] *= g; M.send[k] *= g; } };
if (endMode === 'ring') {
  const v = voicing(preset.prog[0]), ringDur = Math.max(0.8, duration - ringT - 0.3);
  for (const m of v.pad) putStereo(M, ringT, pad(mtof(m), ringDur * 0.5, preset.cutoff), 0.1, 0.4);
  put(M, ringT, bass(mtof(v.bass), ringDur * 0.5, preset.bass), 0.3);
  put(M, ringT, fm(mtof(v.lead[0] ?? 76), ringDur * 0.6, 1, 1.4, 1.2), 0.16, 0, 0.5);
  put(M, ringT, kick(), 0.7);
  put(M, ringT, crash(), 0.12, 0.2, 0.3);
} else if (endMode === 'stop') {
  fadeMask(lastT, 0.015);
  put(M, lastT, kick(), 0.8);
  put(M, lastT, crash(), 0.14, 0.2, 0.3);
}
reverb(M, 1, 0.32);
if (endMode === 'fade') { const a = Math.max(0, duration - 3); const ai = Math.round(a * SR); for (let k = ai; k < N; k++) { const g = Math.max(0, 1 - (k - ai) / (3 * SR)); M.L[k] *= g; M.R[k] *= g; } }
// 开头 5 毫秒、末尾 0.3 秒淡入淡出，避免爆音
for (let k = 0; k < N; k++) { const g = Math.min(1, k / (0.005 * SR), (N - k) / (0.3 * SR)); M.L[k] *= g; M.R[k] *= g; }

// ---------- 响度 ----------
// ITU-R BS.1770 K 加权响度（48 kHz 系数），400 毫秒块、75% 重叠、-70 绝对门限和 -10 相对门限
function lufs(L, R) {
  const k = () => [
    { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585, x1: 0, x2: 0, y1: 0, y2: 0 },
    { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621, x1: 0, x2: 0, y1: 0, y2: 0 },
  ];
  const fl = k(), fr = k(), pre = new Float64Array(L.length + 1);
  for (let i = 0; i < L.length; i++) { const a = run(fl[1], run(fl[0], L[i])), b = run(fr[1], run(fr[0], R[i])); pre[i + 1] = pre[i] + a * a + b * b; }
  const size = Math.round(0.4 * SR), hop = Math.round(0.1 * SR), z = [];
  for (let s = 0; s + size <= L.length; s += hop) z.push((pre[s + size] - pre[s]) / size);
  const loud = (x) => -0.691 + 10 * Math.log10(x);
  const abs = z.filter((x) => loud(x) > -70);
  if (!abs.length) return -Infinity;
  const rel = loud(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const g = abs.filter((x) => loud(x) > rel);
  return loud(g.reduce((a, b) => a + b, 0) / g.length);
}
// 软限幅：超过 T 的部分平滑压到 C（-1.5 dBFS）以下
function limit(L, R, T = 0.7, C = 0.84) {
  const f = (x) => { const a = Math.abs(x); return a <= T ? x : Math.sign(x) * (T + (C - T) * Math.tanh((a - T) / (C - T))); };
  for (let i = 0; i < L.length; i++) { L[i] = f(L[i]); R[i] = f(R[i]); }
}
function gain(L, R, g) { for (let i = 0; i < L.length; i++) { L[i] *= g; R[i] *= g; } }
const peakDb = (L, R) => { let p = 0; for (let i = 0; i < L.length; i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i])); return p ? 20 * Math.log10(p) : -Infinity; };

const TARGET = -14;
let loud = lufs(M.L, M.R);
if (!Number.isFinite(loud)) fail('配乐是静音的：检查 sections 是不是全是 -1');
for (let k = 0; k < 3 && Math.abs(loud - TARGET) > 0.3; k++) { gain(M.L, M.R, 10 ** ((TARGET - loud) / 20)); limit(M.L, M.R); loud = lufs(M.L, M.R); }

// ---------- 写文件 ----------
function writeWav(file, L, R) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i])) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}
fs.mkdirSync(outDir, { recursive: true });
const rel = (f) => path.relative(process.cwd(), f).split(path.sep).join('/');
const bgmFile = path.join(outDir, 'bgm.wav');
writeWav(bgmFile, M.L, M.R);

// ---------- 音效 ----------
function stereoOf(mono, pan = 0) { const gl = Math.cos(((pan + 1) * Math.PI) / 4), gr = Math.sin(((pan + 1) * Math.PI) / 4); return [mono.map((x) => x * gl), mono.map((x) => x * gr)]; }
function makeSfx(name) {
  const S = (sec) => new Float32Array(Math.floor(sec * SR));
  switch (name) {
    case 'impact': {
      const o = S(1.6), lp = biquad('lp', 2500, 0.7); let ph = 0;
      for (let i = 0; i < o.length; i++) { const t = i / SR; ph += (32 + 58 * Math.exp(-t * 6)) / SR; o[i] = Math.tanh(1.3 * (Math.sin(TAU * ph) * Math.exp(-t * 3.2) + run(lp, noise()) * Math.exp(-t * 10) * 0.5 + noise() * Math.exp(-t * 300) * 0.4)); }
      return { lr: stereoOf(o), send: 0.35, lead: 0 };
    }
    case 'boom': {
      const o = S(2.2), lp = biquad('lp', 200, 0.7); let ph = 0;
      for (let i = 0; i < o.length; i++) { const t = i / SR; ph += (26 + 34 * Math.exp(-t * 2)) / SR; o[i] = Math.sin(TAU * ph) * Math.exp(-t * 1.6) + run(lp, noise()) * Math.exp(-t * 3) * 0.3; }
      return { lr: stereoOf(o), send: 0.2, lead: 0 };
    }
    case 'whoosh': {
      const d = 0.7, n = Math.floor(d * SR), L = new Float32Array(n), R = new Float32Array(n), f = biquad('bp', 400, 1.2);
      for (let i = 0; i < n; i++) {
        const u = i / n;
        if (i % 32 === 0) retune(f, 'bp', 400 + 3200 * Math.sin(Math.PI * u) ** 2, 1.2);
        const v = run(f, noise()) * Math.sin(Math.PI * u) ** 1.5 * 2.2, pan = -0.7 + 1.4 * u;
        L[i] = v * Math.cos(((pan + 1) * Math.PI) / 4); R[i] = v * Math.sin(((pan + 1) * Math.PI) / 4);
      }
      return { lr: [L, R], send: 0.25, lead: 0 };
    }
    case 'riser': {
      // 在 at 那一刻冲到顶，所以文件从 at 前 1.6 秒开始
      const d = 1.6, o = S(d + 0.02), hp = biquad('hp', 300, 0.8), lp = biquad('lp', 3000, 0.7); let ph = 0;
      for (let i = 0; i < o.length; i++) {
        const u = Math.min(1, i / (d * SR));
        if (i % 32 === 0) retune(hp, 'hp', 300 * (7000 / 300) ** u, 0.8);
        ph = (ph + (220 * 4 ** u) / SR) % 1;
        o[i] = (run(hp, noise()) * 0.8 + run(lp, saw(ph)) * 0.25) * u * u * (i > d * SR ? 0 : 1);
      }
      return { lr: stereoOf(o), send: 0.35, lead: d };
    }
    case 'ding': {
      const a = fm(1568, 0.2, 3.5, 2, 2.2), b = fm(2093, 0.2, 3.5, 1.2, 2.8);
      return { lr: stereoOf(a.map((x, i) => x + (b[i] || 0) * 0.5)), send: 0.4, lead: 0 };
    }
    case 'success': {
      const a = fm(1319, 0.15, 1, 1.4, 3), b = fm(1976, 0.3, 1, 1.4, 2.2), o = new Float32Array(b.length + Math.round(0.09 * SR));
      a.forEach((x, i) => { o[i] += x; }); b.forEach((x, i) => { o[i + Math.round(0.09 * SR)] += x; });
      return { lr: stereoOf(o), send: 0.4, lead: 0 };
    }
    case 'pop': {
      const o = S(0.12); let ph = 0;
      for (let i = 0; i < o.length; i++) { const t = i / SR; ph += (300 + 600 * Math.exp(-t * 40)) / SR; o[i] = Math.sin(TAU * ph) * Math.exp(-t * 40); }
      return { lr: stereoOf(o), send: 0.1, lead: 0 };
    }
    case 'tick': {
      const o = noiseHit('bp', 3500, 2, 300, 0.03), s = S(0.03);
      for (let i = 0; i < s.length; i++) s[i] = o[i] + Math.sin((TAU * 2000 * i) / SR) * Math.exp((-i / SR) * 250) * 0.5;
      return { lr: stereoOf(s), send: 0.05, lead: 0 };
    }
    case 'typing': {
      const o = S(1.2);
      for (let t = 0; t < 1.1; t += 0.05 + rng() * 0.06) { const k = noiseHit('bp', 2500 + rng() * 2500, 2.5, 250, 0.03), g = 0.6 + rng() * 0.4, s0 = Math.round(t * SR); k.forEach((x, i) => { if (s0 + i < o.length) o[s0 + i] += x * g; }); }
      return { lr: stereoOf(o), send: 0.05, lead: 0 };
    }
    case 'glitch': {
      const o = S(0.3); let ph = 0, f = 300, hold = 0, held = 0;
      for (let i = 0; i < o.length; i++) {
        if (i % Math.round(0.025 * SR) === 0) f = 80 + rng() * 1100;
        ph = (ph + f / SR) % 1;
        if (hold-- <= 0) { held = (ph < 0.5 ? 0.5 : -0.5) + noise() * 0.3; hold = 6; }
        o[i] = held * (Math.floor(i / (0.05 * SR)) % 3 === 2 ? 0.2 : 1);
      }
      return { lr: stereoOf(o), send: 0.05, lead: 0 };
    }
    case 'buzz': {
      const o = S(0.45), lp = biquad('lp', 1500, 0.7); let p1 = 0, p2 = 0;
      for (let i = 0; i < o.length; i++) { const t = i / SR; p1 = (p1 + 150 / SR) % 1; p2 = (p2 + 155 / SR) % 1; const on = (t < 0.15 || (t > 0.2 && t < 0.42)) ? 1 : 0; o[i] = run(lp, ((p1 < 0.5 ? 0.5 : -0.5) + (p2 < 0.5 ? 0.5 : -0.5)) * on); }
      return { lr: stereoOf(o), send: 0.1, lead: 0 };
    }
    case 'shutter': {
      const a = noiseHit('bp', 3000, 1, 120, 0.06), b = noiseHit('bp', 2200, 1, 90, 0.08), o = S(0.2);
      a.forEach((x, i) => { o[i] += x; }); b.forEach((x, i) => { o[i + Math.round(0.07 * SR)] += x; });
      return { lr: stereoOf(o), send: 0.1, lead: 0 };
    }
  }
}

const hits = [];
(Array.isArray(spec.hits) ? spec.hits : []).forEach((h, i) => {
  if (!(h.sfx in SFX)) fail(`hits 第 ${i + 1} 个的 sfx 只能是：${Object.keys(SFX).join('、')}`);
  // riser 是冲进下一段的，和某段落写在同一时刻时跟着那段吸附后的实际起点走；其他音效跟画面，不动
  const want = timeOf(h, `hits 第 ${i + 1} 个`);
  const at = h.sfx === 'riser' ? sections.find((sec) => Math.abs(sec.requested - want) < 0.05)?.at ?? want : want;
  const { lr, send, lead } = makeSfx(h.sfx);
  const tail = Math.round(0.8 * SR), n = lr[0].length + tail, b = bus(n);
  putStereo(b, 0, lr, 1, send);
  if (send) reverb(b, 0.8, 0.35);
  let p = 0; for (let k = 0; k < n; k++) p = Math.max(p, Math.abs(b.L[k]), Math.abs(b.R[k]));
  if (p) gain(b.L, b.R, 0.7 / p); // 峰值统一到 -3 dBFS，轻重靠混音音量
  for (let k = Math.max(0, n - tail); k < n; k++) { const g = (n - k) / tail; b.L[k] *= g; b.R[k] *= g; }
  const start = Math.max(0, at - lead);
  const file = path.join(outDir, `sfx-${String(i + 1).padStart(2, '0')}-${h.sfx}.wav`);
  writeWav(file, b.L, b.R);
  const entry = { sfx: h.sfx, at: +at.toFixed(3), start_s: +start.toFixed(3), file: rel(file), duration_s: +(n / SR).toFixed(3), volume: +((SFX[h.sfx]) * (h.gain != null ? Number(h.gain) : 1)).toFixed(3) };
  if (frameStarts) {
    let f = frameStarts.findIndex((x, j) => j < frames.length && start >= x - 1e-6 && start < frameStarts[j + 1] - 1e-6);
    if (f < 0) f = frames.length - 1;
    entry.frame = f + 1; entry.offset_s = +(start - frameStarts[f]).toFixed(3);
  }
  hits.push(entry);
});

const bars = []; for (let t = 0; t < duration; t += BAR) bars.push(+t.toFixed(3));
const report = {
  bgm: { file: rel(bgmFile), duration_s: +(N / SR).toFixed(3), lufs: +loud.toFixed(1), peak_db: +peakDb(M.L, M.R).toFixed(1) },
  mood: spec.mood || 'tech', key: spec.key || (mode === 'minor' ? 'D' : 'C'), mode, bpm, beat_s: +BEAT.toFixed(4), bar_s: +BAR.toFixed(4),
  end: endMode, music_end_s: +(ringT ?? lastT).toFixed(3),
  sections, bars, hits,
  audio_meta: {
    bgm: { path: rel(bgmFile), source: 'host' },
    sfx: hits.filter((h) => h.frame).map((h) => ({ frame: h.frame, file: h.file, offset_s: h.offset_s, duration_s: h.duration_s, volume: h.volume, source: 'host' })),
  },
};
fs.writeFileSync(path.join(outDir, 'bgm.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, bars: `${bars.length} 小节，每小节 ${BAR.toFixed(3)} 秒` }, null, 2));
