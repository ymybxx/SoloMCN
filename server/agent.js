// 在后台调起 Claude Code（claude -p）跑项目里的技能，跑的是和桌面端同一个 Agent：
// 会加载 .claude/skills 和 .mcp.json，能上网搜索，结果通过 workbench MCP 写回工作台。
// 用本机已登录的 Claude 账号，不需要 API Key。每次运行都是一个新会话，会话 id 存下来，
// 可以用 claude --resume <id> 接着看 Claude 当时是怎么想的。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { claudeBin, cliEnv, loginErrorMessage } from './cli.js';
import { modelFor, effortFor } from './models.js';
import { CONTENT_OUTPUT_POLICY } from './prompts.js';

// 后台运行没人点确认：内置工具只提供上网查资料和加载技能、工具这几个，命令行、读写文件压根不提供，
// 网页里就算藏着指令也碰不到本机；只放行 workbench 的 MCP 工具。禁止列表是第二道保险
const BUILTIN_TOOLS = ['WebSearch', 'WebFetch', 'Skill', 'ToolSearch'];
const ALLOWED_TOOLS = ['mcp__workbench__*', ...BUILTIN_TOOLS];
const DENIED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'];
const MAX_STEPS = 600;
// 工作台页面会实时显示这些内容，所以要求中文
// 过程说明和汇报的语言跟着页面「设置」里的界面语言走；作品内容（脚本、字幕、文案）按系列定，不受影响
const LANG_PROMPTS = {
  zh: '你的过程说明、给命令行工具写的 description、子任务的 description、最后的汇报，一律用简体中文写，简短直白。代码、命令、文件名保持原样。',
  en: 'Write your progress notes, the descriptions you give command-line tools and sub-tasks, and your final report in plain, concise English. Keep code, commands and file names as they are. This only affects your notes and report: the content you create (ideas, scripts, captions, voice-over, publish copy) follows the series and the skill instructions as usual.',
};
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEEP_RUNS = 20;

// 和页面上账号表单的选项保持一致
const PLATFORMS = ['douyin', 'bilibili', 'xhs'];
const EMOTIONS = ['感动', '怀旧', '好笑', '反差', '爽感', '代入', '治愈', '震惊', '好奇'];
const ACCOUNT_SCHEMA = {
  type: 'object',
  required: ['code', 'name', 'brief', 'platforms', 'reason'],
  properties: {
    code: { type: 'string', description: '一个没被占用的大写字母' },
    name: { type: 'string', description: '账号名，2–8 个字' },
    brief: { type: 'string', description: '账号的一句话大方向，可以宽泛，例如“AI 相关的一切，拆真相也玩新东西”；人群、主角、风格写在系列里，不写在这' },
    platforms: { type: 'array', items: { enum: PLATFORMS }, minItems: 1 },
    reason: { type: 'string', description: '一句话：和已有账号怎么区分' },
  },
};
// 系列：创作上的东西都在这（人群、主角和语气、配音、视觉、情绪、定位、结构、时长、题材）
const SERIES_SCHEMA = {
  type: 'object',
  required: ['name', 'summary', 'audience', 'persona', 'voice', 'visual', 'emotions', 'structure', 'length', 'topics', 'note'],
  properties: {
    name: { type: 'string', description: '系列名，2–8 个字' },
    summary: { type: 'string', description: '一句话定位：这类视频做什么' },
    audience: { type: 'string', description: '目标人群，具体到年龄、城市层级或身份' },
    persona: { type: 'string', description: '主角和语气：固定角色的形象、性格、说话方式、口头禅，2–3 句' },
    voice: { type: 'string', description: '配音音色的 id，从给出的音色列表里挑最贴合主角的；修改已有系列时照原样保留（原来是空的就填空字符串），除非修改意见里提到配音' },
    visual: { type: 'string', description: '视觉风格：画面风格、色调、版式、常用素材，1–2 句' },
    emotions: { type: 'array', items: { enum: EMOTIONS }, minItems: 1, maxItems: 4 },
    structure: { type: 'string', description: '固定结构：开头怎么钩人、中间分几段、结尾怎么收' },
    length: { type: 'string', description: '时长，例如 45–60 秒' },
    topics: { type: 'string', description: '适合的题材' },
    note: { type: 'string', description: '一两句话：这版写了什么，或者按意见改了哪些地方' },
  },
};

