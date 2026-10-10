#!/usr/bin/env node
// 生成图片：任何 OpenAI 兼容的图片接口。不带参考图走 /images/generations，带参考图走 /images/edits。
// 接口地址、key、模型在工作台「设置 → 连接」里填（存在 data/secrets.json）。
//
//   node tools/img.mjs --prompt "…" --out cover.png [--size 1024x1536]
//   node tools/img.mjs --prompt "…" --out a.png --ref 角色.png [--ref 另一张.png] [--background transparent]
//
// 也可以被 server 直接 import：generateImage({ prompt, out, size, refs, background })
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { imageConfig } from '../server/secrets.js';

function settings() {
  const { baseUrl, apiKey, model } = imageConfig();
  if (!apiKey) throw new Error('没有配置图片生成：在工作台「设置 → 连接」里填 OpenAI 的 key');
  return { base: baseUrl, key: apiKey, model };
}

// 直连，不走系统代理
function request(url, { method = 'GET', headers = {}, body, timeout = 400_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, timeout, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// multipart/form-data：参考图用 image[] 字段，可以传多张
function multipart(fields, files) {
  const boundary = `----smcn${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) {
    const type = MIME[path.extname(f).toLowerCase()];
    if (!type) throw new Error(`参考图只支持 png、jpg、webp：${f}`);
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="image[]"; filename="${path.basename(f).replace(/"/g, '')}"\r\ncontent-type: ${type}\r\n\r\n`));
    parts.push(fs.readFileSync(f), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

export async function generateImage({ prompt, out, size = '1024x1536', quality = 'high', refs = [], background }) {
  const { base, key, model } = settings();
  const fields = { model, prompt, size, quality, n: 1, output_format: 'png', ...(background ? { background } : {}) };
  let endpoint, body, type;
  if (refs.length) {
    if (refs.length > 16) throw new Error('参考图最多 16 张');
    ({ body, type } = multipart(fields, refs));
    endpoint = 'edits';
  } else {
    body = JSON.stringify(fields);
    type = 'application/json';
    endpoint = 'generations';
  }
  const t = Date.now();
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await request(`${base}/images/${endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': type, 'content-length': Buffer.byteLength(body) },
      body,
    });
    const text = res.status >= 400 ? res.body.toString().slice(0, 300) : '';
    if (res.status < 400) break;
    if (attempt < 4 && (res.status === 429 || res.status >= 500 || /concurrency|rate/i.test(text))) {
      await new Promise((r) => setTimeout(r, 20_000));
      continue;
    }
    throw new Error(`图片接口返回 ${res.status}：${text}`);
  }
  const data = JSON.parse(res.body.toString());
  const item = (data.data || [])[0] || {};
  let raw;
  if (item.b64_json) raw = Buffer.from(item.b64_json, 'base64');
  else if (item.url) raw = (await request(item.url, { timeout: 120_000 })).body;
  else throw new Error('图片接口没有返回图片');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, raw);
  return { out, seconds: Math.round((Date.now() - t) / 1000), size };
}

// 命令行用法
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = { ref: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2), v = argv[++i];
    if (k === 'ref') a.ref.push(v); else a[k] = v;
  }
  if (!a.prompt || !a.out) {
    console.error('用法：node tools/img.mjs --prompt "…" --out a.png [--size 1024x1536] [--ref 参考图.png …] [--background transparent]');
    process.exit(1);
  }
  generateImage({ prompt: a.prompt, out: a.out, size: a.size || '1024x1536', quality: a.quality || 'high', refs: a.ref, background: a.background })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((err) => {
      console.error(`生成图片失败：${err.message}`);
      process.exit(1);
    });
}
