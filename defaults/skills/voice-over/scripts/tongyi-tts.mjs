#!/usr/bin/env node
// 通义（阿里百炼 DashScope）语音合成：一句台词 → 一个 wav。生成视频时后台 Claude 调用它配音。
//
//   node tongyi-tts.mjs --voice longanhuan --text "台词" --out voice/line-01.wav
//   node tongyi-tts.mjs --voice longanhuan --lines lines.tsv --outdir voice     # 批量：每行“编号<TAB>台词”
//
// 可选：--model（默认 qwen-audio-3.0-tts-flash）、--rate 采样率（默认 24000）、--speed 语速（默认 1.0）
// 密钥：环境变量 DASHSCOPE_API_KEY（写在 Claude Code 的本地配置 .claude/settings.local.json 的 env 里）。
// 输出：每句一行 JSON，{ out, seconds, sentences:[{text, end_s}] }，sentences 可用来对齐字幕。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';


function credentials() {
  // key 由 Claude Code 的本地配置提供（.claude/settings.local.json 的 env），工作台不经手
  const key = process.env.DASHSCOPE_API_KEY;
  const url = process.env.DASHSCOPE_TTS_URL || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
  if (!key) {
    console.error('没有通义语音的 key：在 .claude/settings.local.json 的 "env" 里加 DASHSCOPE_API_KEY（阿里云百炼控制台申请）。没有 key 就改用 macOS 系统语音');
    process.exit(2);
  }
  return { key, url };
}

function synth({ text, voice, model, out, rate, speed }, { key, url }) {
  return new Promise((resolve, reject) => {
    const tid = randomUUID().replace(/-/g, '');
    const chunks = [];
    let bytes = 0;
    const sentences = [];
    const ws = new WebSocket(url, { headers: { Authorization: `bearer ${key}` }, maxPayload: 0 });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('合成超时（60 秒）'));
    }, 60_000);
    const send = (action, payload) => ws.send(JSON.stringify({ header: { action, task_id: tid, streaming: 'duplex' }, payload }));
    ws.on('open', () => {
      send('run-task', {
        task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model,
        parameters: { text_type: 'PlainText', voice, format: 'pcm', sample_rate: rate, volume: 50, rate: speed, pitch: 1.0, enable_ssml: false },
        input: {},
      });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        chunks.push(data);
        bytes += data.length;
        return;
      }
      const ev = JSON.parse(data.toString());
      const name = ev.header?.event;
      if (name === 'task-started') {
        send('continue-task', { input: { text } });
        send('finish-task', { input: {} });
      } else if (name === 'result-generated') {
        const o = ev.payload?.output || {};
        if (o.type === 'sentence-end') sentences.push({ text: o.original_text || o.sentence?.text || o.sentence || '', end_s: Math.round((bytes / 2 / rate) * 1000) / 1000 });
      } else if (name === 'task-finished') {
        clearTimeout(timer);
        ws.close();
        const pcm = Buffer.concat(chunks);
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, wav(pcm, rate));
        resolve({ out, seconds: Math.round((pcm.length / 2 / rate) * 1000) / 1000, sentences });
      } else if (name === 'task-failed') {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`${ev.header?.error_code || ''} ${ev.header?.error_message || '合成失败'}`.trim()));
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// 16 位单声道 PCM 加上 wav 文件头
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function args() {
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
  }
  return a;
}

const a = args();
if (!a.voice || (!a.text && !a.lines)) {
  console.error('用法：node tongyi-tts.mjs --voice <音色> --text "台词" --out a.wav  或  --lines lines.tsv --outdir voice');
  process.exit(1);
}
const cred = credentials();
const opts = { voice: a.voice, model: a.model || 'qwen-audio-3.0-tts-flash', rate: Number(a.rate) || 24000, speed: Number(a.speed) || 1.0 };

// 网络抖动时重试 3 次
async function withRetry(job) {
  for (let i = 1; ; i++) {
    try {
      return await synth({ ...opts, ...job }, cred);
    } catch (err) {
      if (i >= 3) throw err;
      await new Promise((r) => setTimeout(r, 3000 * i));
    }
  }
}

try {
  if (a.lines) {
    const rows = fs.readFileSync(a.lines, 'utf8').split('\n').map((l) => l.split('\t')).filter((r) => r[0]?.trim() && r[1]?.trim());
    for (const [id, text] of rows) {
      const out = path.join(a.outdir || '.', `line-${String(id).trim().padStart(2, '0')}.wav`);
      console.log(JSON.stringify({ id: id.trim(), ...(await withRetry({ text: text.trim(), out })) }));
    }
  } else {
    console.log(JSON.stringify(await withRetry({ text: a.text, out: a.out || 'tts.wav' })));
  }
} catch (err) {
  console.error(`通义语音合成失败：${err.message}`);
  process.exit(1);
}
