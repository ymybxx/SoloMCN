// 在后台调起 Claude Code（claude -p）跑项目里的技能，跑的是和桌面端同一个 Agent：
// 会加载 .claude/skills 和 .mcp.json，能上网搜索，结果通过 workbench MCP 写回工作台。
// 用本机已登录的 Claude 账号，不需要 API Key。每次运行都是一个新会话，会话 id 存下来，
// 可以用 claude --resume <id> 接着看 Claude 当时是怎么想的。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { voicesFile } from './skills.js';
import { ASK_TIMEOUT_MS } from './lab.js';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { claudeBin, cliEnv, loginErrorMessage } from './cli.js';
import { credentials } from './credentials.js';
import { modelFor, effortFor } from './models.js';
import { CONTENT_OUTPUT_POLICY } from './prompts.js';

// 已有调研报告在这个天数内，重新调研时默认在它基础上补
export const REUSE_DAYS = 7;
// 每次运行的能力都一样全：读写文件、执行命令、上网、加载技能、开子代理，加上 workbench 的 MCP 工具。
// 你配过的钥匙和登录也直接给它（见 credentials.js）。具体做什么由技能和任务决定，不按任务拆权限
const ALL_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'Agent', 'TodoWrite', 'ToolSearch', 'WebSearch', 'WebFetch'];
const ALLOWED_TOOLS = ['mcp__workbench__*', ...ALL_TOOLS];
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
  // 拆解一条 YouTube 视频：读字幕、简介和热门评论，写成拆解报告存到这条视频上（精选、出题、调研都复用）
  teardown: {
    name: '拆解视频',
    maxTurns: 25,
    lane: 'teardown',
    prompt: ({ videoId, redo }) => `/teardown-video 视频 id：${videoId}${redo ? '；重新拆解' : ''}`,
  },
  // 写脚本之前先调研：上网查真实的价格、能力、步骤和反方观点，写成带出处的报告存到卡片上
  // 调研可以动手实践：这条内容的代码、实验、结果放实验目录（videos/lab-<内容 id>/）
  research: {
    name: '调研',
    maxTurns: 120,
    lab: true,
    prompt: ({ itemId, labDir, programsDir, askAboveGB, prior, craft }) => `/research-topic 内容 id：${itemId}${craft ? `；做法：${craft}` : ''}；实验目录：${labDir}；已装程序目录：${programsDir}；单个下载超过 ${askAboveGB} GB 先问用户${prior ? `；${prior}` : ''}`,
  },
  // 下面三个在「设置」里选成「后台 Agent」时走这里，选「单次调用」时走 cli.js
  script: {
    name: '写脚本',
    maxTurns: 30,
    prompt: ({ itemId, rewrite, feedback }) => `/write-script 内容 id：${itemId}${feedback ? `；按意见修改：${feedback}` : rewrite ? '；重写' : ''}`,
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
  // 生成视频：把脚本做成 MP4，要跑几十分钟，走单独的队列，不挡精选、写脚本
  video: {
    name: '生成视频',
    lane: 'video',
    maxTurns: 400,
    prompt: ({ itemId, craft }) => `/make-video 内容 id：${itemId}${craft ? `；做法：${craft}` : ''}`,
  },
  // 按人的修改意见改已经做好的视频：只改提到的地方，重新渲染成新版本，旧版本保留
  revise: {
    name: '修改视频',
    lane: 'video',
    maxTurns: 200,
    prompt: ({ itemId, feedback, images = [], craft }) => `/revise-video 内容 id：${itemId}${craft ? `；做法：${craft}` : ''}\n修改意见：\n${feedback}` +
      (images.length ? `\n附图（用读文件工具逐张查看）：\n${images.map((p, i) => `图 ${i + 1}：${path.join(ROOT, p)}`).join('\n')}` : ''),
  },
  // 改进技能：按想法、运行中提的建议、有冲突的出厂更新、定期整理，在草稿里改技能（见 skills.js），
  // 改完按设置直接生效或等用户确认
  skills: {
    name: '改进技能',
    lane: 'skills',
    maxTurns: 150,
    prompt: ({ changeId, mode, draft, extra }) => `/improve-skills 改动 id：${changeId}；方式：${mode}；草稿目录：${draft}${extra ? `\n${extra}` : ''}`,
  },
};

