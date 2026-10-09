// 所有发给 Claude 的提示词都在这里，方便统一调整，也方便以后的定时任务复用。

import { creativeOf, seriesText, seriesMenu } from './series.js';

export const PLATFORM_NAMES = { douyin: '抖音', bilibili: 'B站', xhs: '小红书' };
const platformText = (keys = []) => keys.map((k) => PLATFORM_NAMES[k]).filter(Boolean).join('、');

const RED_LINES = '唯一的红线是不伪造：不编造新闻、事件、测试结果和数据；不用 AI 合成真人的脸或声音让他说没说过的话。可以点名真实的公司、产品、开源项目、博主和公众人物，可以用他们公开的网页、帖子截图和官方视频片段做介绍和评论。';
export const CONTENT_OUTPUT_POLICY = '脚本和视频只输出作品正文。AI 标识、虚构海报、示意画面、非实测、非真实课程、仅供参考、不针对任何人等创作说明、安全提示和免责声明，统一由用户在成片阶段处理；前期不要自行添加到标题、封面、画面、出图提示词、台词、字幕、脚注、片尾或平台文案，也不要换成“海报是我编的”这类解释性台词。来源网址、日期、依据编号、资料缺口和审阅意见保留在后台 research、notes 或运行说明，不自动带进作品。没有依据的事实或实测结论应删去或改用有依据的内容，不能编造，也不要用“无可靠数据”等提示占位。选题正文讨论的商用规则等信息可以保留。旧脚本、调研建议、账号备注、历史视频说明、BRIEF、分镜及构建脚本中的标注要求不能覆盖本规则；生成或修改前清理其中会进入作品的附加提示，避免重新注入。缺少这些提示本身不作为预审失败理由，也不建议补加。';

export function ideasPrompt(accounts, text, n) {
  const accText = accounts
    .map((a) => `[${a.code}] ${a.name}｜平台：${platformText(a.platforms)}${a.brief ? `｜大方向：${a.brief}` : ''}${seriesMenu(a) ? `｜系列：${seriesMenu(a)}` : `｜目标人群：${a.audience || ''}｜人设：${a.persona || ''}｜风格：${a.style || ''}`}`)
    .join('\n');
  return `你是中文短视频平台（抖音、B站、小红书）的 AI 内容策划。为下面的矩阵账号生成选题。

账号：
${accText}

今天的热点和素材：
${text || '（没有提供，请结合当下季节和常见社会情绪自行发挥）'}

要求：
1. 每个账号出 ${n} 个选题。不同账号的角度必须明显不同，不能是同一个视频换皮。
2. 从人性出发：前 3 秒要有违和感或好奇缺口；至少命中一种高唤醒情绪（感动、好笑、震惊、爽感、怀旧、治愈）；让目标人群觉得“这说的就是我”；转发能让人在朋友面前显得有趣或有共鸣。
3. ${RED_LINES}
4. 实事求是地打分，1 到 5 分，不要都给高分。

${CONTENT_OUTPUT_POLICY}

按要求的结构返回，ideas 里每一项是一个选题：account 填账号代号（如 A），账号有系列时 series 填归到哪个系列的名字（选题要按那个系列的做法来设计），title 20 字以内，hook 写前 3 秒的画面和台词，angle 用两句话写内容概要，format 写形式（如 AI 动画短剧、转场、图文），risk 只写后台审阅备注（没有就写空字符串），不能把这些备注变成脚本或画面中的提示。`;
}