const TASKS = {
  account: {
    name: '生成账号资料',
    maxTurns: 4,
    tools: '', // 只靠下面给的信息写，不用任何工具
    schema: ACCOUNT_SCHEMA,
    prompt: ({ brief, others, current }) => [
      '你在帮一个 AI 短视频矩阵（抖音 / B站 / 小红书）设计账号。账号只是一个频道：名称、发哪些平台、一句话大方向。目标人群、主角、风格这些写在账号下面的系列里，这里不用写。',
      `用户给的方向：「${brief}」`,
      current ? `这是在修改已有账号，它现在的资料：${current}` : '',
      others.length ? `矩阵里其他账号（新账号的人群、人设、风格都要和它们明显不同，不能换皮）：\n${others.join('\n')}` : '',
      '要求：',
      '- 大方向一句话，可以宽泛；名称好记',
      `- 平台从 ${PLATFORMS.join('、')} 里选`,
      '- 都用中文，具体，不要空话',
      '不要调用任何工具，直接按格式返回。',
    ].filter(Boolean).join('\n'),
  },
  series: {
    name: '生成系列',
    maxTurns: 4,
    tools: '',
    schema: SERIES_SCHEMA,
    prompt: ({ brief, feedback, current, account, siblings, others, voices }) => [
      current ? '你在帮一个 AI 短视频账号修改它的一个系列。' : '你在帮一个 AI 短视频账号设计一个新系列。',
      `账号：${account}`,
      siblings.length ? `这个账号已有的其他系列（新系列的做法要和它们明显不同）：\n${siblings.join('\n')}` : '',
      others.length ? `矩阵里其他账号的系列（避免换皮）：\n${others.join('\n')}` : '',
      current ? `这个系列现在的设定：\n${current}` : '',
      brief ? `用户给的方向：「${brief}」` : '',
      feedback ? `用户的修改意见：「${feedback}」\n只改意见里提到的地方和必须跟着变的地方，其他字段照原样保留，原话不要改写。` : '',
      `配音音色列表（voice 填 id）：\n${voices}`,
      '要求：',
      '- 目标人群具体到年龄、城市层级或身份；主角写清形象、性格、说话方式和口头禅；视觉写清画面风格、色调和版式；固定结构写清开头、中段、结尾',
      `- 主打情绪从 ${EMOTIONS.join('、')} 里选 1–4 个`,
      '- 唯一的红线是不伪造（不编造新闻、事件、测试结果和数据，不用 AI 合成真人的脸或声音）',
      '- 都用中文，具体，不要空话',
      '不要调用任何工具，直接按格式返回。',
    ].filter(Boolean).join('\n'),
  },
  curate: {
    name: '精选素材',
    maxTurns: 80,
    prompt: () => '/curate-topics',
  },
  ideas: {
    name: '给账号出题',
    maxTurns: 50,
    prompt: ({ pickId, accounts, n }) => `/account-ideas 精选 id：${pickId}；账号：${accounts.join('、')}；每个账号 ${n} 个`,
  },
  // 写脚本之前先调研：上网查真实的价格、能力、步骤和反方观点，写成带出处的报告存到卡片上
  research: {
    name: '调研',
    maxTurns: 90,
    prompt: ({ itemId }) => `/research-topic 内容 id：${itemId}`,
  },
  // 下面三个在「设置」里选成「后台 Agent」时走这里，选「单次调用」时走 cli.js
  script: {
    name: '写脚本',
    maxTurns: 30,
    prompt: ({ itemId }) => `/write-script 内容 id：${itemId}`,
  },
  check: {
    name: 'AI 预审',
    maxTurns: 15,
    prompt: ({ itemId }) => `/precheck-content 内容 id：${itemId}`,
  },
  analysis: {
    name: 'AI 复盘',
    maxTurns: 30,
    prompt: () => '/review-data',
  },
  // 生成视频：用 HyperFrames 把脚本做成 MP4，要跑几十分钟，走单独的队列，不挡精选、写脚本。
  // 它要执行命令、写项目文件，所以放开命令行和读写文件；作为交换，不给上网搜索和打开网页，
  // 输入只有卡片上的脚本和账号人设，网页内容进不来
  video: {
    name: '生成视频',
    lane: 'video',
    maxTurns: 400,
    prompt: ({ itemId }) => `/make-video 内容 id：${itemId}`,
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'Agent', 'TodoWrite', 'ToolSearch'].join(','),
    allowed: ['mcp__workbench__get_item', 'mcp__workbench__save_video', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'Agent', 'TodoWrite', 'ToolSearch'],
    denied: ['WebSearch', 'WebFetch', 'NotebookEdit'],
  },
  // 按人的修改意见改已经做好的视频：只改提到的地方，重新渲染成新版本，旧版本保留
  revise: {
    name: '修改视频',
    lane: 'video',
    maxTurns: 200,
    prompt: ({ itemId, feedback, images = [] }) => `/revise-video 内容 id：${itemId}\n修改意见：\n${feedback}` +
      (images.length ? `\n附图（用读文件工具逐张查看）：\n${images.map((p, i) => `图 ${i + 1}：${path.join(ROOT, p)}`).join('\n')}` : ''),
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'Agent', 'TodoWrite', 'ToolSearch'].join(','),
    allowed: ['mcp__workbench__get_item', 'mcp__workbench__save_video', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'Agent', 'TodoWrite', 'ToolSearch'],
    denied: ['WebSearch', 'WebFetch', 'NotebookEdit'],
  },
};