// 自我进化开着时，每次运行的提示里多一段：遇到坑就直接改进对应的技能（跑完平台对比、记一条技能改动）
// 找文件别在整个家目录里大范围搜：会碰到别的 App 的私有文件夹，macOS 会弹窗问用户要不要允许
const WHERE_TO_LOOK = `找文件只在工作台项目目录（${ROOT}）和任务里明确给出的位置找。不要在整个家目录、~/Library、/ 这类大范围里 find、grep、ls -R：会碰到别的 App 的数据，系统会弹窗打扰用户。`;
const EVOLVE = '自我进化开着：这次做的时候，如果遇到了技能里没写到的坑、写错的地方，或者找到了明显更好的做法，做完后直接改对应技能的文件（.claude/skills/<技能名>/ 下）：做法的坑改做法技能，工具的坑改工具技能，通用流程的问题改流程技能。要改，不要只往后追加：同主题的合并，过时的删掉；SKILL.md 保持简短，细节放附录。只为以后的运行改，不为了这一次临时改。最后在汇报里单独一行写「技能改动：改了什么、为什么」。';

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
  lab_ask_claude: '问 Claude',
  x_search: '搜索推特',
  x_user_tweets: '读取推特用户',
  x_list_timeline: '读取推特列表',
  x_pool_status: '查看推特号池',
  youtube_search: '搜索 YouTube',
  bilibili_search: '搜索 B站视频',
  bilibili_video: '读取 B站视频',
  bilibili_highlights: '找 B站高能时刻',
  bilibili_preview: '预览 B站视频画面',
  vet_footage: '直拍体检',
  capture_bilibili: '剪 B站片段',
  youtube_videos: '读取 YouTube 视频',
  youtube_comments: '读取 YouTube 评论',
  youtube_transcript: '读取 YouTube 字幕',
  get_teardown: '读取拆解报告',
  save_teardown: '保存拆解报告',
};

const TOOL_NAMES_EN = {
  get_feed: 'Read trends', get_hot_topics: 'Read trending lists', get_overseas_hot: 'Read overseas trends', get_accounts: 'Read channel profiles',
  get_recent_context: 'Read recent ideas and results', get_picks: 'Read picks', add_picks: 'Save picks', add_ideas: 'Save ideas',
  get_item: 'Read item and profile', save_script: 'Save script', save_precheck: 'Save precheck', get_published: 'Read published stats',
  save_analysis: 'Save review', save_video: 'Save video', save_research: 'Save research', lab_ask_claude: 'Ask Claude', capture_source: 'Capture page',
  x_search: 'Search X', x_user_tweets: 'Read X user', x_list_timeline: 'Read X list', x_pool_status: 'Check X account pool',
  youtube_search: 'Search YouTube', bilibili_search: 'Search Bilibili', bilibili_video: 'Read Bilibili videos', bilibili_highlights: 'Find Bilibili highlights', bilibili_preview: 'Preview Bilibili video', vet_footage: 'Vet footage', capture_bilibili: 'Clip Bilibili video', youtube_videos: 'Read YouTube videos', youtube_comments: 'Read YouTube comments',
  youtube_transcript: 'Read YouTube captions', get_teardown: 'Read teardown', save_teardown: 'Save teardown',
};
const CHANNEL_NAMES_EN = { x: 'X', youtube: 'YouTube', douyin: 'Douyin', weibo: 'Weibo', bilibili: 'Bilibili', zhihu: 'Zhihu', baidu: 'Baidu', toutiao: 'Toutiao', 'bilibili-video': 'Bilibili videos', hackernews: 'Hacker News' };

const CHANNEL_NAMES = { x: '推特', youtube: 'YouTube', douyin: '抖音', weibo: '微博', bilibili: 'B站', zhihu: '知乎', baidu: '百度', toutiao: '头条', 'bilibili-video': 'B站热门视频', hackernews: 'Hacker News' };

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
  if ((short === 'x_search' || short === 'youtube_search') && input.q) return `${label}：${input.q}`;
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
  if ((short === 'x_search' || short === 'youtube_search') && input.q) return `${label}: ${input.q}`;
  if (short === 'add_picks') return `${label}: ${input.picks?.length ?? ''}`;
  if (short === 'add_ideas') return `${label}: ${input.ideas?.length ?? ''}`;
  return label;
}


