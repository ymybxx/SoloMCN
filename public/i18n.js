// 界面语言：中文 / English。
// 页面照常用中文渲染，切到英文时，把界面上的固定文字按下面的对照表换成英文：
// 先整句精确匹配（EN），再按带数字、名字的句式匹配（PATTERNS）。对照表里没有的文字原样显示中文，
// 所以你的内容（选题、脚本、Claude 写的报告）不会被改动；新增界面文字忘了翻译也只是显示中文，补一行就行。
(function () {
  const KEY = 'wb.lang';
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (_) {}
  const lang = saved || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
  window.UI_LANG = lang;
  window.setUiLang = (l) => {
    try { localStorage.setItem(KEY, l); } catch (_) {}
    location.reload();
  };
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  if (lang !== 'en') return;

  const EN = {
    // ---- 顶栏、步骤、导航 ----
    '一人 MCN · 抖音 / 小红书 / B站 / YouTube': 'One-person MCN · Douyin / Xiaohongshu / Bilibili / YouTube',
    '渠道': 'Sources', '素材': 'Feed', '选题雷达': 'Topic radar', '账号选题': 'Ideas', '流水线': 'Pipeline',
    '总览': 'Overview', '日历': 'Calendar', '数据复盘': 'Analytics', '账号矩阵': 'Channels', '设置': 'Settings',
    '已连接本地服务': 'Connected', '连接中': 'Connecting', '服务未启动': 'Service not running',
    'Claude 正忙': 'Claude is busy', 'Claude 登录失效': 'Claude login expired', 'Claude 生成中': 'Claude generating',
    '点一个阶段直接跳过去': 'Click a stage to jump to it',
    // ---- 通用 ----
    '保存': 'Save', '保存中…': 'Saving…', '保存失败': 'Save failed', '已保存': 'Saved', '取消': 'Cancel', '关闭': 'Close',
    '删除': 'Delete', '删除失败': 'Delete failed', '已删除': 'Deleted', '确认删除': 'Confirm delete', '再点一次确认删除': 'Click again to delete',
    '编辑账号': 'Edit channel', '复制': 'Copy', '已复制': 'Copied', '复制失败，手动选中复制': 'Copy failed, select and copy manually',
    '打开': 'Open', '查看': 'View', '收起': 'Collapse', '全部': 'All', '新建': 'New', '重试': 'Retry', '恢复': 'Restore',
    '停止': 'Stop', '停止失败': 'Stop failed', '已停止': 'Stopped', '已停止。': 'Stopped.', '完成': 'Done', '失败': 'Failed',
    '出错': 'Error', '正常': 'OK', '运行中': 'Running', '正在启动…': 'Starting…', '正在读取…': 'Loading…', '读取中…': 'Loading…',
    '读取失败': 'Load failed', '操作': 'Actions', '操作失败': 'Action failed', '启动失败': 'Failed to start', '生成': 'Generate',
    '生成中': 'Generating', '生成中…': 'Generating…', '生成失败': 'Generation failed', '重新生成': 'Regenerate',
    '检查': 'Check', '检查中…': 'Checking…', '检查失败': 'Check failed', '管理': 'Manage', '说明': 'Notes', '备注': 'Notes',
    '名称': 'Name', '代号': 'Code', '颜色': 'Color', '平台': 'Platforms', '标题': 'Title', '描述': 'Description', '正文': 'Body',
    '简介': 'Description', '话题': 'Hashtags', '标签': 'Tags', '时长': 'Duration', '视频': 'Video', '截图': 'Screenshot',
    '新': 'New', '更新': 'updated', '注意': 'Caution', '避开': 'Avoid', '通过': 'Pass',
    '今天': 'Today', '分钟': 'min', '小时': 'h', '步骤': 'Step',
    '· 完成': '· done', '· 失败': '· failed', '· 已停止': '· stopped', '· 登录失效': '· login expired',
    '请求失败（': 'Request failed (', '记下了': 'Noted',
    // ---- 渠道 ----
    '每个渠道单独配置多久抓一次、抓什么，保存后下一轮抓取就生效': 'Each source has its own schedule. Changes apply from the next fetch.',
    '抓取设置': 'Fetch settings', '多久抓一次': 'Fetch every', '恢复默认': 'Reset to default', '放弃改动': 'Discard changes',
    '有改动没保存': 'Unsaved changes', '抓的是什么': 'What it fetches', '立即抓取': 'Fetch now', '抓取中': 'Fetching', '抓取中…': 'Fetching…',
    '抓取失败': 'Fetch failed', '抓取失败：': 'Fetch failed: ', '还没抓过': 'Never fetched', '上次': 'Last', '下次': 'Next', '抓到': 'got',
    '累计': 'Total', '未接入': 'Not connected', '正在读取渠道状态…': 'Loading source status…',
    '已保存，下一轮抓取起生效。想马上看效果可以点「立即抓取」': 'Saved. Applies from the next fetch; click "Fetch now" to see it right away.',
    '抖音网页版的热搜榜，50 条，加 5 条左右「实时上升」：还没进前 50、正在往上涨的词。不用登录，不占推特号池': 'Douyin web trending list: top 50 plus about 5 "rising" terms that are climbing but not yet in the top 50. No login needed.',
    '每个词有热度值、排名、开始上榜的时间、最高排名、相关视频数，链接是抖音的热点详情页': 'Each term has a heat value, rank, time it entered the list, best rank and related video count, linking to Douyin\'s trend page.',
    '热搜词下面每条视频的点赞、评论要请求签名才能拿，不做破解，所以没有': 'Per-video likes and comments under a term need signed requests; we don\'t crack those, so they\'re not included.',
    '灾难、时政、刑案等词条会自动标出风险': 'Disasters, politics, crime and similar terms are flagged automatically',
    '公开接口，不用登录；和国内热榜聚合共用缓存，同一来源 10 分钟内不重复请求': 'Public endpoints, no login. Shares a cache with the aggregated lists; each source is requested at most once every 10 minutes.',
    'Claude 精选时还会读跨平台聚合：同一件事在几个平台同时上榜，会合并打分': 'Curation also reads the cross-platform aggregate: the same story trending on several platforms is merged and scored together.',
    '小红书': 'Xiaohongshu',
    '小红书没有公开的热榜。网页接口要登录，每个请求还要带它前端算出来的签名，不带直接拒绝；拿数据就得破解签名，等于绕过它的反爬保护，所以不做。': 'Xiaohongshu has no public trending list. Its web API needs a login and a signature computed by its front end; getting data would mean cracking that, which bypasses its anti-scraping protection, so we don\'t.',
    '现在的做法：Claude 精选时上网搜几次小红书趋势；你刷到值得做的，在「素材」页之外也可以直接把想法告诉 Claude。': 'For now, Claude searches the web for Xiaohongshu trends during curation. You can also tell Claude directly about anything you spot.',
    '要接入的话': 'If you want to connect it',
    '第三方数据平台（千瓜、新红、灰豚等）的正式接口：有热门笔记、热搜词和互动数据，最稳定，要付费': 'Official APIs from third-party data platforms (Qiangua, Xinhong, Huitun…): trending notes, search terms and engagement data. Most reliable, paid.',
    '在 Claude 桌面端手动跑精选时，让 Claude 用你自己登录了小红书的 Chrome 看热点页：不用破解，但只能手动、低频': 'When running curation by hand in the Claude desktop app, let Claude browse the trend pages in your own logged-in Chrome: no cracking, but manual and low-frequency.',
    '热点数据服务': 'Trends service', '热点数据服务没有响应': 'Trends service is not responding',
    // ---- 素材 ----
    '各渠道定时抓到的原始内容。精选交给下一步的 Claude；看到想做的，也可以直接送进选题雷达': 'Raw items fetched from each source. Claude curates them next; you can also send anything straight to the topic radar.',
    '实时上升': 'Rising', '还没进前 50，正在往上涨': 'not in the top 50 yet, climbing', '上榜': 'On list', '送入': 'Send', '送进选题雷达': 'Send to radar',
    '已送进选题雷达，可以直接给账号出题': 'Sent to the radar. You can make ideas from it now.', '还没有数据': 'No data yet',
    '抖音': 'Douyin', '微博': 'Weibo', 'B站': 'Bilibili', '知乎': 'Zhihu', '百度': 'Baidu', '头条': 'Toutiao', 'B站热门视频': 'Bilibili popular videos', '网页': 'Web',
    // ---- 选题雷达 ----
    'Claude 读这一轮各渠道的素材，挑出值得做的主题；你决定给哪些账号出题，或者不做': 'Claude reads this round of trends and picks topics worth making. You decide which channels get ideas, or skip.',
    '让 Claude 精选': 'Let Claude curate', 'Claude 精选中…': 'Claude is curating…', 'Claude 开始精选，一般要几分钟': 'Claude started curating; usually takes a few minutes',
    '待决定': 'To decide', '没有待决定': 'Nothing to decide', '没有待决定的主题': 'No topics to decide',
    '点「让 Claude 精选」，或者在「素材」里把单条素材送进来': 'Click "Let Claude curate", or send single items from the Feed',
    '给账号出题': 'Make ideas', '给哪些账号出题': 'Which channels', '每个账号出几个': 'Ideas per channel', '开始出题': 'Start',
    'Claude 出题中…': 'Claude is writing ideas…', 'Claude 开始出题': 'Claude started writing ideas', '不做': 'Skip', '不做的': 'Skipped',
    '已出题': 'Ideas made', '切入': 'Angle', '适合': 'Fits', '全屏查看': 'Full screen', '展开过程和说明': 'Show process and notes',
    '手动送入': 'Added by hand', '看出错时的截图': 'See error screenshot',
    // ---- 账号选题 ----
    'Claude 按账号人设给精选主题出的选题。挑好的加入流水线，其余丢掉': 'Ideas Claude wrote for each channel. Add the good ones to the pipeline and drop the rest.',
    '加入流水线': 'Add to pipeline', '丢掉': 'Drop', '没有待挑': 'Nothing to pick', '没有待挑的选题': 'No ideas waiting',
    '在「选题雷达」里给精选主题点「给账号出题」': 'On the Topic radar, click "Make ideas" on a topic', '已加入流水线的「选题」列': 'Added to the Ideas column of the pipeline',
    '再出一轮': 'Another round', '代入': 'Relatable', '好奇': 'Curiosity', '好笑': 'Funny', '感动': 'Moving', '震惊': 'Shock', '爽感': 'Satisfying',
    '怀旧': 'Nostalgia', '治愈': 'Soothing', '反差': 'Contrast', '借势': 'Rides trend', '钩子': 'Hook', '情绪': 'Emotion',
    '为什么现在做：': 'Why now: ', '风险备注（供参考）：': 'Risk notes (for reference): ',
    // ---- 流水线 ----
    '内容流水线': 'Content pipeline', '点卡片打开详情：写脚本、审核、排期、填数据': 'Open a card to write the script, review, schedule and record data',
    '全部账号': 'All channels', '选题': 'Ideas', '脚本': 'Script', '生产中': 'In production', '待发布': 'Ready', '已发布': 'Published',
    '有成片': 'Has video', '新选题': 'New idea', '还没排期': 'Not scheduled', '排期已过，发了吗？': 'Past schedule. Published?',
    // ---- 内容详情 ----
    '前 3 秒钩子': 'First-3-seconds hook', '内容概要': 'Summary', '调研': 'Research', '后台 Agent · 上网查资料': 'Background agent · web research',
    'AI 调研': 'AI research', '重新调研': 'Research again', '调研中…': 'Researching…', '确认重新调研？': 'Research again?',
    'Claude 开始调研，一般 3–10 分钟，报告会存到这张卡片上': 'Claude started researching (3–10 minutes); the report will be saved on this card',
    '写脚本之前先调研：上网查真实的价格、工具能力、操作步骤和反方观点，写成每条都有出处的报告；同时把能当画面的网页截图和官方视频收集成素材，做视频时直接用。写脚本时会以它为依据，台词里的数字都能追溯来源。一般 3–10 分钟。': 'Research before scripting: real prices, capabilities, steps and counter-arguments from the web, each with a source, plus web captures and official videos collected as footage. The script is based on it, so every number traces back to a source. Usually 3–10 minutes.',
    '分镜脚本': 'Storyboard script', 'AI 写脚本': 'AI script', '写脚本': 'Write script', '脚本会自动保存。': 'The script saves automatically.',
    '确认覆盖现有脚本？': 'Overwrite the current script?', 'Claude 正在写脚本，通常 20–60 秒开始出字。': 'Claude is writing the script; text usually starts in 20–60 seconds.',
    'Claude 开始写脚本，写完会自动存回，可以先去做别的': 'Claude started writing the script; it saves back automatically',
    '后台 Agent 会先读账号人设，需要时上网查热点背景，写完自动存回这里。可以关掉详情去做别的。': 'The background agent reads the channel profile, searches the web when needed and saves back here. You can close this and do something else.',
    '写着呢…': 'Writing…', '脚本太长被截断了，可以手动补完': 'The script was cut off for length; finish it by hand',
    'AI 重写': 'AI rewrite', '按这句重写': 'Rewrite to this', '退回上一版': 'Undo to previous version',
    '预审': 'Precheck', 'AI 预审': 'AI precheck', '预审中…': 'Checking…', 'Claude 开始预审': 'Claude started the precheck',
    '不误导': 'Not misleading', '不伪造真人': 'No fake people', '不贩卖焦虑': 'No fear-mongering',
    '不会让人误以为是真实事件、新闻或监控画面': 'Won\'t be mistaken for a real event, news or surveillance footage',
    '没有用 AI 伪造真人的脸或声音': 'No AI-faked faces or voices of real people', '前 3 秒有违和感或好奇缺口': 'The first 3 seconds have a twist or curiosity gap',
    '命中至少一种高唤醒情绪：感动、好笑、震惊、爽': 'Hits at least one high-arousal emotion: moving, funny, shocking, satisfying',
    '和矩阵里其他账号的内容不同，不是换皮复用': 'Different from other channels\' content, not a reskin',
    '生成视频': 'Generate video', '视频生成中': 'Generating video', '视频生成失败': 'Video generation failed', '已有视频在生成': 'A video is already being generated',
    'Claude 开始生成视频，一般要 20–60 分钟，可以先去做别的': 'Claude started making the video; usually 20–60 minutes',
    '按脚本做成成片 MP4，包含配音、字幕和动画。前期不加创作声明或安全提示，统一留给你在成片阶段处理。一般要 20–60 分钟，消耗的订阅额度比写脚本多得多；可以关掉详情去做别的。': 'Turns the script into an MP4 with voice-over, captions and animation. Usually 20–60 minutes and uses far more of your subscription than a script. You can close this and do something else.',
    '让 Claude 修改': 'Ask Claude to revise', '按意见修改': 'Revise', '修改意见': 'Feedback', '停止修改': 'Stop revising',
    'Claude 开始修改，改好会生成新的一版': 'Claude started revising; a new version will be added',
    '只改你提到的地方，渲染成新的一版，旧版本保留。一般 10–30 分钟。': 'Only what you mention is changed and rendered as a new version; old versions are kept. Usually 10–30 minutes.',
    '也可以在意见框里直接粘贴截图（Cmd + V），或把图片拖进来。': 'You can paste screenshots (Cmd + V) or drag images into the feedback box.',
    '添加图片': 'Add image', '最多附 8 张图': 'Up to 8 images', '只支持 PNG、JPG、WebP 图片': 'Only PNG, JPG and WebP images',
    '截取当前画面': 'Capture current frame', '标记当前时间': 'Mark current time', '截取失败：视频没加载出来': 'Capture failed: the video didn\'t load',
    '缩略图拼图': 'Contact sheet', '从中断处继续': 'Resume', '从中断处继续了': 'Resumed', '继续失败': 'Resume failed',
    '接着上次的会话做，已经做好的部分不会重做': 'Continues the previous session; finished parts won\'t be redone',
    '用本机视频': 'Use a local video', '用这条视频': 'Use this video', '视频文件': 'Video file', '选择文件…': 'Choose file…', '在选文件…': 'Choosing…',
    '先选视频文件或粘贴路径': 'Choose a video file or paste its path first', '打不开选文件窗口，直接粘贴路径': 'Couldn\'t open the file picker; paste the path instead',
    '这条视频讲什么': 'What this video is about', '（可选，写个大概方向；Claude 还会自己看画面、听语音）': '(optional, a rough direction; Claude also watches and listens to the video)',
    '（直接用原文件，不会复制一份）': '(uses the original file, no copy)',
    '用了之后卡片直接进「待发布」。后面照常生成标题、简介、话题和封面，勾平台发布。原文件不要移动或删除，发布时直接读它。': 'The card moves to Ready. Generate titles, descriptions, hashtags and covers as usual, then publish. Don\'t move or delete the original file; publishing reads it directly.',
    '好了，卡片进了「待发布」。Claude 在看这条视频，看完就能生成发布信息': 'Done, the card is in Ready. Claude is watching the video; you can generate publish info once it\'s done',
    'Claude 正在看这条视频：截画面、听语音，一般不到一分钟…': 'Claude is watching the video: grabbing frames and listening, usually under a minute…',
    '先等 Claude 看完视频…': 'Wait for Claude to finish watching the video…', '没有语音': 'No speech', '重新看': 'Watch again',
    '各平台数据': 'Platform stats', '发布后从创作者中心抄过来': 'Copy these from each creator dashboard after publishing',
    '播放': 'Views', '点赞': 'Likes', '评论': 'Comments', '分享': 'Shares', '转发': 'Shares', '涨粉': 'Followers +', '还没填数据': 'No data yet',
    '删除这条内容': 'Delete this item', '确认删除？内容会保留': 'Delete? The content is kept',
    // ---- 发布 ----
    '发布': 'Publish', '生成发布信息': 'Generate publish info', '重新生成发布信息': 'Regenerate publish info',
    '视频做好后在这里生成封面、标题和话题，确认后勾选平台发布。': 'Once the video is ready, generate covers, titles and hashtags here, then pick platforms and publish.',
    '点「生成发布信息」：Claude 按脚本给每个平台写标题、描述和话题，再做封面（配了图片生成就用 AI 画，没配就从成片里截一帧）。都可以改。': 'Click "Generate publish info": Claude writes a title, description and hashtags for each platform, then makes covers (AI-drawn if image generation is set up, otherwise a frame from the video). Everything is editable.',
    'Claude 在补写缺的平台文案，约半分钟': 'Claude is writing copy for the missing platforms, about 30 seconds',
    '还没有文案，点上方「补写」生成，已经写好的平台不受影响': 'No copy yet. Click "Fill in" above; platforms that already have copy are untouched.',
    '还没有封面图': 'No cover yet', '截取': 'Capture', 'AI 画一张': 'AI draw', '封面图提示词': 'Cover prompt',
    '改完点上面的「AI 画一张」，按这段重新生成。': 'Edit, then click "AI draw" above to regenerate from it.',
    '正在从成片截取封面': 'Capturing the cover from the video', '正在用 AI 画新封面（竖版和横版），约半分钟': 'AI is drawing new covers (portrait and landscape), about 30 seconds',
    '竖版 3:4 · 抖音竖封面、小红书': 'Portrait 3:4 · Douyin portrait cover, Xiaohongshu', '横版 16:9 · B站，横屏视频的 YouTube': 'Landscape 16:9 · Bilibili, YouTube (landscape videos)',
    '横版 4:3 · 抖音横封面': 'Landscape 4:3 · Douyin landscape cover', '横版封面没生成出来，B站会用竖版裁剪': 'The landscape cover failed; Bilibili will crop the portrait one',
    '封面生成中，稍等…': 'Cover is being made, one moment…', '重试生成封面': 'Retry cover',
    '发布到勾选的平台': 'Publish to selected platforms', '发布中…': 'Publishing…', '发布中': 'Publishing', '发布失败': 'Publish failed', '至少勾选一个平台': 'Select at least one platform',
    '发布时会弹出一个 Chrome 窗口自动操作，不用管它，做完会自己关掉。每一步进度和结果显示在下面，成功后卡片进入「已发布」。': 'A Chrome window opens and works on its own, then closes when finished. Progress shows below; on success the card moves to Published.',
    '手动发': 'Manual', '改回自动发': 'Switched back to automatic', '自动发 · 账号已绑定': 'Automatic · account bound',
    '你自己发，工作台只帮你准备好要复制的东西': 'You post it yourself; the workbench prepares everything to copy',
    '我已发布': 'I\'ve published it', '这次不发了': 'Skip this time', '确认不发': 'Confirm skip', '已发布（手动）': 'Published (manual)',
    '1 打开发布页': '1 Open the upload page', '2 选视频': '2 Pick the video', '3 封面': '3 Cover', '3 竖封面': '3 Portrait cover', '横封面': 'Landscape cover',
    '在 App 里发也行': 'Or post from the app', '在 Finder 里显示': 'Show in Finder', '视频路径': 'Video path', '封面路径': 'Cover path',
    '竖版 3:4': 'Portrait 3:4', '横版 16:9': 'Landscape 16:9', '横版 4:3 · 在封面设置里切到横封面再传': 'Landscape 4:3 · switch to the landscape cover in the cover dialog',
    '一个个粘贴后按回车': 'Paste one at a time and press Enter', '合集': 'Collection', '手动发布的步骤在「发布」下面': 'Manual publishing steps are under Publish',
    '话题（空格分隔）': 'Hashtags (space-separated)',
    // ---- 账号矩阵 ----
    '账号是频道；目标人群、主角、风格都写在系列里，写得越具体，AI 出的选题和脚本越像': 'A channel is just the outlet; audience, persona and style live in each series. The more specific, the closer the ideas and scripts.',
    '添加账号': 'Add channel', '+ 添加账号': '+ Add channel', '添加第一个账号': 'Add your first channel', '还没有账号': 'No channels yet',
    '先添加一个账号': 'Add a channel first', '先添加一个账号，再在它下面建系列。': 'Add a channel first, then create series under it.',
    '+ 新系列': '+ New series', '新系列': 'New series', '一句话让 Claude 写': 'One sentence and Claude writes it', '系列名': 'Series name',
    '系列名必填': 'Series name is required', '系列已保存': 'Series saved', '系列已删除': 'Series deleted', '删除系列': 'Delete series',
    '删除账号': 'Delete channel', '账号已删除': 'Channel deleted', '代号和名称必填': 'Code and name are required',
    '大方向': 'Broad direction', '大方向：未填': 'Broad direction: not set', '（可选，可以很宽泛；只在内容没选系列时兜底用）': '(optional, can be broad; only used when content has no series)',
    '只填账号名称、大方向和平台。目标人群、主角、风格在保存后的「添加系列」里写': 'Only the channel name, broad direction and platforms here. Audience, persona and style go into a series after saving.',
    '已保存，接着点「添加系列」写目标人群、主角和风格': 'Saved. Now add a series with its audience, persona and style',
    '已暂停': 'Paused', '（暂停）': '(paused)', '正在运营（取消后不再出现在选题和总览里）': 'Active (uncheck to hide from ideas and overview)',
    '目标人群': 'Audience', '主角和语气': 'Persona and tone', '视觉风格': 'Visual style', '一句话定位': 'One-line positioning',
    '固定结构': 'Structure', '适合的题材': 'Topics', '主打情绪': 'Emotions', '配音音色': 'Voice',
    '不指定（生成视频时按主角挑一个）': 'Not set (picked by persona when making the video)', '各平台的合集': 'Collections per platform',
    '（填合集名，发布时自动放进去；要先在平台上建好同名合集，目前抖音已接上）': '(collection name; videos are added automatically on publish. Create it on the platform first; Douyin supported for now)',
    '在用（停用后出选题时不再用它）': 'In use (disabled series are skipped when making ideas)', '（已停用）': '(disabled)', '已停用': 'Disabled',
    '让 Claude 帮你填': 'Let Claude fill it in', '先写一句方向': 'Write one line of direction first',
    '提意见，让 Claude 接着改': 'Give feedback and let Claude revise', '先写要改哪里': 'Say what to change first',
    'Claude 只改你提到的地方，改完先填进右边给你看，满意了再保存。': 'Claude only changes what you mention, fills it in on the right for you to check, then you save.',
    '个人身份证原则上只能实名一个抖音号。要开更多号，用营业执照开企业蓝 V，不要借证或买号。': 'One personal ID can generally verify only one Douyin account. For more, register business accounts; don\'t borrow IDs or buy accounts.',
    '扫码绑定': 'Scan to bind', '已绑定': 'Bound', '未绑定': 'Not bound', '解绑': 'Unbind', '确认解绑': 'Confirm unbind', '已解绑': 'Unbound',
    '重新登录': 'Log in again', '检查登录': 'Check login', '我已登录': 'I\'ve logged in', '正在确认登录…': 'Confirming login…',
    '等你在弹出的 Chrome 里扫码': 'Waiting for you to scan in the Chrome window', '等你扫码': 'Waiting for scan',
    '已打开一个新的 Chrome 窗口，扫码登录后回来点「我已登录」': 'A new Chrome window is open. Scan to log in, then come back and click "I\'ve logged in"',
    '打开登录窗口失败': 'Couldn\'t open the login window', '绑定失败：': 'Binding failed: ', '确认中…': 'Confirming…',
    '账号加载中…': 'Loading channels…', '未知账号': 'Unknown channel', '没选系列': 'No series', '不选系列（按账号大方向）': 'No series (use channel direction)',
    '全部系列': 'All series', '确认删除？用它的内容会改按账号大方向做': 'Delete? Its content will fall back to the channel direction',
    '抖音合集': 'Douyin collection', 'B站合集': 'Bilibili collection', '小红书合集': 'Xiaohongshu collection', 'YouTube 播放列表': 'YouTube playlist',
    // ---- 总览、日历、数据 ----
    '今天要做的': 'To do today', '今天没有待办。去「选题雷达」生成一批新选题吧。': 'Nothing to do today. Generate some new ideas on the Topic radar.',
    '先去「账号矩阵」建好你的账号和人设，选题和脚本都会按人设来生成。': 'Set up your channels and profiles first; ideas and scripts follow them.',
    '去挑选': 'Pick now', '自动化进度': 'Automation progress', '发布前的红线': 'Red lines before publishing',
    '不伪造新闻、事件、测试结果和数据': 'Don\'t fake news, events, test results or data', '不用 AI 伪造真人的脸和声音': 'Don\'t fake real people\'s faces or voices with AI',
    '矩阵各号内容必须真的不同，换字幕换配音会被语义查重': 'Channels must really differ; swapping captions or voices gets caught by duplicate detection',
    '评论由真人回复，不用机器人互动': 'Comments are answered by people, not bots',
    '全网热榜聚合（抖音、微博、B站、知乎、百度、头条）': 'Aggregated trending lists (Douyin, Weibo, Bilibili, Zhihu, Baidu, Toutiao)',
    'AI 按人设批量生成选题，带爆款评分': 'AI ideas per channel profile, with scores', 'AI 写分镜脚本，含三平台版本差异': 'AI storyboard scripts with per-platform variants',
    'AI 预审和人工审核清单，没过审不能排期': 'AI precheck and a review checklist', '数据汇总和 AI 复盘': 'Stats and AI review',
    '每日定时自动跑选题': 'Scheduled daily ideas', '接入平台官方定时发布和开放平台接口': 'Official scheduled publishing APIs', '各平台数据自动回收': 'Automatic stats collection',
    '已上线': 'Live', 'Claude 每日选题：在桌面端说「跑一下今天的选题」': 'Daily ideas: say "run today\'s ideas" in the Claude desktop app',
    '按人群分号，每个号的人设和内容都不一样': 'One channel per audience, each with its own persona and content',
    '发布日历': 'Publishing calendar', '前 3 天到后 14 天。排期在内容详情里设置': 'From 3 days ago to 14 days ahead. Schedule in the item details.',
    '建议每个账号每天固定时段发一条。到点后在各平台创作者中心用官方定时发布，发完把卡片拖到「已发布」并填数据。': 'Post once a day per channel at a fixed time. Use each platform\'s scheduler, then move the card to Published and fill in the stats.',
    '今天发布': 'Today', '没有待排期的内容': 'Nothing to schedule', '近 7 天发布': 'Last 7 days',
    '还没有已发布的内容': 'Nothing published yet', '内容发布后，在详情里填上各平台的播放、点赞等数据，这里会自动汇总，也可以让 AI 帮你复盘。': 'After publishing, fill in views and likes in the item details. They\'re summarized here, and AI can review them.',
    '总播放': 'Total views', '总涨粉': 'Followers gained', '累计播放': 'Total views', '各账号播放': 'Views by channel', '最好的一条': 'Best item', '互动率': 'Engagement',
    'AI 复盘': 'AI review', '开始复盘': 'Start review', '重新复盘': 'Review again', 'Claude 复盘中…': 'Claude is reviewing…', 'Claude 正在分析数据…': 'Claude is analyzing…',
    'Claude 开始复盘，完成后结果会出现在这里': 'Claude started the review; results will appear here',
    '把所有已发布内容的数据交给 Claude，找出哪类选题、情绪、账号在赢，并给出下周的选题方向。': 'Give Claude the stats of everything published to find which topics, emotions and channels win, and suggest next week\'s direction.',
    '建议': 'Suggestions', '下一期': 'Next up', '生成于': 'Generated', '添加于': 'Added', '选题池': 'Idea pool',
    // ---- 设置 ----
    '用到 Claude 的功能各自用什么模型、想得多深，改完下次运行就生效': 'Which model each Claude feature uses and how hard it thinks. Changes apply on the next run.',
    '连接': 'Connections', '模型': 'Model', '功能': 'Feature', '调用方式': 'Mode', '思考强度': 'Effort', '思考强度（effort）': 'Effort',
    '后台 Agent': 'Background agent', '单次调用': 'One-shot', '怎么选': 'How to choose', '两种调用方式': 'Two modes',
    '每次运行实际用了哪个模型，会显示在选题雷达、账号选题的运行记录里': 'The model actually used by each run appears in the run logs',
    '选的是系列，新版本发布后自动跟上：本机 Claude Code 自己解析成该系列最新的模型': 'You pick a family; new versions are used automatically as Claude Code resolves the latest one',
    '每次运行都明确带上这里选的强度，不受本机 Claude Code 自己设置的影响': 'Every run passes the effort set here, regardless of your local Claude Code settings',
    '全部通过本机 Claude Code 调用，用你登录的订阅额度，不需要 API Key': 'Everything runs through your local Claude Code on your subscription. No API key needed.',
    '后台 Agent：能上网查背景、读工作台里的资料，结果自动存回，页面上能看到每一步；同一时间只跑一个任务，要排队': 'Background agent: can search the web and read workbench data, saves results automatically, shows every step; one task at a time',
    '单次调用：只根据卡片里的内容直接回答，不上网；更快，文字逐段出来，可以和后台 Agent 同时进行': 'One-shot: answers only from the card, no web; faster, streams text, can run alongside the agent',
    '精选、出题、账号资料固定用后台 Agent；写脚本、AI 预审、AI 复盘可以在左边选': 'Curation, ideas and profiles always use the agent; script, precheck and review can be switched on the left',
    '登录用本机 claude 的登录状态，或上面「连接」里填的长期令牌': 'Uses your local claude login, or the long-lived token under Connections',
    '用本机 claude 的登录': 'Using local claude login', '保存令牌': 'Save token', '先粘贴令牌': 'Paste a token first',
    '已保存，下次运行 Claude 时生效': 'Saved. Applies on the next Claude run', '已删除，改用本机 claude 的登录': 'Deleted. Using the local claude login',
    '所有 AI 环节都通过本机的 Claude Code 跑，用你自己的 Claude 订阅。装好 Claude Code 并在终端登录过就能用；想更稳（不和终端、桌面端抢登录），在终端运行': 'Every AI step runs through your local Claude Code on your own subscription. It works once Claude Code is installed and logged in. For more reliable runs (no fighting over the login with your terminal or desktop app), run',
    '，把生成的令牌粘贴到这里。': 'in a terminal and paste the token here.',
    '配了就让 AI 画封面。填 OpenAI 的 key，或者任何兼容 OpenAI 图片接口（/images/generations）的地址和 key。': 'Set this up to have AI draw covers. Use an OpenAI key, or any endpoint and key compatible with OpenAI\'s /images/generations.',
    '接口地址': 'Endpoint', '先填 key': 'Enter a key first', '未配置：封面从成片里截一帧': 'Not set: covers are taken from a video frame',
    '已保存，之后生成封面会用 AI 画': 'Saved. Covers will be AI-drawn from now on', '已删除，封面改为从成片截取': 'Deleted. Covers will be taken from the video',
    '正在读取连接设置…': 'Loading connections…', '读取设置失败': 'Couldn\'t load settings',
    '界面语言': 'Language',
    // ---- 运行记录 ----
    '插话': 'Interject', '插话失败': 'Interject failed', '先写要说的话': 'Type what to say first',
    '已插话：它会打断当前这一步，按你说的调整后继续': 'Sent. It will interrupt the current step and adjust',
    'Claude 正在跑别的任务': 'Claude is running another task', '上一个 AI 任务还没结束': 'The previous AI task hasn\'t finished',
    '想追问 Claude 这次为什么这么做：在项目目录运行': 'To ask Claude why it did this, run in the project folder:',
    '没有拿到结果，再试一次': 'No result, try again', '连不上本地服务。在项目目录运行': 'Can\'t reach the local service. In the project folder run',
    '，然后刷新页面。': ', then refresh the page.', '保存失败：连不上本地服务，确认 npm start 还在运行。': 'Save failed: can\'t reach the local service. Make sure npm start is still running.',
    '生成失败：连不上本地服务，确认 npm start 还在运行。': 'Generation failed: can\'t reach the local service. Make sure npm start is still running.',
    '会覆盖已改的内容，确认？': 'This overwrites your edits. Continue?', '确认重新生成？': 'Regenerate?', '还没有内容可改，先「生成」一版': 'Nothing to edit yet; generate a version first',
    '上传失败': 'Upload failed', '打不开': 'Can\'t open', '没用上': 'Unused', '制作中': 'In progress',
    // ---- 补充：热榜名称、单字片段、读屏标签、输入提示 ----
    '微博热搜': 'Weibo trending', 'B站热搜': 'Bilibili trending', '知乎热榜': 'Zhihu trending', '百度热搜': 'Baidu trending', '头条热榜': 'Toutiao trending',
    '抖音热搜': 'Douyin trending', '条': 'items', '秒': 's', '版本': 'Version', '截取时间（秒）': 'At (s)', 'AI 选题': 'AI idea',
    '内容详情': 'Item details', '账号': 'Channel', '系列': 'Series', '删除这个素材': 'Delete this capture',
    '开头的画面和第一句台词': 'Opening shot and first line', '素材链接、制作备注、复盘想法': 'Links, production notes, review thoughts',
    '点「AI 写脚本」，Claude 会按这个账号的人设写一份可直接制作的分镜。你也可以自己写。': 'Click "AI script" and Claude writes a storyboard ready to produce for this channel. You can also write it yourself.',
    '已经有做好的视频，跳过生成直接发布': 'Already have a finished video? Skip generation and publish it',
    '边看边写。点「标记当前时间」插入播放到的时间点，例如：[61.2 秒] 片尾这行字太素了，改成黄底黑字': 'Write as you watch. Click "Mark current time" to insert the timestamp, e.g. [61.2 s] make the end title bolder',
    '勾上后这个平台由你自己发：工作台把视频、封面、标题、正文、话题准备好，你复制粘贴就行；不会碰你在这个平台上的账号': 'Tick to post on this platform yourself: the workbench prepares the video, covers, title, body and hashtags to copy. Your account on it is never touched.',

    // ---- 设置：模型、功能、思考强度 ----
    '精选素材': 'Curate topics', '生成账号资料': 'Channel profile', '生成和修改系列': 'Create and revise series', '修改视频': 'Revise video', '写分镜脚本': 'Storyboard script',
    'Fable（最新）': 'Fable (latest)', 'Opus（最新）': 'Opus (latest)', 'Sonnet（最新）': 'Sonnet (latest)', 'Haiku（最新）': 'Haiku (latest)',
    '最强，适合最难的判断；想得最久，最慢，消耗额度最多': 'Strongest, for the hardest judgment calls; thinks longest, slowest, uses the most quota',
    '很强，适合要判断和创意的活，大部分功能用它': 'Very strong, for judgment and creative work; most features use it',
    '快，省额度，填表、整理、预审这类活够用': 'Fast and economical; good enough for forms, tidying and prechecks',
    '最快最省，只适合很简单的活': 'Fastest and cheapest; only for very simple work',
    '快，填表、整理、写发布文案这类活够用': 'Fast; good enough for forms, tidying and publish copy',
    '大部分功能用它，判断和创意都稳': 'Used by most features; steady judgment and creativity',
    '想得更深，适合调研、做视频这类长任务；更慢、更费额度': 'Thinks deeper, for long tasks like research and video; slower, uses more quota',
    '最深，最慢，消耗额度最多': 'Deepest, slowest, uses the most quota',
    '能上网查背景、读工作台里的资料，结果自动存回；同一时间只跑一个任务，要排队': 'Can search the web and read workbench data, saves results automatically; one task at a time',
    '只根据卡片里的内容直接回答，不上网；更快，文字逐段出来，可以和后台 Agent 同时跑': 'Answers only from the card, no web; faster, streams text, can run alongside the agent',
    '图片生成（可选）': 'Image generation (optional)', '粘贴新令牌可替换': 'Paste a new token to replace it', '不改 key 就留空': 'Leave empty to keep the current key',
    'sk-ant-oat…（可选）': 'sk-ant-oat… (optional)',

    // ---- 技能页 ----
    '技能': 'Skills', '自己加的': 'Custom', '出厂说明有更新': 'Update available', '改过': 'Modified', '出厂': 'Default',
    '读取技能失败': 'Couldn\'t load skills', '出厂说明有新版本': 'A new default version is available',
    '这个技能你改过，所以没有自动更新。可以让 Claude 把新版的改进合进你的版本（结果会先填进下面给你看），也可以直接用新版覆盖，或者保留你的版本。': 'You\'ve edited this skill, so it wasn\'t updated automatically. Let Claude merge the new improvements into your version (you\'ll review it below first), replace it with the new default, or keep yours.',
    '让 Claude 合并': 'Let Claude merge', 'Claude 合并中…': 'Claude is merging…', '用新版覆盖': 'Use the new default', '保留我的版本': 'Keep my version',
    '看新的出厂版本': 'View the new default', '下面是 Claude 合并后的版本，检查一下，满意了点「采用合并结果」。': 'Below is Claude\'s merged version. Review it, then click "Use merged version".',
    '采用合并结果': 'Use merged version', '放弃': 'Discard', '恢复出厂': 'Reset to default', '确认恢复': 'Confirm reset', '确认覆盖': 'Confirm replace',
    '载入这一版': 'Load this version',
    '每个环节怎么做，都写在这里的岗位说明里。改这里就是改流程，不用碰代码。这些是你的本地数据，不会提交到代码仓库；在 Claude Code 里直接跑这些技能，用的也是同一份。': 'How each step works lives in these job descriptions. Editing them changes the process, no code needed. They\'re your local data and never committed; running these skills directly in Claude Code uses the same files.',
    '已保存，下次运行这个技能就用新的说明': 'Saved. The next run of this skill uses it', '已恢复成出厂说明，原来的版本存进了历史': 'Reset to default; your version is in the history',
    '已换成新的出厂说明，原来的版本存进了历史': 'Replaced with the new default; your version is in the history', '保留了你的版本，这次出厂更新不再提示': 'Kept your version; this update won\'t be shown again',
    '合并好了，检查一下': 'Merged. Please review', '已采用合并结果': 'Merged version saved', '已载入这一版，点保存才生效': 'Version loaded; click Save to apply',

    '热点数据服务还没响应：刚启动的话等几秒会自动连上；一直这样的话，在项目目录运行 npm run setup，再重新 npm start': 'The trends service isn\'t responding yet. If it just started, it will connect in a few seconds; if this persists, run npm run setup in the project folder and npm start again.',
    // ---- 环境检查 ----
    '还差这几步就能用了': 'A few steps left before you can start', '重新检查': 'Check again',
    'Claude Code 没装': 'Claude Code isn\'t installed', 'Claude Code 没登录': 'Claude Code isn\'t logged in', 'Claude Code 已登录': 'Claude Code logged in',
    'Claude Code（长期令牌）': 'Claude Code (long-lived token)', '缺 ffmpeg': 'ffmpeg is missing', '缺 Google Chrome': 'Google Chrome is missing',
    '缺做视频用的 HyperFrames 技能': 'The HyperFrames video skill is missing', '热点数据服务没启动': 'The trends service isn\'t running',
    'HyperFrames 技能': 'HyperFrames skill', 'ffmpeg': 'ffmpeg', 'Google Chrome': 'Google Chrome',
    '所有 AI 环节都靠它。在终端运行：curl -fsSL https://claude.ai/install.sh | bash': 'Every AI step relies on it. In a terminal, run: curl -fsSL https://claude.ai/install.sh | bash',
    '在终端运行 claude，按提示用你的 Claude 订阅账号登录；想更稳，运行 claude setup-token，把令牌粘贴到「设置 → 连接」': 'Run claude in a terminal and log in with your Claude subscription. For more reliable runs, run claude setup-token and paste the token under Settings → Connections.',
    '做视频、裁封面都要用。在终端运行：brew install ffmpeg': 'Needed for videos and covers. In a terminal, run: brew install ffmpeg',
    '发布到各平台时要用。在终端运行：brew install --cask google-chrome': 'Needed for publishing. In a terminal, run: brew install --cask google-chrome',
    '在项目目录运行：npx hyperframes skills update faceless-explainer': 'In the project folder, run: npx hyperframes skills update faceless-explainer',
    '在项目目录运行 npm run setup 装好 Python 环境，再重新 npm start': 'In the project folder, run npm run setup to install the Python environment, then npm start again',
    // ---- 发布过程的步骤 ----
    '打开抖音创作者中心的上传页': 'Open the Douyin creator upload page', '打开小红书创作服务平台的上传页': 'Open the Xiaohongshu upload page',
    '打开 B站创作中心的投稿页': 'Open the Bilibili upload page', '打开 YouTube Studio': 'Open YouTube Studio', '上传视频文件': 'Upload the video file',
    '进入发布页，填写标题和描述': 'Fill in the title and description', '填写标题和正文': 'Fill in the title and body', '填写标题和说明': 'Fill in the title and description',
    '填写标题、创作声明、标签和简介': 'Fill in the title, declaration, tags and description', '填写标签': 'Fill in tags', '等视频上传完成': 'Wait for the upload to finish',
    '上传竖封面（3:4）': 'Upload the portrait cover (3:4)', '上传横封面（4:3）': 'Upload the landscape cover (4:3)', '上传缩略图': 'Upload thumbnail',
    '上传自定义封面': 'Upload the custom cover', '竖封面、横封面都已设置': 'Portrait and landscape covers set', '竖封面已设置': 'Portrait cover set',
    '横封面已设置': 'Landscape cover set', '封面已设置': 'Cover set', '点击发布': 'Click publish', '点击立即投稿': 'Click submit',
    '发布成功': 'Published', '发布成功，已跳转到作品管理页': 'Published; redirected to the content manager', '投稿成功': 'Submitted',
    '下一步，直到公开范围': 'Next, up to visibility', '选择「不是面向儿童的内容」': 'Choose "Not made for kids"', '勾选「内容由 AI 生成」声明': 'Tick the "AI-generated content" declaration',
    '有预填标签删不掉，留着': 'A pre-filled tag couldn\'t be removed; left it', '标签没变成标签块，可能没填上': 'Tags didn\'t turn into chips; they may not have been added',
    '没找到标题框，标题会写进描述的第一行': 'No title field found; the title goes into the first line of the description',
    '这条会被当作 Shorts，YouTube 网页版不能给 Shorts 换缩略图，跳过': 'This will be a Short; YouTube web can\'t set Shorts thumbnails, skipped',
    // ---- 推特：渠道、号池、素材、发推 ----
    '推特': 'X', '推特号池': 'X account pool', '每条取多少': 'Per query', '搜索语句': 'Search queries', '类别名': 'Category',
    '启用': 'On', '试搜': 'Test', '搜索中…': 'Searching…', '添加一条': 'Add query', '新类别': 'New category', '搜索语法': 'Search syntax',
    '同时包含；': 'contains both;', '包含任意一个；括号分组：': 'contains either; group with parentheses:', '表示两组各至少命中一个': 'means at least one from each group',
    '精确短语；': 'exact phrase;', '排除含这个词的': 'excludes posts with that word', '至少多少赞，': 'minimum likes,', '至少多少转推；': 'minimum reposts;',
    '限定语言': 'limit the language', '只要带视频的；': 'only posts with video;', '不要回复和转推；': 'no replies or reposts;', 'from:用户名': 'from:username',
    '只看某个人': 'only one person', '不用写': 'No need for', '和': 'or', '：程序自动限定最近两天，按热门排序': ': the last two days are added automatically, sorted by Top',
    '改完先点「试搜」看看结果（每次用 1 次号池请求），满意了再保存': 'Click "Test" to check the results first (1 pool request each), then save',
    '立即体检': 'Check now', '体检中…': 'Checking…', '今日请求': 'Requests today', '冷却中': 'Cooling down', '待解锁': 'Locked', '已失效': 'Invalid',
    '上次体检': 'Last check', '还没有': 'never', '推特账号': 'X account', '状态': 'Status', '下次检测': 'Next check', '检测': 'Check', '不再自动检测': 'No more auto checks',
    '号池里还没有账号。在下面粘贴 Cookie 添加。': 'No accounts yet. Paste cookies below to add some.',
    '批量保存账号': 'Add accounts', '粘贴账号资料或 Cookie（每行一个账号）': 'Paste account records or cookies (one account per line)',
    '用户名:密码:邮箱:auth_token:ct0\n也支持：用户名 auth_token=...; ct0=...\n或直接粘贴 Cookie、Cookie-Editor 导出的 JSON': 'username:password:email:auth_token:ct0\nAlso: username auth_token=...; ct0=...\nOr paste a cookie string or a Cookie-Editor JSON export',
    '用户名（可选）': 'Username (optional)', '只粘贴了一份 Cookie 时，可以在这里填用户名': 'When pasting a single cookie, you can put the username here',
    '用小号，别用你自己的主号：号池是拿账号的登录 Cookie 去搜推特，不符合推特的服务条款，账号可能被限流或封禁。Cookie 只存在本机。': 'Use spare accounts, not your main one: the pool searches X with the accounts\' login cookies, which is against X\'s terms, so accounts may get rate-limited or banned. Cookies stay on this machine.',
    '自动提取 auth_token 和 ct0，只保存用户名与 Cookie，不保存密码和邮箱。重复账号会跳过，同名账号的新 Cookie 会更新；用户名不区分大小写。同一批重复只保留第一条，页面仅显示 Cookie 前 6 位。': 'auth_token and ct0 are extracted automatically; only the username and cookies are kept, never passwords or emails. Duplicates are skipped and a new cookie for an existing username replaces the old one (usernames are case-insensitive). Only the first 6 characters of a cookie are shown.',
    '最近状态变化': 'Recent changes', '没有': 'None', '自动维护规则': 'Maintenance rules', '正在读取推特号池…': 'Loading the X account pool…',
    '同一批检测全部没有结果时按网络问题处理，不改账号状态': 'If a whole batch of checks gets no answer, it\'s treated as a network problem and statuses are left alone',
    '登录失效（32）：直接判定失效，粘贴新 Cookie 后恢复': 'Logged out (32): marked invalid right away; paste a new cookie to restore',
    '正在逐个体检，每个账号最多约 1 分钟。体检会对每个账号发一次请求。': 'Checking accounts one by one, up to about a minute each. Each check uses one request per account.',
    '进入冷却': 'cooling down', '被锁定': 'locked', '判定失效': 'marked invalid', '已恢复': 'restored', '疑似网络问题': 'possible network problem', '不可用': 'Unavailable',
    '号池里还没有推特账号，添加账号后开始抓取': 'No X accounts in the pool yet; fetching starts once you add some',
    '号池里没有可用账号，请在「渠道 → 推特」添加账号': 'No usable accounts in the pool; add some under Sources → X',
    '请求超时：账号可能都在限流冷却中，稍后再试': 'Request timed out: the accounts may be rate-limited; try again later',
    '可用账号今天的请求次数都用完了，明天再试或增加账号': 'All accounts have used up today\'s requests; try tomorrow or add accounts',
    '体检正在进行中': 'A check is already running', '先粘贴账号资料或 Cookie': 'Paste account records or cookies first', '体检失败': 'Check failed', '检测失败': 'Check failed',
    '没有搜到。可能门槛太高、语法有误，或者号池里的号被限制了搜索（看下面号池的状态）': 'No results. The thresholds may be too high, the syntax may be off, or the pool\'s accounts may be blocked from searching (see the pool status below)',
    '搜索被推特拒绝（404）：号能登录，但搜索被限制了，按冷却处理，同样间隔重测；查询时碰到这种号会自动换号重查': 'Search rejected by X (404): the account can log in but is blocked from searching. It cools down and is retested on the same schedule; queries that hit such an account retry with another one',
    '搜索被推特拒绝（返回 404）：这个号能登录，但搜索多半被限制了': 'Search rejected by X (404): this account can log in, but searching is probably blocked',
    '所有搜索语句都没有返回推文：号池里的号可能被推特限制了搜索，看下面号池的状态': 'None of the queries returned posts: the pool\'s accounts may be blocked from searching by X; see the pool status below', '先写搜索语句': 'Write a query first', '试搜失败': 'Test failed',
    '24 小时': '24 hours', '48 小时': '48 hours', '7 天': '7 days', '热度分：每小时的互动量，涨得越快越高': 'Heat: engagement per hour; faster growth scores higher',
    '最近一轮抓取新出现的': 'New in the latest fetch', '打开原帖': 'Open post', '打开被引用的原帖': 'Open quoted post',
    '这段时间没有推特内容': 'No X posts in this period', '渠道会按间隔自动抓取，也可以在「渠道 → 推特」里立即抓取': 'The source fetches on its schedule; you can also fetch now under Sources → X',
    '推特不用标题': 'X has no title', '推文': 'Post', '（只在工作台里看，不发出去）': '(only shown in the workbench, not posted)',
    // ---- YouTube：渠道、额度、素材 ----
    '还没填': 'Not set', '验证并保存': 'Verify and save', '验证中…': 'Verifying…', '更换': 'Replace', '（来自环境变量）': ' (from environment variable)',
    '在 Google Cloud 控制台开通「YouTube Data API v3」，在「凭据」里创建 API 密钥（API 限制勾 YouTube Data API v3）。保存前会用它查一条视频确认能用（1 点额度）；只存在这台电脑上，页面上只显示末 4 位。': 'Enable "YouTube Data API v3" in the Google Cloud console and create an API key under Credentials (restrict it to YouTube Data API v3). Before saving, it looks up one video to check the key works (1 unit). The key stays on this computer; only the last 4 characters are shown.',
    '还没填 YouTube 的 API key，填好后开始抓取': 'No YouTube API key yet; fetching starts once you add one',
    '还没填 YouTube 的 API key：在工作台「渠道 → YouTube」里填': 'No YouTube API key yet: add one under Sources → YouTube',
    '今天的 YouTube 额度用完了，太平洋时间零点（北京时间下午三四点）恢复': 'Today\'s YouTube quota is used up; it resets at midnight Pacific time',
    'key 格式不对：应该是一串 39 位左右的字母数字，通常以 AIza 开头': 'That doesn\'t look like a key: it should be about 39 letters and digits, usually starting with AIza',
    '只看最近': 'Only the last', '每组取多少': 'Per group', '关键词': 'Keywords', '语言': 'Language', '用 100 点额度': 'Uses 100 quota units',
    '偏向某种语言的结果，如 en、zh-Hans、ja；不填不限': 'Prefer results in a language, e.g. en, zh-Hans, ja; leave empty for any',
    '添加一组': 'Add group', '关键词语法': 'Keyword syntax', '同时相关；': 'both relevant;', '任意一个；': 'either;', '排除': 'exclude',
    '「语言」填': 'For "Language", use', '等，结果会偏向这种语言，不填不限': 'etc. to prefer that language; leave empty for any',
    '每组每轮搜索用 100 点额度，Google 给每个项目每天 10000 点，太平洋时间零点恢复': 'Each group uses 100 units per run; Google gives each project 10,000 units a day, reset at midnight Pacific time',
    '改完先点「试搜」看看结果（也用 100 点），满意了再保存': 'Click "Test" to check the results first (also 100 units), then save',
    'Claude 还能做什么': 'What else Claude can do',
    '精选、调研和运营时，Claude 可以随时按任意关键词搜 YouTube、读视频的完整简介和数据、读热门评论，用的是同一份额度': 'When curating, researching or reviewing, Claude can search YouTube for any keywords, read full descriptions and stats, and read top comments, using the same quota',
    '拿不到字幕全文和视频文件：官方接口只给视频作者本人下字幕': 'Full transcripts and video files aren\'t available: the official API only lets a video\'s owner download its captions',
    '热度分：每小时的播放量，涨得越快越高': 'Heat: views per hour; faster growth scores higher', '有字幕': 'Captions', '作者上传了字幕': 'The creator uploaded captions',
    '打开视频': 'Open video', '还没有 YouTube 视频': 'No YouTube videos yet', '渠道会按间隔自动抓，也可以在「渠道 → YouTube」里立即抓取': 'The source fetches on its schedule; you can also fetch now under Sources → YouTube',
    '还没有数据。在「渠道 → YouTube」配好 key 后会自动抓': 'No data yet. It fetches automatically once a key is set under Sources → YouTube',
    '先粘贴 key': 'Paste a key first', 'key 能用，已保存，开始抓一轮': 'Key works and is saved; fetching now', '已删除 key': 'Key deleted', '先写关键词': 'Write keywords first',
    '没有搜到，换个关键词试试': 'No results; try other keywords', '这条视频关闭了评论': 'Comments are turned off for this video',
    // ---- YouTube 拆解 ----
    '拆解': 'Teardown', '看拆解': 'View teardown', '重新拆解': 'Redo teardown', '拆解中…': 'Tearing down…', '已拆解': 'Torn down',
    '确认重新拆解': 'Confirm redo', '拆解报告': 'Teardown', '还没拆解': 'Not torn down yet', '重新拉字幕': 'Refetch captions', '拉取中…': 'Fetching…',
    '还没拉字幕': 'No captions fetched yet', '看字幕': 'Show captions', '字幕已重新拉取': 'Captions refetched', '拉字幕失败': 'Couldn\'t fetch captions',
    'Claude 开始拆解，一般一两分钟': 'Claude started the teardown; it usually takes a minute or two', 'Claude 开始重新拆解': 'Claude started a new teardown',
    '读字幕、简介和热门评论，写一份拆解报告存到这条视频上': 'Read the captions, description and top comments, and save a teardown on this video',
    '已经有一条视频在拆解，等它结束或先停止': 'A video is already being torn down; wait for it or stop it first',
    'YouTube 要求验证不是机器人，这次拿不到字幕（不去绕过它的检测），稍后再试': 'YouTube asked to verify this isn\'t a bot, so no captions this time (we don\'t work around its checks); try again later',
    'YouTube 说请求太频繁，这次拿不到字幕，稍后再试': 'YouTube says there are too many requests, so no captions this time; try again later',
    '这条视频没有字幕，也没有自动生成的字幕': 'This video has no captions, not even auto-generated ones',
    // ---- 拉字幕用的 YouTube 登录 ----
    '拉字幕用的 YouTube 登录': 'YouTube login for captions', '可选': 'optional', '登录已失效': 'Login expired', '已登录': 'Logged in', '没登录': 'Not logged in',
    '登录 YouTube': 'Log in to YouTube', '换个账号登录': 'Log in with another account', '重新登录': 'Log in again', '检查登录': 'Check login', '退出登录': 'Log out',
    '确认退出': 'Confirm logout', '我已登录': 'I\'ve logged in', '正在确认登录状态…': 'Checking the login…', '登录成功，正在导出登录信息给 yt-dlp…': 'Logged in; exporting the session for yt-dlp…',
    'YouTube 登录好了': 'YouTube login ready', '已退出 YouTube 登录': 'Logged out of YouTube', '登录有效，已更新登录信息': 'Login is valid; session updated', '登录已失效，重新登录一次': 'Login expired; log in again',
    '拉字幕用的 YouTube 登录已失效，去「渠道 → YouTube」重新登录': 'The YouTube login used for captions has expired; log in again under Sources → YouTube',
    'YouTube 登录已失效（用登录也被要求验证），去「渠道 → YouTube」重新登录': 'YouTube login expired (still asked to verify while logged in); log in again under Sources → YouTube',
    '用登录拉字幕也被 YouTube 要求验证，登录可能失效了': 'YouTube still asked for verification while logged in; the login may have expired',
  };

  // 带数字、名字的句式：(.+?) 抓到的部分会再翻译一遍
  const num = (x, k) => { const v = parseFloat(x) * k; return v >= 1e9 ? +(v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? +(v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? +(v / 1e3).toFixed(1) + 'k' : String(Math.round(v)); };
  const PATTERNS = [
    [/^第 (\d+) 步 (.+)，(.+)$/, (m, n, a, b) => `Step ${n} ${tr(a)}, ${tr(b)}`],
    [/^(抖音|B站|小红书|YouTube)(播放|点赞|评论|分享|涨粉)$/, (m, a, b) => `${tr(a)} ${tr(b).toLowerCase()}`],
    [/^文件：(.+)。想在 HyperFrames 里继续改：在 (.+) 目录运行$/, 'File: $1. To keep editing in HyperFrames, run this in $2:'],
    [/^本机文件：(.+)$/, 'Local file: $1'], [/^放进合集「(.+)」$/, 'Add to collection "$1"'], [/^抖音里没有叫「(.+)」的合集，跳过$/, 'No Douyin collection named "$1", skipped'],
    [/^标签「(.+)」没加上，跳过$/, 'Tag "$1" wasn\'t added, skipped'], [/^话题「(.+)」没绑定上，按普通文字留着$/, 'Hashtag "$1" didn\'t link; kept as plain text'],
    [/^上传完成（(.*)）$/, 'Upload finished ($1)'], [/^(.+没设置成功.*|.*没传上.*)（(.+)）$/, (m, a, b) => `${a.includes('横封面') ? 'Landscape cover not set' : a.includes('竖封面') ? 'Portrait cover not set' : a.includes('缩略图') ? 'Thumbnail not uploaded' : 'Cover not set'}, using the platform default (${b})`],
    [/^([\d.]+)万$/, (m, x) => num(x, 1e4)], [/^([\d.]+)亿$/, (m, x) => num(x, 1e8)],
    [/^(\d+) 个在跑$/, '$1 running'], [/^24 小时 (\d+\+?) 条$/, '$1 in 24h'], [/^(\d+) 个待决定$/, '$1 to decide'], [/^(\d+) 个待挑$/, '$1 to pick'],
    [/^进行中 (\d+)$/, '$1 in progress'], [/^没有待挑$/, 'none'], [/^(\d+) 个出错$/, '$1 failing'], [/^(\d+) 个$/, '$1'], [/^(\d+) 条$/, '$1 items'],
    [/^(\d+) 条内容$/, '$1 items'], [/^全部 (\d+)$/, 'All $1'], [/^看全部 (\d+) 条$/, 'See all $1'], [/^抓到 (\d+) 条$/, 'got $1'],
    [/^每 (\d+) 分钟$/, 'Every $1 min'], [/^每 (\d+) 小时$/, 'Every $1 h'], [/^(\d+) 分钟$/, '$1 min'], [/^(\d+) 小时$/, '$1 h'],
    [/^(\d+) 个系列 · (\d+)\/(\d+) 平台已连$/, '$1 series · $2/$3 platforms bound'], [/^(.+) · 绑定$/, (m, p) => `${tr(p)} · bind`], [/^(.+) · 已绑定$/, (m, p) => `${tr(p)} · bound`],
    [/^扫码绑定(.+)$/, (m, p) => `Scan to bind ${tr(p)}`], [/^(.+)绑定成功$/, (m, p) => `${tr(p)} bound`],
    [/^大方向：(.+)$/, (m, p) => `Broad direction: ${p}`], [/^(.+) · 等你手动发布$/, (m, p) => `${tr(p)} · waiting for you to post`],
    [/^(.+) · 已发布 · (.+)$/, (m, a, b) => `${tr(a)} · published · ${b}`], [/^(.+) · 发布中 · (.+)$/, (m, a, b) => `${tr(a)} · publishing · ${b}`],
    [/^(.+) · 发布失败 · (.+)$/, (m, a, b) => `${tr(a)} · failed · ${b}`], [/^(.+) · 已发布（手动） · (.+)$/, (m, a, b) => `${tr(a)} · published (manual) · ${b}`],
    [/^自动发要先在「账号矩阵」绑定(.+)，或者勾右边的「手动发」$/, (m, p) => `Bind ${tr(p)} under Channels to publish automatically, or tick "Manual"`],
    [/^(.+)改成手动发，这个账号以后默认都手动$/, (m, p) => `${tr(p)} set to manual for this channel`],
    [/^Claude (.+)中$/, (m, p) => `Claude: ${tr(p)}`], [/^Claude 正在写，已经 (\d+) 秒$/, 'Claude is writing, $1 s so far'],
    [/^处理好以后点「重新检查」。已经通过的：(.+)$/, (m, a) => `Click "Check again" when done. Already OK: ${a.split('、').map(tr).join(', ')}`],
    [/^查看过程（(\d+) 步）$/, 'Show process ($1 steps)'], [/^历史版本（(\d+)）$/, 'History ($1)'], [/^调研报告 · (\d+) 个来源 · (.+)$/, 'Research report · $1 sources · $2'],
    [/^收集的素材 · (\d+) 张截图(.*)$/, (m, n, rest) => `Collected footage · ${n} screenshots${rest.replace(/ · (\d+) 段视频/, ' · $1 videos')}`],
    [/^第 (\d+) 版 · ([\d.]+) 秒$/, 'Version $1 · $2 s'], [/^([\d.]+) 秒$/, '$1 s'], [/^旧版本（(\d+)）$/, 'Old versions ($1)'],
    [/^保存过 (\d+) 个旧版本$/, '$1 older versions saved'], [/^播放 ([^·]+)$/, (m, a) => `Views ${tr(a.trim())}`], [/^已配置 ····(.+)$/, 'Configured ····$1'],
    [/^长期令牌 ····(.+)$/, 'Long-lived token ····$1'], [/^最近一次实际用的：(.+)$/, 'Last used: $1'], [/^Claude 的说明：([\s\S]+)$/, 'Claude\'s notes: $1'],
    [/^来自精选：(.+)$/, 'From topic: $1'], [/^借势热点：(.+)$/, 'Trend: $1'], [/^失败：(.+)$/, (m, p) => `Failed: ${tr(p)}`],
    [/^生成失败：(.+)$/, (m, p) => `Generation failed: ${tr(p)}`], [/^平均每条 (.+)$/, 'Average $1 per item'], [/^已发布 (\d+) 条，数据来自你在详情里填写的数字$/, '$1 published; stats come from what you entered in the details'],
    [/^「账号选题」里有 (\d+) 个选题等你挑$/, '$1 ideas waiting under Ideas'], [/^(\d+) 个，选题在「账号选题」里$/, '$1; ideas are under Ideas'],
    [/^「(.+)」改成 (.+)，下次运行生效$/, (m, a, b) => `"${tr(a)}" set to ${b}; applies on the next run`],
    [/^「(.+)」思考强度改成 (.+)，下次运行生效$/, (m, a, b) => `"${tr(a)}" effort set to ${b}; applies on the next run`],
    [/^改成(后台 Agent|单次调用)，下次点按钮生效$/, (m, a) => `Switched to ${tr(a)}; applies next time`],
    [/^（不超过 (\d+) 字，现在 (\d+)）$/, '(max $1 characters, now $2)'], [/^选「(.+)」$/, 'Pick "$1"'], [/^手动发 (.+)$/, (m, p) => `Manual: ${p}`],
    [/^自动发 (.+)$/, (m, p) => `Automatic: ${p}`], [/^补写(.+)文案$/, (m, p) => `Fill in copy for ${p}`], [/^(\d+) 张截图$/, '$1 screenshots'],
    [/^画面 (\d+)$/, 'Frame $1'], [/^图 (\d+)(.*)$/, 'Image $1$2'], [/^上榜 (\d+) 分钟$/, 'On list $1 min'], [/^上榜 (\d+) 小时$/, 'On list $1 h'],
    [/^最高第 (\d+)$/, 'best #$1'], [/^(\d+) 个视频$/, '$1 videos'], [/^(\d+) 分 · (\d+) 评论$/, '$1 points · $2 comments'], [/^播放 (.+) · 赞 (.+) · 评 (.+)$/, (m, a, b, c) => `${tr(a)} views · ${tr(b)} likes · ${tr(c)} comments`], [/^播放 (.+) · 赞 (.+)$/, (m, a, b) => `Views ${tr(a)} · likes ${tr(b)}`],
    [/^(\d+) 分钟前$/, '$1 min ago'], [/^(\d+) 小时前$/, '$1 h ago'], [/^(\d+) 天前$/, '$1 d ago'],
    [/^(\d+) 个可用 · 至少需要 (\d+) 个$/, '$1 usable · at least $2 needed'], [/^(\d+) 可用$/, '$1 usable'], [/^(\d+)\/(\d+) 条启用。类别名会标在每条推文上，Claude 精选时按类别各取一部分$/, '$1/$2 on. Each post is tagged with its category, and Claude takes some from each category when curating'],
    [/^每轮约 (\d+) 次请求，每天约 (\d+) 次(?:，号池每天上限 (\d+) 次)?$/, (m, a, b, c) => `About ${a} requests per run, ${b} per day` + (c ? `; the pool allows ${c} per day` : '')],
    [/^(.+) 的搜索语句$/, (m, a) => `Query for ${a}`], [/^最后使用 (.+)$/, 'Last used $1'], [/^推特 (\d+)$/, 'X $1'], [/^(.+) 粉$/, (m, a) => `${tr(a)} followers`], [/^(\d+) 张图$/, '$1 photos'],
    [/^视频 ?(\d+:\d+)?$/, (m, a) => 'Video' + (a ? ' ' + a : '')], [/^引用 (.+)$/, 'Quotes $1'], [/^· 第 (\d+) 次$/, '· attempt $1'],
    [/^赞 (.+) · 转 (.+) · 评 (.+?)(?: · 浏览 (.+))?$/, (m, a, b, c, d) => `${tr(a)} likes · ${tr(b)} reposts · ${tr(c)} replies` + (d ? ` · ${tr(d)} views` : '')],
    [/^可用账号只有 (\d+) 个，少于 (\d+) 个，请在「渠道 → 推特」补充账号$/, 'Only $1 usable accounts, fewer than $2; add more under Sources → X'],
    [/^可用账号每 (.+) 小时体检一次，新加的账号一分钟内体检。体检就是用这个号搜一次推特：能登录不代表能搜$/, 'Usable accounts are checked every $1 h, new ones within a minute. A check is one search with the account: being able to log in doesn\'t mean it can search'],
    [/^限流、403、超时：进入冷却，按 (.+) 小时重测，成功自动恢复；(.+) 天仍失败判定失效$/, 'Rate limits, 403s, timeouts: cool down and retest after $1 h, restoring on success; invalid after $2 days of failures'],
    [/^账号被锁（326）：去浏览器登录解锁，每 (.+) 小时重测，解锁后自动恢复；(.+) 天没解锁判定失效$/, 'Locked (326): unlock by logging in in a browser; retested every $1 h and restored once unlocked; invalid after $2 days'],
    [/^每个账号每天最多 (\d+) 次请求，用满当天停用；两次请求至少间隔 (.+) 秒，优先用最久没用的账号$/, 'Each account makes at most $1 requests a day and rests once used up; at least $2 s between requests, least recently used account first'],
    [/^保存结果：新增 (\d+) 个，更新 (\d+) 个，重复跳过 (\d+) 个，格式无效 (\d+) 个。(.*)$/, (m, a, b, c, d, e) => `Saved: ${a} added, ${b} updated, ${c} duplicates skipped, ${d} invalid. ` + (e.startsWith('新账号') ? 'New accounts are checked within a minute.' : e ? 'Your input was kept; fix it using the notes below and save again.' : '')],
    [/^体检完成：(.+)$/, (m, a) => 'Check finished: ' + a.replace('正常', 'OK').replace('冷却', 'cooling').replace('待解锁', 'locked').replace('失效', 'invalid').replace('跳过', 'skipped').replace(/，/g, ', ').replace(/。所有账号都没有结果，可能是网络或代理问题，账号状态没有改动$/, '. No account got an answer; probably a network problem, statuses unchanged').replace('没有需要检测的账号', 'no accounts to check')],
    [/^已删除 (.+)$/, 'Deleted $1'], [/^试搜：按热门取最近两天前 (\d+) 条$/, 'Test: top $1 posts from the last two days'],
    [/^（连话题现在 (\d+)\/280，超出会从正文末尾截掉）$/, '($1/280 with hashtags; anything over is cut from the end of the text)'],
    [/^推文正文$/, 'Post text'],
    [/^(\d+) 天$/, '$1 days'], [/^(\d+)\/(\d+) 组启用。按播放量取最近几天的视频，类别名会标在每条视频上，Claude 精选时按类别各取一部分$/, '$1/$2 on. Takes the most-viewed videos from the last few days; each video is tagged with its category, and Claude takes some from each category when curating'],
    [/^每轮约 (\d+) 点额度，每天约 (\d+) 点(?:；今天已用 (\d+) \/ (\d+)，(.+) 恢复)?。定时抓取会给 Claude 临时搜索留 3000 点，不够时这轮少搜几组$/, (m, a, b, u, l, t) => `About ${a} units per run, ${b} per day` + (u ? `; ${u} / ${l} used today, resets at ${t}` : '') + '. Scheduled fetching keeps 3000 units for Claude\'s own searches and skips groups when short'],
    [/^(.+) 的语言$/, (m, a) => `Language for ${a}`], [/^(.+) 的关键词$/, (m, a) => `Keywords for ${a}`], [/^YouTube (\d+)$/, 'YouTube $1'],
    [/^最近 7 天 · (\d+) 条$/, 'Last 7 days · $1'],
    [/^试搜：最近 (\d+) 天播放最多的前 (\d+) 条（用了 100 点额度，今天还剩 (\d+)）$/, 'Test: top $2 most-viewed from the last $1 days (used 100 units, $3 left today)'],
    [/^(.+) 播放$/, (m, a) => `${tr(a)} views`], [/^Shorts (.+)$/, 'Shorts $1'],
    [/^YouTube 拒绝了这个 API key：(.+)$/, 'YouTube rejected this API key: $1'], [/^今天的 YouTube 额度只剩 (\d+) 点，留给 Claude 临时搜索，这轮没搜$/, 'Only $1 YouTube units left today, kept for Claude\'s searches; skipped this run'],
    [/^(.+) 拆解$/, (m, a) => `Torn down ${a}`], [/^没拿到字幕：(.+)$/, (m, a) => `No captions: ${tr(a)}`],
    [/^字幕：(作者上传的|自动生成的)（(.*)），(.+) 拉取$/, (m, a, b, c) => `Captions: ${a === '作者上传的' ? 'uploaded by the creator' : 'auto-generated'} (${b}), fetched ${c}`],
    [/^拆解视频要拉字幕。不登录也能拉，但 YouTube 有时会要求「登录以确认不是机器人」；登录后，被拦时会用你的账号再试一次。只在被拦时才用，两次至少隔 (\d+) 秒，每天最多 (\d+) 次（防出错时狂刷）。用账号跑 yt-dlp，YouTube 可能限制或封禁这个账号，建议用小号。登录信息只存在这台电脑上。$/, 'Teardowns need captions. They can be fetched without logging in, but YouTube sometimes asks to "sign in to confirm you\'re not a bot"; once logged in, a blocked request is retried with your account. It\'s only used when blocked, at least $1 s apart and at most $2 times a day (a guard against runaway retries). Running yt-dlp with an account may get it limited or banned by YouTube, so a spare account is recommended. The session stays on this computer.'],
    [/^今天用登录拉了 (\d+) \/ (\d+) 次$/, 'Used the login $1 / $2 times today'], [/^今天用登录拉字幕已经 (\d+) 次了，为了保护账号先停一停，明天再试$/, 'The login has been used $1 times today; pausing to protect the account until tomorrow'],
    [/^(\d+) 分 (\d+) 秒$/, '$1 m $2 s'], [/^(\d+) 轮$/, '$1 turns'], [/^(\d+)\/(\d+) 平台已连$/, '$1/$2 platforms bound'],
  ];

  const cache = new Map();
  function tr(text) {
    if (!text || !/[一-鿿]/.test(text)) return text;
    if (cache.has(text)) return cache.get(text);
    let out = text;
    const lead = text.match(/^\s*/)[0], trail = text.match(/\s*$/)[0];
    const core = text.trim();
    if (EN[core] !== undefined) out = lead + EN[core] + trail;
    else {
      for (const [re, rep] of PATTERNS) {
        if (re.test(core)) { out = lead + core.replace(re, rep) + trail; break; }
      }
      // 「选题雷达 → 账号选题」这种路径：逐段翻译
      if (out === text && core.includes(' → ')) {
        const parts = core.split(' → ').map((p) => tr(p));
        if (parts.join(' → ') !== core) out = lead + parts.join(' → ') + trail;
      }
      // 「a · b · c」这种拼起来的状态行：逐段翻译
      if (out === text && core.includes(' · ') && !core.includes(' → ')) {
        const parts = core.split(' · ').map((p) => tr(p));
        if (parts.join(' · ') !== core) out = lead + parts.join(' · ') + trail;
      }
    }
    cache.set(text, out);
    return out;
  }
  window.tr = tr;

  const ATTRS = ['placeholder', 'title', 'aria-label'];
  function walk(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.currentNode; n; n = w.nextNode()) {
      if (n.nodeType === 3) {
        if (n.parentElement && /^(TEXTAREA|SCRIPT|STYLE)$/.test(n.parentElement.tagName)) continue;
        if (n.parentElement?.closest('[contenteditable="true"],.no-tr')) continue;
        const v = n.nodeValue; const t = tr(v); if (t !== v) n.nodeValue = t;
      } else {
        for (const a of ATTRS) { const v = n.getAttribute?.(a); if (v) { const t = tr(v); if (t !== v) n.setAttribute(a, t); } }
      }
    }
  }
  const mo = new MutationObserver((list) => {
    mo.disconnect();
    for (const m of list) {
      if (m.type === 'characterData') { const v = m.target.nodeValue, t = tr(v); if (t !== v) m.target.nodeValue = t; }
      else m.addedNodes.forEach((n) => (n.nodeType === 3 ? (n.nodeValue = tr(n.nodeValue)) : n.nodeType === 1 && walk(n)));
    }
    observe();
  });
  const observe = () => mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  const start = () => { walk(document.body); document.title = tr(document.title); observe(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