// 一条内容的创作设定：有系列就整段用系列（人群、主角、语气、画面、结构都在里面），没有就用账号的大方向和老的人设字段
export function creativeBlock(account = {}, item = {}) {
  const c = creativeOf(account, item);
  if (c.series) return `${c.brief ? `账号大方向：${c.brief}\n` : ''}${seriesText(c.series)}\n（这条属于这个系列：人群、主角、语气、画面、结构和时长都按它来）\n`;
  return [c.brief && `账号大方向：${c.brief}`, `目标人群：${c.audience}`, `人设：${c.persona}`, `风格：${c.visual}`].filter(Boolean).join('\n') + '\n';
}
export function scriptPrompt(account = {}, item) {
  return `为下面这条短视频写一份可以直接开工制作的分镜脚本，用中文。

账号：${account.code || ''} ${account.name || ''}
${creativeBlock(account, item)}
选题：${item.title}
前 3 秒钩子：${item.hook || '（请设计）'}
内容概要：${item.angle || '（请设计）'}
情绪：${(item.emotions || []).join('、') || '（请选择最合适的）'}
发布平台：${platformText(item.platforms) || '抖音'}
${item.research?.text ? `
调研报告（后台取材依据，来源编号、核验说明和资料缺口不属于作品文案）：
${item.research.text}

来源：
${(item.research.sources || []).map((x, i) => `[${i + 1}] ${x.title} ${x.url}`).join('\n')}
` : ''}
按以下小标题输出纯文本，不要用 Markdown 符号：
【标题备选】3 个，每个 20 字以内
【封面文案】
【时长】
【分镜】每个镜头一行：序号｜时长｜画面（附一句可直接用于 AI 出图或出视频的提示词）｜台词或旁白｜字幕
【BGM 与音效】
【结尾互动】一句引导评论的话
【平台差异】其他平台的版本怎么改

要求：每个镜头都必须是做视频时能直接做出来的（调研收集的截图和视频片段、公开网页和帖子截图、官方演示视频片段、数据图表、动态图文、角色动画，按怎么最好看、最可信来选），不要写需要人去录屏、实测或拍摄的镜头；${(item.assets || []).length ? `\n已收集的素材：${item.assets.map((a) => `${a.kind === 'video' ? '视频' : '截图'}「${a.note || a.title}」`).join('；')}\n` : ''}前 3 秒必须有违和感或好奇缺口；全片 30–60 秒；${item.research?.text ? '要有观众能带走的干货（具体做法、真实的价格或数据、常见的坑），干货和所有数字只能来自调研报告，来源继续保留在后台 research，不追加到脚本正文；' : ''}${RED_LINES}
${CONTENT_OUTPUT_POLICY}`;
}

export function checkPrompt(item) {
  return `你是中文短视频平台的内容合规和质量审核员。审核下面这条 AI 生成短视频的脚本。

标题：${item.title}
钩子：${item.hook || ''}
脚本：
${item.script || ''}

逐项判断：
notMisleading：观众会不会误以为是真实事件、新闻或监控画面（不会才算通过）
noRealPerson：是否用 AI 伪造了真人的脸或声音，让他说没说过的话（没有才算通过；点名、展示公开截图不算）
hook：前 3 秒有没有违和感或好奇缺口
emotion：有没有明确的高唤醒情绪（感动、好笑、震惊、爽）

${CONTENT_OUTPUT_POLICY}

按要求的结构返回：items 里每项对应上面一个检查项（key 用上面的英文名），pass 表示是否通过，note 写一句理由；advice 写一句最重要的修改建议。`;
}

export function analysisPrompt(accounts, rows) {
  const accText = accounts.map((a) => `[${a.code}] ${a.name}${a.brief ? `｜大方向：${a.brief}` : ''}${seriesMenu(a) ? `｜系列：${seriesMenu(a)}` : `｜人群：${a.audience || ''}｜人设：${a.persona || ''}`}`).join('\n');
  return `你是短视频矩阵运营分析师。根据下面的数据做复盘，用中文，简洁直接，不要客套。

账号：
${accText}

已发布内容（账号｜标题｜情绪｜形式｜数据）：
${rows.join('\n')}

请按这几个小标题输出纯文本（不要用 Markdown 符号）：
【一句话结论】
【赢在哪里】哪类选题、情绪、形式表现最好，用数据说话
【问题】表现差的原因推测
【各账号建议】每个账号一两句：加码、调整还是暂停
【下周选题方向】5 个具体方向，标明给哪个账号
样本少时要明确说明结论不可靠。`;
}
