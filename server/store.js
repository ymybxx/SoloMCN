// 本地 JSON 文件存储。单人本地使用，数据全部在 data/db.json。
import fs from 'node:fs/promises';
import path from 'node:path';

// picks：选题雷达里 Claude 精选的素材；agentRuns：后台调起 Claude 的运行记录
// settings：页面上的设置，比如各功能用什么模型
export const COLLECTIONS = ['accounts', 'items', 'radar', 'notes', 'picks', 'agentRuns', 'settings'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// 对象递归合并，数组整体替换（和前端的 update 语义一致）
export function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v;
  }
  return out;
}

export async function createStore(file, { onChange } = {}) {
  let data = {};
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  for (const c of COLLECTIONS) data[c] ??= {};

  // 串行写盘，先写临时文件再改名，避免写一半断电损坏
  let writing = Promise.resolve();
  const persist = () => {
    writing = writing.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.rename(tmp, file);
    });
    onChange?.();
    return writing;
  };

  return {
    all: () => data,
    get: (col, id) => data[col][id] ?? null,
    async set(col, id, doc) {
      data[col][id] = doc;
      await persist();
      return doc;
    },
    async update(col, id, patch) {
      if (!data[col][id]) return null;
      data[col][id] = merge(data[col][id], patch);
      await persist();
      return data[col][id];
    },
    async del(col, id) {
      delete data[col][id];
      await persist();
    },
    isEmpty: () => COLLECTIONS.every((c) => Object.keys(data[c]).length === 0),
  };
}
