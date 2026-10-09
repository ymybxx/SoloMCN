// 每个用到 Claude 的功能用什么模型。页面「设置」里改，存在 data/db.json 的 settings/models，下次运行生效。
// 全部通过本机 Claude Code（claude -p）调用，用订阅额度，不需要 API Key。
// 选的是系列而不是具体版本：传别名（fable、opus、sonnet、haiku）给 Claude Code，它自己解析成该系列最新的模型。
export const MODELS = [
  { id: 'fable', name: 'Fable（最新）', note: '最强，适合最难的判断；想得最久，最慢，消耗额度最多' },
  { id: 'opus', name: 'Opus（最新）', note: '很强，适合要判断和创意的活，大部分功能用它' },
  { id: 'sonnet', name: 'Sonnet（最新）', note: '快，省额度，填表、整理、预审这类活够用' },
  { id: 'haiku', name: 'Haiku（最新）', note: '最快最省，只适合很简单的活' },
];

// 思考强度（Claude Code 的 --effort）：越高想得越深，也越慢、越费额度
export const EFFORTS = [
  { id: 'low', name: 'low', note: '最快最省，只适合很简单的活' },
  { id: 'medium', name: 'medium', note: '快，填表、整理、写发布文案这类活够用' },
  { id: 'high', name: 'high', note: '大部分功能用它，判断和创意都稳' },
  { id: 'xhigh', name: 'xhigh', note: '想得更深，适合调研、做视频这类长任务；更慢、更费额度' },
  { id: 'max', name: 'max', note: '最深，最慢，消耗额度最多' },
];

// 从具体模型 id 认出系列，兼容以前存过的具体版本
export const familyOf = (id) => MODELS.find((m) => String(id || '').includes(m.id))?.id;

// via：cli = 本机 Claude Code（后台 Agent 或单次调用），用订阅额度
export const FEATURES = [
  { key: 'curate', name: '精选素材', where: '选题雷达', via: 'cli', default: 'opus', defaultEffort: 'high' },
  { key: 'ideas', name: '给账号出题', where: '选题雷达 → 账号选题', via: 'cli', default: 'opus', defaultEffort: 'high' },
  { key: 'account', name: '生成账号资料', where: '账号矩阵', via: 'cli', default: 'sonnet', defaultEffort: 'medium' },
  { key: 'series', name: '生成和修改系列', where: '账号矩阵 → 系列', via: 'cli', default: 'opus', defaultEffort: 'high' },
  { key: 'research', name: '调研', where: '流水线 → 内容详情', via: 'cli', default: 'opus', defaultEffort: 'high' },
  { key: 'video', name: '生成视频', where: '流水线 → 内容详情', via: 'cli', default: 'opus', defaultEffort: 'high' },
  { key: 'publish', name: '生成发布信息', where: '流水线 → 内容详情', via: 'cli', default: 'sonnet', defaultEffort: 'medium' },
  { key: 'revise', name: '修改视频', where: '流水线 → 内容详情', via: 'cli', default: 'opus', defaultEffort: 'high' },
  { key: 'script', name: '写分镜脚本', where: '流水线 → 内容详情', via: 'cli', default: 'opus', defaultEffort: 'high', modes: ['agent', 'oneshot'], defaultMode: 'agent' },
  { key: 'analysis', name: 'AI 复盘', where: '数据复盘', via: 'cli', default: 'opus', defaultEffort: 'high', modes: ['agent', 'oneshot'], defaultMode: 'oneshot' },
];

// 调用方式：后台 Agent 能上网、读写工作台，但同一时间只跑一个；单次调用不带工具，直接回答，可以和 Agent 同时进行
export const MODES = [
  { id: 'agent', name: '后台 Agent', note: '能上网查背景、读工作台里的资料，结果自动存回；同一时间只跑一个任务，要排队' },
  { id: 'oneshot', name: '单次调用', note: '只根据卡片里的内容直接回答，不上网；更快，文字逐段出来，可以和后台 Agent 同时跑' },
];

// 没有可选方式的功能（精选、出题、账号资料）固定是后台 Agent
export function modeFor(store, key) {
  const f = FEATURES.find((x) => x.key === key);
  if (!f?.modes) return 'agent';
  const chosen = store.get('settings', 'modes')?.[key];
  return f.modes.includes(chosen) ? chosen : f.defaultMode;
}

// 返回系列名（fable / opus / sonnet / haiku）
export function modelFor(store, key) {
  return familyOf(store.get('settings', 'models')?.[key]) || FEATURES.find((f) => f.key === key)?.default || 'opus';
}

// 返回思考强度（low / medium / high / xhigh / max）
export function effortFor(store, key) {
  const chosen = store.get('settings', 'efforts')?.[key];
  if (EFFORTS.some((e) => e.id === chosen)) return chosen;
  return FEATURES.find((f) => f.key === key)?.defaultEffort || 'high';
}

// 早期的运行记录把 Claude Code 内部顺带用的轻量模型也拼在了一起（“a、b”），只取主模型
function mainModel(model) {
  if (!model) return null;
  const all = String(model).split('、');
  return all.find((m) => !/haiku/.test(m)) || all[0];
}

export function modelSettings(store) {
  // 本机 Claude Code 的功能，顺便给出最近一次实际用的具体版本
  const runs = Object.values(store.all().agentRuns || {}).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return {
    models: MODELS,
    modes: MODES,
    efforts: EFFORTS,
    features: FEATURES.map((f) => ({
      ...f,
      model: modelFor(store, f.key),
      mode: modeFor(store, f.key),
      effort: effortFor(store, f.key),
      lastUsed: mainModel(runs.find((r) => r.task === f.key && r.model)?.model),
    })),
  };
}