// 正在输出的工具参数是一段没写完的 JSON：从里面取出最长的字符串值（比如 save_script 的脚本正文），
// 最后一个字符串可能还没写完，也一样取出来
export function longestString(raw) {
  let best = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '"') continue;
    let s = '', j = i + 1, done = false;
    while (j < raw.length) {
      const c = raw[j];
      if (c === '\\') {
        const n = raw[j + 1];
        if (n === undefined) break;
        if (n === 'u') { const hex = raw.slice(j + 2, j + 6); if (hex.length < 4) break; s += String.fromCharCode(parseInt(hex, 16)); j += 6; continue; }
        s += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }[n] ?? n; j += 2; continue;
      }
      if (c === '"') { done = true; break; }
      s += c; j++;
    }
    let k = j + 1;
    while (done && /\s/.test(raw[k] || '')) k++;
    if (done && k >= raw.length) break; // 刚写完、还不知道是键名还是值
    if (!(done && raw[k] === ':') && s.length > best.length) best = s; // 后面跟冒号的是键名，不算
    if (!done) break;
    i = j;
  }
  return best;
}

export function createAgent({ store, cwd, lab, skills, hooks = {} }) {
  const uiLang = () => (store.get('settings', 'ui')?.lang === 'en' ? 'en' : 'zh');
  // 每条队列同一时间只跑一个任务：main（精选、出题、写脚本……）和 video（生成视频）互不阻塞
  const current = {}; // lane -> { id, proc, stopped }
  const busyMsg = (lane) => ({ video: '已经有一个视频在生成，等它结束或先停止', teardown: '已经有一条视频在拆解，等它结束或先停止' })[lane] || 'Claude 正在跑另一个任务，等它结束或先停止';
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
      const catalog = JSON.parse(readFileSync(voicesFile(cwd), 'utf8'));
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
    if (task === 'teardown') {
      if (!/^[A-Za-z0-9_-]{11}$/.test(args.videoId || '')) throw Object.assign(new Error('没认出视频 id'), { status: 400 });
      args.redo = !!args.redo;
    }
    if (task === 'research') {
      if (!ID_RE.test(args.itemId || '') || !store.get('items', args.itemId)) throw Object.assign(new Error('找不到这条内容'), { status: 400 });
      args.labDir = lab.dirOf(args.itemId);
      args.programsDir = lab.toolsDir;
      args.askAboveGB = lab.settings().askAboveGB;
      // 已有报告：7 天内默认在它基础上补；超过 7 天或用户选了「从头查」就全部重查
      const at = store.get('items', args.itemId).research?.at;
      const days = at ? Math.floor((Date.now() - at) / 86_400_000) : null;
      const fresh = !!args.fresh;
      delete args.fresh;
      args.prior = days === null ? '' : fresh ? `已有 ${days} 天前的调研报告，用户要求从头查` : days > REUSE_DAYS ? `已有 ${days} 天前的调研报告，已超过 ${REUSE_DAYS} 天，从头查` : `已有 ${days} 天前的调研报告，在它基础上补`;
    }
    if (task === 'script') {
      args.feedback = String(args.feedback || '').trim().slice(0, 2000);
      args.rewrite = !args.feedback && !!args.rewrite;
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
    // 这条内容用的做法技能：写脚本时定的，或者系列指定的
    if (['research', 'video', 'revise'].includes(task)) {
      const it = store.get('items', args.itemId);
      const acc = it?.accountId && store.get('accounts', it.accountId);
      args.craft = it?.craft || (acc?.series || []).find((x) => x.id === it?.seriesId)?.craft || '';
    }
    if (task === 'skills') {
      const r = skills?.rec(args.changeId);
      if (!r) throw Object.assign(new Error('没有这条技能改动'), { status: 400 });
      args.draft = skills.draftDir(args.changeId);
      args.mode = { idea: '想法', suggest: '运行中发现', update: '合并出厂更新', tidy: '整理' }[r.source] || '想法';
      const lines = [];
      if (r.source === 'idea') lines.push(`想法：${r.idea}`);
      if (r.source === 'suggest') lines.push(`建议来自一次${r.task ? `「${TASKS[r.task]?.name || r.task}」` : ''}运行${r.target ? `，它觉得该改 ${r.target}` : ''}：\n${r.suggestion}`);
      if (r.source === 'update') { const d = skills.mergeDirs(args.changeId); lines.push(`要合并的技能：${(r.skills || []).join('、')}；旧出厂版：${d.old}；新出厂版：${d.next}；三方合不上的文件：${(r.conflicts || []).join('、')}`); }
      const last = (r.refines || []).slice(-1)[0];
      if (last) lines.push(`你上一轮已经在草稿里改过（改动都还在草稿里），当时的说明：\n${r.summary || '（无）'}\n用户看了以后说：「${last.text}」\n在草稿的基础上接着改。`);
      args.extra = lines.join('\n');
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
      throw Object.assign(new Error(busyMsg(lane)), { status: 409 });
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
    try { hooks.onStart?.(id, task, args); } catch {}
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
    if (current[lane]) throw Object.assign(new Error(busyMsg(lane)), { status: 409 });
    const run = { ...saved, status: 'running', error: null, finishedAt: null, resumes: (saved.resumes || 0) + 1, steps: [...(saved.steps || [])] };
    run.steps.push({ at: Date.now(), kind: 'text', text: '从中断处继续' });
    await store.update('agentRuns', id, { status: 'running', error: null, finishedAt: null, resumes: run.resumes, steps: run.steps });
    try { hooks.onStart?.(id, saved.task, saved.args || {}); } catch {}
    launch({ id, run, task: saved.task, t, lane, prompt: RESUME_PROMPT, resumeSession: saved.sessionId });
    return { id, ...run };
  }

  // 跑完的任务追加要求：接上原来的会话（Claude 记得做过什么，实验目录里的文件也都在），只做补充的部分
  const FOLLOWUP_PROMPT = (text) => `用户看了你这次的结果，追加了一个要求：\n「${text}」\n在原来的基础上补做这一点，已经做好的不要重做。` +
    '做完把调研报告更新完整（重新调用 save_research 保存全文，补上新做的部分），新的素材照常存，最后两三句话汇报这次补了什么。';
  async function followUp(id, text) {
    const saved = store.get('agentRuns', id);
    if (!saved) throw Object.assign(new Error('找不到这次运行'), { status: 404 });
    if (saved.status === 'running') throw Object.assign(new Error('这次运行还在进行中，可以直接插话'), { status: 409 });
    if (!saved.sessionId) throw Object.assign(new Error('这次运行没有留下会话，只能重新开始'), { status: 400 });
    text = String(text || '').trim().slice(0, 1500);
    if (!text) throw Object.assign(new Error('先写要追加的要求'), { status: 400 });
    const t = TASKS[saved.task];
    if (!t) throw Object.assign(new Error('没有这个任务'), { status: 400 });
    const lane = laneOf(saved.task);
    if (current[lane]) throw Object.assign(new Error(busyMsg(lane)), { status: 409 });
    const run = { ...saved, status: 'running', error: null, finishedAt: null, steps: [...(saved.steps || [])], followUps: [...(saved.followUps || []), { at: Date.now(), text }] };
    run.steps.push({ at: Date.now(), kind: 'text', text: `追加要求：${text}` });
    await store.update('agentRuns', id, { status: 'running', error: null, finishedAt: null, steps: run.steps, followUps: run.followUps });
    try { hooks.onStart?.(id, saved.task, saved.args || {}); } catch {}
    launch({ id, run, task: saved.task, t, lane, prompt: FOLLOWUP_PROMPT(text), resumeSession: saved.sessionId });
    return { id, ...run };
  }

  function launch({ id, run, task, t, lane, prompt, resumeSession = null, autoResumes = 0 }) {
    if (t.lab && lab) lab.prepare(run.args.itemId);
    // 你配过的钥匙和登录直接放进环境变量，提示里列出名字（不用工具的任务不给）
    const cred = t.tools === '' ? { env: {}, prompt: '' } : credentials(cwd);
    // 等人处理（登录、付款）最多 40 分钟，工具调用不能先超时
    const env = { ...cliEnv(), ...cred.env, MCP_TOOL_TIMEOUT: String(ASK_TIMEOUT_MS + 5 * 60_000) };
    const proc = spawn(
      claudeBin(),
      // 每次都指定模型（页面「设置」里选的）：不指定就用账号当时的默认模型，Opus 额度用完会悄悄换成 Sonnet
      ['-p', prompt, ...(resumeSession ? ['--resume', resumeSession] : []),
        '--model', modelFor(store, task), '--effort', effortFor(store, task), '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--max-turns', String(t.maxTurns),
        '--append-system-prompt', [LANG_PROMPTS[uiLang()], CONTENT_OUTPUT_POLICY, t.tools !== '' ? WHERE_TO_LOOK : '', t.tools !== '' && skills?.settings().evolve ? EVOLVE : '', cred.prompt].filter(Boolean).join('\n'),
        '--permission-mode', 'dontAsk', '--tools', t.tools ?? ALL_TOOLS.join(','),
        ...(t.tools === '' ? [] : ['--allowedTools', ALLOWED_TOOLS.join(',')]),
        ...(t.schema ? ['--json-schema', JSON.stringify(t.schema)] : [])],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const prev = current[lane];
    current[lane] = { id, proc, stopped: prev?.id === id ? prev.stopped : false, say: prev?.id === id ? prev.say : null };

    let dirty = false;
    const flush = () => {
      if (!dirty) return;
      dirty = false;
      run.live = liveView();
      store.update('agentRuns', id, { steps: run.steps, sessionId: run.sessionId, model: run.model || null, live: run.live });
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
    // 正在写的那一段（文字、思考、工具参数），页面上显示「正在写：已写 N 字」和最新写出的部分
    let block = null;
    run.live = null;
    const liveView = () => {
      if (!block) return null;
      if (block.kind === 'thinking') return { kind: 'thinking', label: '思考', chars: block.raw.length, tail: '' };
      if (block.kind === 'text') return { kind: 'text', label: '说', chars: block.raw.length, tail: block.raw.slice(-1500) };
      const text = longestString(block.raw);
      return { kind: 'tool', label: describeTool(block.name, {}, uiLang()), chars: text.length, tail: text.slice(-1500) };
    };
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
        if (ev.type === 'stream_event') {
          const e = ev.event || {};
          if (e.type === 'content_block_start') block = { kind: e.content_block?.type === 'tool_use' ? 'tool' : e.content_block?.type === 'thinking' ? 'thinking' : 'text', name: e.content_block?.name || '', raw: '' };
          else if (e.type === 'content_block_delta' && block) { const d = e.delta || {}; block.raw += d.text ?? d.partial_json ?? d.thinking ?? ''; }
          else if (e.type === 'content_block_stop') block = null;
          dirty = true;
          continue;
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
              store.update('agentRuns', id, { status: 'stopped', finishedAt: Date.now(), steps: run.steps }).then(() => ended(id));
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
      ended(id);
    };
    proc.on('error', (err) => finish(null, err));
    proc.on('close', (code) => {
      if (current[lane]?.id === id && current[lane]?.proc === proc) finish(code);
      // 调研结束：清掉下载缓存和解压过的安装包
      if (t.lab && lab) try { lab.afterRun(run.args.itemId); } catch {}
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
      store.update('agentRuns', id, { status: 'stopped', finishedAt: Date.now() }).then(() => ended(id));
    }
    return true;
  }
  // 一次运行彻底结束（做完、失败、被停）：通知外面（技能改动要收尾、视频运行要对比技能）
  function ended(id) {
    const r = store.get('agentRuns', id);
    if (r) Promise.resolve().then(() => hooks.onDone?.(id, r.task, r)).catch((e) => console.error('运行收尾出错：', e.message));
  }

  // 工作台退出时：停掉所有正在跑的 Claude 进程（下次启动时这些运行会标成「被中断」，可以从中断处继续）
  function killAll() {
    for (const c of Object.values(current)) if (c?.proc && c.proc.exitCode === null && c.proc.signalCode === null) try { c.proc.kill('SIGTERM'); } catch {}
  }

  return { start, resume, followUp, say, stop, killAll, running: () => current.main?.id || null, runningIn: (lane) => current[lane]?.id || null, busy: (lane) => !!current[lane] };
}