const TOOL_NAMES = {
  get_feed: '读取渠道素材',
  get_hot_topics: '读取国内热榜',
  get_overseas_hot: '读取国外热点',
  get_accounts: '读取账号人设',
  get_recent_context: '读取近期选题和表现',
  get_picks: '读取精选',
  add_picks: '写入精选',
  add_ideas: '写入选题',
  get_item: '读取内容和账号人设',
  save_script: '保存脚本',
  save_precheck: '保存预审结果',
  get_published: '读取已发布内容的数据',
  save_analysis: '保存复盘',
  save_video: '保存视频',
  save_research: '保存调研报告',
};

const TOOL_NAMES_EN = {
  get_feed: 'Read trends', get_hot_topics: 'Read trending lists', get_overseas_hot: 'Read overseas trends', get_accounts: 'Read channel profiles',
  get_recent_context: 'Read recent ideas and results', get_picks: 'Read picks', add_picks: 'Save picks', add_ideas: 'Save ideas',
  get_item: 'Read item and profile', save_script: 'Save script', save_precheck: 'Save precheck', get_published: 'Read published stats',
  save_analysis: 'Save review', save_video: 'Save video', save_research: 'Save research', capture_source: 'Capture page',
};
const CHANNEL_NAMES_EN = { douyin: 'Douyin', weibo: 'Weibo', bilibili: 'Bilibili', zhihu: 'Zhihu', baidu: 'Baidu', toutiao: 'Toutiao', 'bilibili-video': 'Bilibili videos', hackernews: 'Hacker News' };

const CHANNEL_NAMES = { douyin: '抖音', weibo: '微博', bilibili: 'B站', zhihu: '知乎', baidu: '百度', toutiao: '头条', 'bilibili-video': 'B站热门视频', hackernews: 'Hacker News' };

