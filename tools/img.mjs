#!/usr/bin/env node
// 生成图片（封面图）：任何 OpenAI 兼容的图片接口（/images/generations）。
// 接口地址、key、模型在工作台「设置 → 连接」里填（存在 data/secrets.json）。
//
//   node tools/img.mjs --prompt "…" --out cover.png [--size 1024x1536]
//
// 也可以被 server 直接 import：generateImage({ prompt, out, size })
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

export async function generateImage({ prompt, out, size = '1024x1536', quality = 'high' }) {
  const { base, key, model } = settings();
  const body = JSON.stringify({ model, prompt, size, quality, n: 1, output_format: 'png' });
  const t = Date.now();
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await request(`${base}/images/generations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
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
  const a = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  if (!a.prompt || !a.out) {
    console.error('用法：node tools/img.mjs --prompt "…" --out cover.png [--size 1024x1536]');
    process.exit(1);
  }
  generateImage({ prompt: a.prompt, out: a.out, size: a.size || '1024x1536' })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((err) => {
      console.error(`生成图片失败：${err.message}`);
      process.exit(1);
    });
}