function describeTool(name, input = {}, lang = 'zh') {
  if (lang === 'en') return describeToolEn(name, input);
  if (name === 'WebSearch') return `上网搜索：${input.query || ''}`;
  if (name === 'WebFetch') return `打开网页：${input.url || ''}`;
  if (name === 'Skill') return `使用技能：${input.skill || input.command || ''}`;
  // 生成视频时会用到的本机工具
  if (name === 'Bash') return `执行：${input.description || String(input.command || '').slice(0, 80)}`;
  if (name === 'Write') return `写文件：${String(input.file_path || '').split('/videos/').pop()}`;
  if (name === 'Edit') return `改文件：${String(input.file_path || '').split('/videos/').pop()}`;
  if (name === 'Read') return `读文件：${String(input.file_path || '').split('/').slice(-2).join('/')}`;
  if (name === 'Agent' || name === 'Task') return `子任务：${input.description || ''}`;
  if (name === 'TodoWrite') return '更新任务清单';
  if (name === 'Glob' || name === 'Grep') return `查找文件：${input.pattern || ''}`;
  const short = name.replace(/^mcp__workbench__/, '');
  const label = TOOL_NAMES[short] || short;
  if (short === 'get_feed' && input.channels) return `${label}（${input.channels.map((c) => CHANNEL_NAMES[c] || c).join('、')}）`;
  if (short === 'add_picks') return `${label} ${input.picks?.length ?? ''} 个`;
  if (short === 'add_ideas') return `${label} ${input.ideas?.length ?? ''} 条`;
  return label;
}

function describeToolEn(name, input = {}) {
  if (name === 'WebSearch') return `Web search: ${input.query || ''}`;
  if (name === 'WebFetch') return `Open page: ${input.url || ''}`;
  if (name === 'Skill') return `Use skill: ${input.skill || input.command || ''}`;
  if (name === 'Bash') return `Run: ${input.description || String(input.command || '').slice(0, 80)}`;
  if (name === 'Write') return `Write file: ${String(input.file_path || '').split('/videos/').pop()}`;
  if (name === 'Edit') return `Edit file: ${String(input.file_path || '').split('/videos/').pop()}`;
  if (name === 'Read') return `Read file: ${String(input.file_path || '').split('/').slice(-2).join('/')}`;
  if (name === 'Agent' || name === 'Task') return `Sub-task: ${input.description || ''}`;
  if (name === 'TodoWrite') return 'Update to-do list';
  if (name === 'Glob' || name === 'Grep') return `Find files: ${input.pattern || ''}`;
  const short = name.replace(/^mcp__workbench__/, '');
  const label = TOOL_NAMES_EN[short] || short;
  if (short === 'get_feed' && input.channels) return `${label} (${input.channels.map((c) => CHANNEL_NAMES_EN[c] || c).join(', ')})`;
  if (short === 'add_picks') return `${label}: ${input.picks?.length ?? ''}`;
  if (short === 'add_ideas') return `${label}: ${input.ideas?.length ?? ''}`;
  return label;
}

export function createAgent({ store, cwd }) {
  const uiLang = () => (store.get('settings', 'ui')?.lang === 'en' ? 'en' : 'zh');
  // 每条队列同一时间只跑一个任务：main（精选、出题、写脚本……）和 video（生成视频）互不阻塞
  const current = {}; // lane -> { id, proc, stopped }
  const laneOf = (task) => TASKS[task]?.lane || 'main';

  // 服务重启时还标着“运行中”的，说明上次被中断了
  for (const [id, run] of Object.entries(store.all().agentRuns || {})) {
    if (run.status === 'running') store.update('agentRuns', id, { status: 'failed', error: '工作台服务重启，运行被中断', finishedAt: Date.now() });
  }

  async function prune() {
    const runs = Object.entries(store.all().agentRuns || {}).sort((a, b) => (b[1].startedAt || 0) - (a[1].startedAt || 0));
    for (const [id] of runs.slice(KEEP_RUNS)) await store.del('agentRuns', id);
  }

  function validate(task, args) {
    const t = TASKS[task];
    if (!t) throw Object.assign(new Error('没有这个任务'), { status: 404 });
    if (task === 'account') {
      args.brief = String(args.brief || '').trim().slice(0, 300);
      if (args.brief.length < 2) throw Object.assign(new Error('先用一句话写个方向'), { status: 400 });
      const line = (a) => `${a.code} ${a.name}${a.brief ? `｜大方向：${a.brief}` : ''}${(a.series || []).length ? `｜系列：${a.series.map((x) => `《${x.name}》${x.audience ? `（${x.audience}）` : ''}`).join('、')}` : `｜人群：${a.audience || '—'}｜人设：${a.persona || '—'}`}`;
      const accounts = store.all().accounts;
      args.others = Object.entries(accounts).filter(([aid]) => aid !== args.editing).map(([, a]) => line(a));
      args.current = args.editing && accounts[args.editing] ? line(accounts[args.editing]) : '';
    }
    if (task === 'series') {
      args.brief = String(args.brief || '').trim().slice(0, 300);
      args.feedback = String(args.feedback || '').trim().slice(0, 1000);
      // 编辑框里还没保存的那一版（从页面传来），改的就是它
      const cur = args.draft && typeof args.draft === 'object' ? args.draft : null;
      if (args.brief.length < 2 && !(cur && args.feedback.length >= 2)) throw Object.assign(new Error(cur ? '写一下要改哪里' : '先用一句话写个方向'), { status: 400 });
      const accounts = store.all().accounts;
      const acc = accounts[args.accountId] || { name: args.accountName || '新账号', brief: args.accountBrief || '' };
      const sLine = (x) => `《${x.name}》${x.summary ? `：${x.summary}` : ''}${x.audience ? `｜人群：${x.audience}` : ''}`;
      args.account = `${acc.name || ''}${acc.brief ? `｜大方向：${acc.brief}` : ''}`;
      args.siblings = (acc.series || []).filter((x) => x.id !== cur?.id).map(sLine);
      args.others = Object.entries(accounts).filter(([aid]) => aid !== args.accountId).flatMap(([, a]) => (a.series || []).map((x) => `${a.name}：${sLine(x)}`));
      args.current = cur ? JSON.stringify({ name: cur.name, summary: cur.summary, audience: cur.audience, persona: cur.persona, voice: cur.voice, visual: cur.visual, emotions: cur.emotions, structure: cur.structure, length: cur.length, topics: cur.topics }, null, 1) : '';
      const catalog = JSON.parse(readFileSync(path.join(cwd, 'tools', 'voices.json'), 'utf8'));
      args.voices = catalog.voices.map((v) => `${v.id}：${v.label}，${v.hint}`).join('\n');
      delete args.draft;
    }
    if (task === 'revise') {
      const it = ID_RE.test(args.itemId || '') && store.get('items', args.itemId);
      if (!it) throw Object.assign(new Error('找不到这条内容'), { status: 400 });
      if (!it.video?.mp4) throw Object.assign(new Error('这条内容还没有视频，先生成视频'), { status: 400 });
      args.feedback = String(args.feedback || '').trim().slice(0, 2000);
      args.images = (Array.isArray(args.images) ? args.images : []).filter((p) => /^data\/uploads\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(p) && existsSync(path.join(cwd, p))).slice(0, 8);
      if (args.feedback.length < 2 && !args.images.length) throw Object.assign(new Error('先写一下要改哪里'), { status: 400 });
      if (args.feedback.length < 2) args.feedback = '见附图';
    }
    if (task === 'video') {
      const it = ID_RE.test(args.itemId || '') && store.get('items', args.itemId);
      if (!it) throw Object.assign(new Error('找不到这条内容'), { status: 400 });
      if (!String(it.script || '').trim()) throw Object.assign(new Error('先写好脚本再生成视频'), { status: 400 });
    }
    if (task === 'research' && (!ID_RE.test(args.itemId || '') || !store.get('items', args.itemId))) {
      throw Object.assign(new Error('找不到这条内容'), { status: 400 });
    }
    if (task === 'script' || task === 'check') {
      if (!ID_RE.test(args.itemId || '') || !store.get('items', args.itemId)) throw Object.assign(new Error('找不到这条内容'), { status: 400 });
      if (task === 'check' && !String(store.get('items', args.itemId).script || '').trim()) throw Object.assign(new Error('先写好脚本再预审'), { status: 400 });
    }
    if (task === 'analysis' && !Object.values(store.all().items).some((i) => i.stage === 'published')) {
      throw Object.assign(new Error('还没有已发布的内容'), { status: 400 });
    }
    if (task === 'ideas') {
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(args.pickId || '') || !store.get('picks', args.pickId)) throw Object.assign(new Error('找不到这个精选'), { status: 400 });
      const codes = Object.values(store.all().accounts).map((a) => String(a.code));
      args.accounts = (args.accounts || []).filter((c) => codes.includes(String(c)));
      if (!args.accounts.length) throw Object.assign(new Error('至少选一个账号'), { status: 400 });
      args.n = Math.min(5, Math.max(1, Number(args.n) || 3));
    }
    return t;
  }

  // 断网、连接被断开、服务过载这类临时错误：接上原会话继续，不从头来
  const TRANSIENT = /ECONNRESET|Connection (dropped|error|closed)|socket hang up|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|overloaded|\b(502|503|504|529)\b/i;
  const AUTO_RESUME_MAX = 2;
  const AUTO_RESUME_WAIT_MS = 60_000;
  const RESUME_PROMPT = '上一次运行因为网络中断停下了。接着刚才的进度继续，把任务做完；已经做好的部分不要重做，先看一下磁盘上已经有什么。';
  // 人在任务进行中插话：打断当前这一步，带着这句话接上同一个会话继续
  const sayPrompt = (text) => `用户在你工作过程中插了一句话（刚才正在进行的那一步被打断了，需要的话重做那一步）：\n「${text}」\n按这句话调整，然后接着把原来的任务做完；已经做好、且和这句话无关的部分不要重做。`;

  async function start(task, args = {}) {
    const lane = laneOf(task);
    if (current[lane]) {
      const msg = lane === 'video' ? '已经有一个视频在生成，等它结束或先停止' : 'Claude 正在跑另一个任务，等它结束或先停止';
      throw Object.assign(new Error(msg), { status: 409 });
    }
    const t = validate(task, args);
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    // 账号资料任务带着其他账号的资料，不用存进运行记录
    const shownArgs = Object.fromEntries(Object.entries(args).filter(([k]) => !['others', 'current'].includes(k)));
    const run = { task, name: t.name, args: shownArgs, status: 'running', startedAt: Date.now(), steps: [], sessionId: null, resumes: 0 };
    await store.set('agentRuns', id, run);
    await prune();
    // 开始做视频就算进入生产：卡片从「选题」「脚本」推进到「生产中」
    if (task === 'video') {
      const it = store.get('items', args.itemId);
      if (it && ['idea', 'script'].includes(it.stage || 'idea')) await store.update('items', args.itemId, { stage: 'production', updatedAt: Date.now() });
    }
    launch({ id, run, task, t, lane, prompt: t.prompt(args) });
    return { id, ...run };
  }

  // 失败或被停止的任务，从中断处接着跑（同一个会话，Claude 记得之前做到哪）
  async function resume(id) {
    const saved = store.get('agentRuns', id);
    if (!saved) throw Object.assign(new Error('找不到这次运行'), { status: 404 });
    if (saved.status === 'running') throw Object.assign(new Error('这次运行还在进行中'), { status: 409 });
    if (!saved.sessionId) throw Object.assign(new Error('这次运行没有留下会话，只能重新开始'), { status: 400 });
    const t = TASKS[saved.task];
    if (!t) throw Object.assign(new Error('没有这个任务'), { status: 400 });
    const lane = laneOf(saved.task);
    if (current[lane]) throw Object.assign(new Error(lane === 'video' ? '已经有一个视频在生成，等它结束或先停止' : 'Claude 正在跑另一个任务，等它结束或先停止'), { status: 409 });
    const run = { ...saved, status: 'running', error: null, finishedAt: null, resumes: (saved.resumes || 0) + 1, steps: [...(saved.steps || [])] };
    run.steps.push({ at: Date.now(), kind: 'text', text: '从中断处继续' });
    await store.update('agentRuns', id, { status: 'running', error: null, finishedAt: null, resumes: run.resumes, steps: run.steps });
    launch({ id, run, task: saved.task, t, lane, prompt: RESUME_PROMPT, resumeSession: saved.sessionId });
    return { id, ...run };
  }

  function launch({ id, run, task, t, lane, prompt, resumeSession = null, autoResumes = 0 }) {
    const env = cliEnv();
    const proc = spawn(
      claudeBin(),
      // 每次都指定模型（页面「设置」里选的）：不指定就用账号当时的默认模型，Opus 额度用完会悄悄换成 Sonnet
      ['-p', prompt, ...(resumeSession ? ['--resume', resumeSession] : []),
        '--model', modelFor(store, task), '--effort', effortFor(store, task), '--output-format', 'stream-json', '--verbose', '--max-turns', String(t.maxTurns),
        '--append-system-prompt', LANG_PROMPTS[uiLang()] + '\n' + CONTENT_OUTPUT_POLICY,
        '--permission-mode', 'dontAsk', '--tools', t.tools ?? BUILTIN_TOOLS.join(','),
        '--allowedTools', (t.allowed ?? ALLOWED_TOOLS).join(','), '--disallowedTools', (t.denied ?? DENIED_TOOLS).join(','),
        ...(t.schema ? ['--json-schema', JSON.stringify(t.schema)] : [])],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const prev = current[lane];
    current[lane] = { id, proc, stopped: prev?.id === id ? prev.stopped : false, say: prev?.id === id ? prev.say : null };

    let dirty = false;
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      store.update('agentRuns', id, { steps: run.steps, sessionId: run.sessionId, model: run.model || null });
    };
    const timer = setInterval(flush, 1500);
    const step = (kind, text) => {
      run.steps.push({ at: Date.now(), kind, text: String(text).slice(0, 300) });
      if (run.steps.length > MAX_STEPS) run.steps.splice(0, run.steps.length - MAX_STEPS);
      dirty = true;
    };

    let buf = '';
    let stderr = '';
    let result = null;
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.session_id && !run.sessionId) {
          run.sessionId = ev.session_id;
          dirty = true;
        }
        if (ev.type === 'system' && ev.subtype === 'init' && ev.model) {
          run.model = ev.model;
          dirty = true;
        }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content || []) {
            if (c.type === 'tool_use' && c.name !== 'ToolSearch') step('tool', describeTool(c.name, c.input, uiLang()));
            else if (c.type === 'text' && c.text.trim()) step('text', c.text.trim());
          }
        } else if (ev.type === 'user') {
          for (const c of ev.message?.content || []) {
            if (c.type === 'tool_result' && c.is_error) {
              const text = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : c.content;
              step('error', `工具出错：${text}`);
            }
          }
        } else if (ev.type === 'result') {
          result = ev;
        }
      }
    });
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });

    const finish = async (code, spawnError) => {
      clearInterval(timer);
      const stopped = current[lane]?.stopped;
      const ok = !spawnError && result && !result.is_error && result.subtype === 'success';
      const errText = String(result?.result || stderr || '');

      // 插话打断的：带着这句话接上会话继续（任务刚好做完也一样，让它按这句话再调整）
      const said = current[lane]?.say;
      if (said && !stopped && !spawnError && run.sessionId) {
        current[lane].say = null;
        step('user', `你插话：${said}`);
        flush();
        launch({ id, run, task, t, lane, prompt: sayPrompt(said), resumeSession: run.sessionId, autoResumes });
        return;
      }

      // 临时网络问题：等一会儿接上原会话继续，期间仍占着队列，页面上显示为运行中
      if (!ok && !stopped && !spawnError && run.sessionId && autoResumes < AUTO_RESUME_MAX && TRANSIENT.test(errText)) {
        step('text', `网络中断（${errText.slice(0, 80)}），${AUTO_RESUME_WAIT_MS / 1000} 秒后自动接着做（第 ${autoResumes + 1} 次）`);
        flush();
        setTimeout(() => {
          if (current[lane]?.id !== id || current[lane]?.stopped) {
            if (current[lane]?.id === id) {
              current[lane] = null;
              store.update('agentRuns', id, { status: 'stopped', finishedAt: Date.now(), steps: run.steps });
            }
            return;
          }
          const pending = current[lane]?.say;
          if (pending) {
            current[lane].say = null;
            step('user', `你插话：${pending}`);
          }
          launch({ id, run, task, t, lane, prompt: pending ? sayPrompt(pending) : RESUME_PROMPT, resumeSession: run.sessionId, autoResumes: autoResumes + 1 });
        }, AUTO_RESUME_WAIT_MS);
        return;
      }

      current[lane] = null;
      await store.update('agentRuns', id, {
        steps: run.steps,
        sessionId: run.sessionId,
        // model 是指定的主模型；modelsUsed 是实际用到的全部，Claude Code 做内部小任务会顺带用轻量模型
        model: run.model || Object.keys(result?.modelUsage || {})[0] || null,
        modelsUsed: Object.keys(result?.modelUsage || {}),
        status: stopped ? 'stopped' : ok ? 'done' : 'failed',
        finishedAt: Date.now(),
        result: result?.result && !result.structured_output ? String(result.result).slice(0, 4000) : null,
        structured: result?.structured_output ?? null,
        costUsd: result?.total_cost_usd ?? null,
        turns: result?.num_turns ?? null,
        error: stopped || ok ? null
          : spawnError ? `启动 claude 失败：${spawnError.message}。确认已安装 Claude Code，或在 .env 里设置 CLAUDE_BIN`
          : result?.subtype === 'error_max_turns' ? '超过最大轮数，任务没做完'
          : /authenticat|OAuth|login/i.test(errText) ? loginErrorMessage()
          : TRANSIENT.test(errText) ? `网络中断，自动重试后仍然失败：${errText.slice(0, 200)}。网络恢复后点「从中断处继续」`
          : (errText.trim() || `claude 退出，代码 ${code}`).slice(0, 500),
      });
    };
    proc.on('error', (err) => finish(null, err));
    proc.on('close', (code) => {
      if (current[lane]?.id === id && current[lane]?.proc === proc) finish(code);
    });
  }

  function say(id, text) {
    const c = Object.values(current).find((x) => x?.id === id);
    if (!c) throw Object.assign(new Error('这个任务没有在运行'), { status: 404 });
    text = String(text || '').trim().slice(0, 1000);
    if (!text) throw Object.assign(new Error('先写要说的话'), { status: 400 });
    if (!store.get('agentRuns', id)?.sessionId) throw Object.assign(new Error('任务刚启动，等几秒再说'), { status: 409 });
    if (c.say) throw Object.assign(new Error('上一句还没处理完，稍等一下'), { status: 409 });
    c.say = text;
    // 进程还在跑就打断它；正在等网络恢复的，会在接着做时带上这句话
    if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill('SIGTERM');
    return true;
  }

  function stop(id) {
    const run = Object.values(current).find((c) => c?.id === id);
    if (!run) return false;
    run.stopped = true;
    if (run.proc.exitCode === null && run.proc.signalCode === null) {
      run.proc.kill('SIGTERM');
    } else {
      // 正在等待自动续跑：进程已经退出，直接收尾
      const lane = Object.keys(current).find((k) => current[k] === run);
      current[lane] = null;
      store.update('agentRuns', id, { status: 'stopped', finishedAt: Date.now() });
    }
    return true;
  }

  return { start, resume, say, stop, running: () => current.main?.id || null };
}
