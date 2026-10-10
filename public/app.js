const STAGES=[{k:'idea',n:'选题'},{k:'script',n:'脚本'},{k:'production',n:'生产中'},{k:'scheduled',n:'待发布'},{k:'published',n:'已发布'}];
const PLATFORMS=[{k:'douyin',n:'抖音'},{k:'bilibili',n:'B站'},{k:'xhs',n:'小红书'}];
const EMOTIONS=['感动','怀旧','好笑','反差','爽感','代入','治愈','震惊','好奇'];
const COLORS=['amber','blue','violet','green','rose','teal'];
const METRICS=[{k:'views',n:'播放'},{k:'likes',n:'点赞'},{k:'comments',n:'评论'},{k:'shares',n:'分享'},{k:'follows',n:'涨粉'}];
const CHECKS=[
  {k:'notMisleading',n:'不会让人误以为是真实事件、新闻或监控画面',red:true},
  {k:'noRealPerson',n:'没有用 AI 伪造真人的脸或声音',red:true},
  {k:'distinct',n:'和矩阵里其他账号的内容不同，不是换皮复用',red:true},
  {k:'hook',n:'前 3 秒有违和感或好奇缺口'},
  {k:'emotion',n:'命中至少一种高唤醒情绪：感动、好笑、震惊、爽'}
];
const SCORE_KEYS=[{k:'hook',n:'钩子'},{k:'emotion',n:'情绪'},{k:'relate',n:'代入'},{k:'social',n:'转发'}];
// 主流程五步按顺序走，其他页面放在右边
const STEPS=[{k:'sources',n:'渠道'},{k:'feed',n:'素材'},{k:'radar',n:'选题雷达'},{k:'ideas',n:'账号选题'},{k:'pipeline',n:'流水线'}];
const MORE=[{k:'home',n:'总览'},{k:'calendar',n:'日历'},{k:'data',n:'数据复盘'},{k:'accounts',n:'账号矩阵'},{k:'skills',n:'技能'},{k:'settings',n:'设置'}];
const TABS=[...STEPS,...MORE];
const STAGE_IDX=Object.fromEntries(STAGES.map((s,i)=>[s.k,i]));

const S={tab:'home',accounts:{},items:{},radar:null,analysis:null,db:null,sample:null,mode:'loading',aiOff:false,
  open:null,draft:null,filter:'all',ideaFilter:'all',picks:{},runs:{},pickOpen:null,pickAcc:new Set(),pickN:3,gen:null,pendingRender:false};
const local={accounts:{},items:{},radar:{},notes:{},picks:{},agentRuns:{},settings:{}};

const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);
const pad=n=>String(n).padStart(2,'0');
const ymd=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
const today=()=>ymd(new Date());
const fmtN=n=>{n=Number(n)||0;return n>=1e8?(n/1e8).toFixed(2)+'亿':n>=1e4?(n/1e4).toFixed(1)+'万':String(n)};
const WEEK='日一二三四五六';

try{const t=localStorage.getItem('wb.tab');if(t&&TABS.some(x=>x.k===t))S.tab=t}catch(e){}
const h0=(location.hash||'').slice(1);if(TABS.some(x=>x.k===h0))S.tab=h0;

/* ---------- 接口 ---------- */
async function api(method,url,body,signal){
  const r=await fetch(url,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw j.error||{code:'http_'+r.status,message:'请求失败（'+r.status+'）'};
  return j;
}
// 读取服务端推送的 SSE 事件（text / done / error）
async function sse(url,body,{signal,onEvent}){
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
  if(!r.ok){const j=await r.json().catch(()=>({}));throw j.error||{code:'http_'+r.status,message:'请求失败（'+r.status+'）'}}
  const reader=r.body.getReader();const dec=new TextDecoder();let buf='';
  for(;;){const {value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
    let i;while((i=buf.indexOf('\n\n'))>=0){const chunk=buf.slice(0,i);buf=buf.slice(i+2);let ev='message',data='';
      for(const line of chunk.split('\n')){if(line.startsWith('event:'))ev=line.slice(6).trim();else if(line.startsWith('data:'))data+=line.slice(5).trim()}
      if(data)onEvent(ev,JSON.parse(data))}}
}

/* ---------- store：先改本地再写服务端，失败就重新拉取 ---------- */
const chains={};
function queue(path,fn){const p=(chains[path]||Promise.resolve()).then(fn,fn);chains[path]=p.catch(()=>{});return p.catch(e=>{toast(dbErr(e));loadState()})}
function merge(a,b){const o={...a};for(const k in b){const v=b[k];o[k]=(v&&typeof v==='object'&&!Array.isArray(v)&&a[k]&&typeof a[k]==='object'&&!Array.isArray(a[k]))?merge(a[k],v):v}return o}
function applyLocal(col){
  if(col==='accounts')S.accounts={...local.accounts};
  if(col==='items')S.items={...local.items};
  if(col==='radar')S.radar=local.radar.latest||null;
  if(col==='notes')S.analysis=local.notes.analysis||null;
  if(col==='picks')S.picks={...local.picks};
  if(col==='agentRuns')S.runs={...local.agentRuns};
  if(col==='settings')S.settings={...local.settings};
  requestRender();
  if(S.open&&(col==='items'||col==='agentRuns'))syncDrawer();
  if(S.runView&&col==='agentRuns')renderRunView();
}
// 后台 Agent 写回脚本、预审结果，或运行状态变了，内容详情跟着更新；正在输入时只更新进度，不打断
// 详情里决定要不要整体重画的那些状态；画完就记下来，数据刷新时没变就不重画
function drawerSigOf(id,it){
  const rs=itemRun('script',id),rc=itemRun('check',id),rv=itemRun('video',id),rr=itemRun('revise',id),re=itemRun('research',id),any=runningRun(),anyV=runningVideo();
  const pb=it.publish||{};
  return [(it.assets||[]).map(a=>a.id).join(','),pb.gen?.status,pb.cover,JSON.stringify(Object.fromEntries(Object.entries(pb.results||{}).map(([k,v])=>[k,v.status]))),!!pb.platforms,re?.id,re?.status,it.research?.at,rs?.id,rs?.status,rc?.id,rc?.status,rv?.id,rv?.status,rr?.id,rr?.status,any?.id,anyV?.id,it.stage,JSON.stringify(it.precheck||null),JSON.stringify(it.video||null)].join('|');
}
let drawerSig='';
function syncDrawer(){
  const id=S.open,it=local.items[id];if(!it||!S.draft)return;
  if(typeof it.script==='string'&&it.script!==S.draft.script&&!saveTimers.script&&!(S.gen&&S.gen.kind==='script')&&document.activeElement?.id!=='dScript'){
    S.draft.script=it.script;const t=$('#dScript');if(t)t.value=it.script}
  const rs=itemRun('script',id),rc=itemRun('check',id),rv=itemRun('video',id),rr=itemRun('revise',id),re=itemRun('research',id);
  const sig=drawerSigOf(id,it);
  const a=document.activeElement;const typing=a&&$('#drawerRoot').contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  if(sig!==drawerSig&&!typing){drawerSig=sig;renderDrawer();return}
  const upd=(el,html)=>{if(el)keepLogScroll(el,()=>{el.innerHTML=html})};
  if(modeOf('script')==='agent')upd($('#scriptRun'),vRunMini(rs));
  if(modeOf('check')==='agent')upd($('#checkRun'),vRunMini(rc));
  upd($('#videoRun'),vRunMini(rv));
  upd($('#reviseRun'),vRunMini(rr));
  upd($('#researchRun'),vRunMini(re));
  upd($('#pubStatus'),vPubStatus(it));
}
const store={
  set(col,id,data){local[col][id]=data;applyLocal(col);return queue(col+'/'+id,()=>api('PUT',`/api/${col}/${id}`,data))},
  update(col,id,patch){local[col][id]=merge(local[col][id]||{},patch);applyLocal(col);return queue(col+'/'+id,()=>api('PATCH',`/api/${col}/${id}`,patch))},
  del(col,id){delete local[col][id];applyLocal(col);return queue(col+'/'+id,()=>api('DELETE',`/api/${col}/${id}`))}
};
function dbErr(e){return e&&e.message&&!String(e.code||'').startsWith('http_')?e.message:'保存失败：连不上本地服务，确认 npm start 还在运行。'}
async function loadState(){
  try{const d=await api('GET','/api/state');
    const cols=['accounts','items','radar','notes','picks','agentRuns','settings'];
    for(const c of cols)local[c]=d[c]||{};
    cols.forEach(c=>applyLocal(c));S.mode='synced';
  }catch(e){S.mode='offline'}
  render();
}

/* ---------- helpers ---------- */
const accList=(all)=>Object.entries(S.accounts).map(([id,v])=>({id,...v})).filter(a=>all||a.active!==false).sort((a,b)=>(a.order??99)-(b.order??99)||String(a.code).localeCompare(String(b.code)));
const itemList=()=>Object.entries(S.items).map(([id,v])=>({id,...v}));
function accTag(id){const a=S.accounts[id];if(!a)return '<span class="tag">未知账号</span>';return `<span class="tag c-${esc(a.color||'blue')}"><b>${esc(a.code)}</b>${esc(a.name)}</span>`}
const checksDone=it=>CHECKS.filter(c=>it.checks&&it.checks[c.k]).length;
const views=it=>PLATFORMS.reduce((s,p)=>s+(Number(it.metrics?.[p.k]?.views)||0),0);
const msum=(it,k)=>PLATFORMS.reduce((s,p)=>s+(Number(it.metrics?.[p.k]?.[k])||0),0);
const stageName=k=>(STAGES.find(s=>s.k===k)||STAGES[0]).n;
function fmtSched(s){if(!s)return '';const d=new Date(s);if(isNaN(d))return '';return (d.getMonth()+1)+'/'+d.getDate()+' '+pad(d.getHours())+':'+pad(d.getMinutes())}

let toastT;
function toast(msg){const r=$('#toastRoot');r.innerHTML=`<div class="toast" role="status">${esc(msg)}</div>`;clearTimeout(toastT);toastT=setTimeout(()=>r.innerHTML='',3200)}

function aiErr(e){if(e&&e.name==='AbortError')return '已停止。';if(e&&e.code==='auth'){S.aiOff=true;renderStatus()}
  return (e&&e.message&&!String(e.code||'').startsWith('http_'))?e.message:'生成失败：连不上本地服务，确认 npm start 还在运行。'}
const aiReady=()=>S.mode==='synced';
function startGen(kind){if(S.gen){toast('上一个 AI 任务还没结束');return null}const ctl=new AbortController();S.gen={kind,ctl};renderStatus();return ctl}
function endGen(){S.gen=null;renderStatus()}

/* ---------- render core ---------- */
function requestRender(){const a=document.activeElement;const v=$('#view');if(a&&v.contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){S.pendingRender=true;renderStatus();return}render()}
$('#view').addEventListener('focusout',()=>{if(S.pendingRender)setTimeout(()=>{const a=document.activeElement;if(!(a&&$('#view').contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))){S.pendingRender=false;render()}},180)});

function render(){renderStatus();renderTabs();renderBanner();
  const v={home:vHome,radar:vRadar,ideas:vIdeas,feed:vFeed,settings:vSettings,pipeline:vPipeline,calendar:vCalendar,accounts:vAccounts,data:vData,sources:vSources,skills:vSkills}[S.tab];
  const html=v();keepLogScroll($('#view'),()=>{$('#view').innerHTML=html});

}
function renderStatus(){
  const m=S.mode==='synced'?'<span class="pill ok"><i></i>已连接本地服务</span>':S.mode==='offline'?'<span class="pill bad"><i></i>服务未启动</span>':'<span class="pill"><i></i>连接中</span>';
  const run=runningRun();
  const vrun=runningVideo();
  const ai=(vrun?`<span class="pill warn"><i></i>Claude ${esc(vrun.name)}中</span>`:'')+(run?`<span class="pill warn"><i></i>Claude ${esc(run.name)}中</span>`:S.gen?'<span class="pill warn"><i></i>Claude 生成中</span>':S.aiOff?'<span class="pill bad" title="在终端运行 claude setup-token，把令牌填进 .env 的 CLAUDE_CODE_OAUTH_TOKEN 后重启工作台"><i></i>Claude 登录失效</span>':'');
  $('#status').innerHTML=m+ai;
}
function stepCount(k){
  const its=itemList();
  if(k==='sources'){const ch=S.feed?.channels;if(!ch)return '';const bad=ch.filter(c=>c.lastRun?.error).length;return bad?`${bad} 个出错`:`${ch.length} 个在跑`}
  if(k==='feed'){const n=S.feed?.items?.length;return n==null?'':`24 小时 ${n}${n>=800?'+':''} 条`}
  if(k==='radar'){if(runningRun('curate'))return 'Claude 精选中…';const n=pickList().filter(p=>p.status==='new').length;return n?`${n} 个待决定`:'没有待决定'}
  if(k==='ideas'){if(runningRun('ideas'))return 'Claude 出题中…';const n=(S.radar?.ideas||[]).length;return n?`${n} 个待挑`:'没有待挑'}
  if(k==='pipeline'){const sch=its.filter(i=>i.stage==='scheduled').length;return sch?`${sch} 个待发布`:`进行中 ${its.filter(i=>i.stage!=='published').length}`}
  return '';
}
function renderTabs(){
  $('#tabs').innerHTML=`<div class="steps">${STEPS.map((t,i)=>`${i?'<span class="step-arrow" aria-hidden="true">→</span>':''}<button class="step-tab" role="tab" aria-selected="${S.tab===t.k}" aria-label="第 ${i+1} 步 ${t.n}${stepCount(t.k)?'，'+esc(stepCount(t.k)):''}" data-act="tab" data-k="${t.k}"><span class="step-no num">${i+1}</span><span class="step-txt"><b>${t.n}</b><small>${esc(stepCount(t.k))}</small></span></button>`).join('')}</div>
    <div class="more-tabs">${MORE.map(t=>`<button class="tab" role="tab" aria-selected="${S.tab===t.k}" data-act="tab" data-k="${t.k}">${t.n}</button>`).join('')}</div>`;
  // 窄屏时步骤条会横向滚动，保证当前这一步露出来
  const cur=$('.step-tab[aria-selected="true"]');if(cur){const bar=cur.parentElement;bar.scrollLeft=Math.max(0,cur.offsetLeft-bar.clientWidth/2+cur.clientWidth/2)}
}
function renderBanner(){$('#banner').innerHTML=S.mode==='offline'?'<div class="banner">连不上本地服务。在项目目录运行 <b>npm start</b>，然后刷新页面。</div>':''}

/* ---------- 总览 ---------- */
function vHome(){
  const accs=accList();const its=itemList();
  if(S.mode==='synced'&&!accs.length&&!its.length)return `<div class="empty"><strong>还没有账号</strong>先去「账号矩阵」建好你的账号和人设，选题和脚本都会按人设来生成。<div style="margin-top:12px"><button class="btn primary" data-act="tab" data-k="accounts">添加第一个账号</button></div></div>`;
  const week=Date.now()-7*864e5;
  const cards=accs.map(a=>{const mine=its.filter(i=>i.accountId===a.id);
    const n=k=>mine.filter(i=>i.stage===k).length;
    const pub7=mine.filter(i=>i.stage==='published'&&i.publishedAt&&new Date(i.publishedAt).getTime()>=week).length;
    const tv=mine.filter(i=>i.stage==='published').reduce((s,i)=>s+views(i),0);
    const fol=mine.reduce((s,i)=>s+msum(i,'follows'),0);
    return `<article class="panel acc-card c-${esc(a.color)}">
      <div>${accTag(a.id)}<p class="aud" style="margin-top:6px">${esc(a.audience)}</p></div>
      <div class="stats">
        <div class="stat"><span class="v">${n('idea')}</span><span class="k">选题池</span></div>
        <div class="stat"><span class="v">${n('script')+n('production')}</span><span class="k">制作中</span></div>
        <div class="stat ${n('scheduled')?'hot':''}"><span class="v">${n('scheduled')}</span><span class="k">待发布</span></div>
        <div class="stat"><span class="v">${pub7}</span><span class="k">近 7 天发布</span></div>
      </div>
      <div class="acc-foot"><span>累计播放 <b class="num">${fmtN(tv)}</b></span><span>涨粉 <b class="num">${fmtN(fol)}</b></span></div>
    </article>`}).join('');
  const funnel=STAGES.map(s=>`<button data-act="goto-stage" data-k="${s.k}"><span class="k"><i class="sd s-${s.k}"></i>${s.n}</span><span class="v">${its.filter(i=>i.stage===s.k).length}</span></button>`).join('');
  const t=today();
  const todo=[];
  its.filter(i=>i.stage==='scheduled'&&i.scheduledAt&&i.scheduledAt.slice(0,10)===t).forEach(i=>todo.push({i,why:'今天发布 '+fmtSched(i.scheduledAt).split(' ')[1]}));
  its.filter(i=>i.stage==='scheduled'&&i.scheduledAt&&i.scheduledAt.slice(0,10)<t).forEach(i=>todo.push({i,why:'排期已过，发了吗？'}));
  its.filter(i=>i.stage==='published'&&!views(i)).forEach(i=>todo.push({i,why:'还没填数据'}));
  const ideas=(S.radar?.ideas||[]).length;
  const todoHtml=todo.length||ideas?`<div class="list">${ideas?`<button class="row" data-act="tab" data-k="ideas"><i class="sd s-idea"></i><span class="t">「账号选题」里有 ${ideas} 个选题等你挑</span><span class="meta">去挑选</span></button>`:''}${todo.slice(0,12).map(x=>`<button class="row" data-act="open" data-id="${x.i.id}"><i class="sd s-${x.i.stage}"></i>${accTag(x.i.accountId)}<span class="t">${esc(x.i.title)}</span><span class="meta">${esc(x.why)}</span></button>`).join('')}</div>`:'<div class="empty">今天没有待办。去「选题雷达」生成一批新选题吧。</div>';
  return `<div class="home-grid">
    <div class="grid">
      <div class="section-head"><h2>账号矩阵</h2><p>按人群分号，每个号的人设和内容都不一样</p></div>
      <div class="grid cols-acc">${cards||'<div class="empty">账号加载中…</div>'}</div>
      <div class="section-head" style="margin-top:10px"><h2>内容流水线</h2><p>点一个阶段直接跳过去</p></div>
      <div class="funnel">${funnel}</div>
      <div class="section-head" style="margin-top:10px"><h2>今天要做的</h2></div>
      <div class="panel">${todoHtml}</div>
    </div>
    <aside class="grid">
      ${vDataService()}
      <div class="panel grid" style="gap:10px"><div class="label">发布前的红线</div>
        <ol class="rules"><li>不伪造新闻、事件、测试结果和数据</li><li>不用 AI 伪造真人的脸和声音</li><li>矩阵各号内容必须真的不同，换字幕换配音会被语义查重</li><li>评论由真人回复，不用机器人互动</li></ol></div>
      <div class="panel grid" style="gap:10px"><div class="label">自动化进度</div>
        <div class="road">
          <div><span class="st done">已上线</span><span>AI 按人设批量生成选题，带爆款评分</span></div>
          <div><span class="st done">已上线</span><span>AI 写分镜脚本，含三平台版本差异</span></div>
          <div><span class="st done">已上线</span><span>AI 预审和人工审核清单，没过审不能排期</span></div>
          <div><span class="st done">已上线</span><span>数据汇总和 AI 复盘</span></div>
          <div><span class="st done">已上线</span><span>全网热榜聚合（抖音、微博、B站、知乎、百度、头条）</span></div>
          <div><span class="st done">已上线</span><span>Claude 每日选题：在桌面端说「跑一下今天的选题」</span></div>
          <div><span class="st next">下一期</span><span>每日定时自动跑选题</span></div>
          <div><span class="st next">下一期</span><span>接入平台官方定时发布和开放平台接口</span></div>
          <div><span class="st next">下一期</span><span>各平台数据自动回收</span></div>
        </div></div>
    </aside>
  </div>`;
}

/* ---------- 选题雷达（第 3 步）和账号选题（第 4 步） ---------- */
const CH_NAMES={douyin:'抖音',xiaohongshu:'小红书',web:'网页',weibo:'微博',bilibili:'B站',zhihu:'知乎',baidu:'百度',toutiao:'头条','bilibili-video':'B站热门视频',hackernews:'Hacker News'};
const fmtTime=ts=>{if(!ts)return '';const d=new Date(ts);return pad(d.getMonth()+1)+'-'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes())};
const pickList=()=>Object.entries(S.picks||{}).map(([id,v])=>({id,...v})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
const runList=()=>Object.entries(S.runs||{}).map(([id,v])=>({id,...v})).sort((a,b)=>(b.startedAt||0)-(a.startedAt||0));
// 不指定任务时只看主队列（生成视频走单独的队列，不算“Claude 正忙”）
const VIDEO_TASKS=['video','revise'];
const runningRun=task=>runList().find(r=>r.status==='running'&&(task?r.task===task:!VIDEO_TASKS.includes(r.task)));
const runningVideo=()=>runList().find(r=>r.status==='running'&&VIDEO_TASKS.includes(r.task));
// 任务进行中插话：输入框放在会频繁刷新的进度区外面，打字不会被打断
const vSay=run=>run?.status==='running'?`<div class="say"><input type="text" id="say-${esc(run.id)}" value="${esc(S.say?.[run.id]||'')}" placeholder="有疑问或想调整，直接说，例如：片尾那行字太小了" aria-label="对正在运行的 Claude 说"><button class="btn" data-act="agent-say" data-id="${esc(run.id)}">插话</button></div>`:'';
const lastRun=task=>runList().find(r=>r.task===task);
// 写脚本、预审、复盘的调用方式：设置里没改过就用默认（和 server/models.js 保持一致）
const DEFAULT_MODES={script:'agent',check:'oneshot',analysis:'oneshot'};
const modeOf=k=>{const m=(local.settings.modes||{})[k];return m==='agent'||m==='oneshot'?m:DEFAULT_MODES[k]};
const itemRun=(task,id)=>runList().find(r=>r.task===task&&r.args?.itemId===id);
// 内容详情里显示后台 Agent 的进度：运行中显示最近几步，失败显示原因，刚完成显示汇报
const KIND_LABEL={tool:'操作',text:'说明',error:'出错',user:'你'};
const fmtOffset=(at,start)=>{const x=Math.max(0,Math.round((at-start)/1000));return Math.floor(x/60)+':'+pad(x%60)};
const fmtSecs=x=>(x>=60?Math.floor(x/60)+' 分 ':'')+(x%60)+' 秒';
const fmtDur=run=>fmtSecs(Math.round(((run.finishedAt||Date.now())-run.startedAt)/1000));
// 运行中的时长每秒走一次：长时间没有新步骤（比如在等一个慢网页）时，页面不重画，时长也不能停
const vDur=run=>run.status==='running'?`<span class="run-dur" data-start="${run.startedAt}">${fmtDur(run)}</span>`:fmtDur(run);
setInterval(()=>{for(const el of document.querySelectorAll('.run-dur[data-start]'))el.textContent=fmtSecs(Math.round((Date.now()-Number(el.dataset.start))/1000))},1000);
const laneBusy=run=>VIDEO_TASKS.includes(run.task)?runningVideo():runningRun();
// 完整过程：可滚动，新步骤自动滚到底，往上翻时不打扰
function vLog(run,tall){
  const steps=run.steps||[];
  if(!steps.length)return '<p class="hint">正在启动…</p>';
  return `<ol class="run-log${tall?' tall':''}" data-run="${esc(run.id)}">${steps.map(x=>`<li class="k-${esc(x.kind)}"><time>${fmtOffset(x.at,run.startedAt)}</time><span class="kl">${KIND_LABEL[x.kind]||''}</span><span class="tx">${esc(x.text)}</span></li>`).join('')}</ol>`;
}
// 运行状态标签
function runPill(run){
  const st={running:['warn','中'],done:['ok',' · 完成'],failed:['bad',' · 失败'],stopped:['',' · 已停止']}[run.status]||['',''];
  return `<span class="pill ${st[0]}"><i></i>Claude ${esc(run.name)}${st[1]} · ${vDur(run)}${run.steps?.length?' · '+run.steps.length+' 步':''}</span>`;
}
// 内容详情里显示后台 Agent 的进度
function vRunMini(run){
  if(!run)return '';
  const recent=Date.now()-(run.finishedAt||0)<36e5;
  const head=`<div class="run-head2">${runPill(run)}<button class="btn ghost" data-act="run-view" data-id="${esc(run.id)}">全屏查看</button></div>`;
  if(run.status==='running')return `<div class="run-mini">${head}${vLog(run)}</div>`;
  const canResume=(run.status==='failed'||run.status==='stopped')&&run.sessionId&&!laneBusy(run);
  const resumeBtn=canResume?`<button class="btn" data-act="agent-resume" data-id="${esc(run.id)}">从中断处继续</button>`:'';
  const past=`<details class="run-past"><summary>查看过程（${(run.steps||[]).length} 步）</summary>${vLog(run)}</details>`;
  if(run.status==='failed')return `<div class="run-mini">${head}<p class="err">${esc(run.error||'失败')}</p>${resumeBtn?`<div>${resumeBtn} <span class="hint">接着上次的会话做，已经做好的部分不会重做</span></div>`:''}${past}</div>`;
  if(run.status==='stopped')return `<div class="run-mini">${head}${resumeBtn?`<div>${resumeBtn}</div>`:''}${past}</div>`;
  if(run.status==='done'&&recent)return `<div class="run-mini">${head}${run.result?`<p class="hint">Claude：${mdLite(run.result.slice(0,300))}</p>`:''}${past}</div>`;
  return '';
}
// 整块替换内容时保留日志的滚动位置：原来在底部就继续贴底，翻到上面就停在原处
function keepLogScroll(container,fn){
  const saved={};
  container?.querySelectorAll('.run-log').forEach(l=>{saved[l.dataset.run]={top:l.scrollTop,bottom:l.scrollHeight-l.scrollTop-l.clientHeight<30}});
  fn();
  container?.querySelectorAll('.run-log').forEach(l=>{const v=saved[l.dataset.run];l.scrollTop=!v||v.bottom?l.scrollHeight:v.top});
}
// 全屏查看一次运行
function renderRunView(){
  const root=$('#runViewRoot');if(!root)return;
  const run=S.runView&&S.runs?.[S.runView]?{id:S.runView,...S.runs[S.runView]}:null;
  if(!run){root.innerHTML='';return}
  const canResume=(run.status==='failed'||run.status==='stopped')&&run.sessionId&&!laneBusy(run);
  const body=`<div class="rv-head">${runPill(run)}${run.model?`<span class="faint num">${esc(modelName(run.model))}</span>`:''}
      <div class="actions">${run.status==='running'?`<button class="btn" data-act="agent-stop" data-id="${esc(run.id)}">停止</button>`:''}${canResume?`<button class="btn" data-act="agent-resume" data-id="${esc(run.id)}">从中断处继续</button>`:''}<button class="btn ghost" data-act="run-view-close">关闭</button></div></div>
    ${run.error?`<p class="err">${esc(run.error)}</p>`:''}
    ${run.result&&run.status!=='running'?`<div class="run-result">${mdLite(run.result)}</div>`:''}
    ${vLog(run,true)}
    ${run.sessionId&&run.status!=='running'?`<p class="hint">想追问 Claude 这次为什么这么做：在项目目录运行 <code>claude --resume ${esc(run.sessionId)}</code></p>`:''}`;
  let box=root.querySelector('.rv-box');
  if(!box){root.innerHTML=`<div class="modal" data-act="run-view-bg"><div class="modal-box rv-box" role="dialog" aria-label="运行过程"><div class="rv-body"></div><div class="rv-say"></div></div></div>`;box=root.querySelector('.rv-box')}
  keepLogScroll(box,()=>{box.querySelector('.rv-body').innerHTML=body});
  // 插话框单独放，状态不变就不重画，打字不会被打断
  const sayEl=box.querySelector('.rv-say');const want=run.status==='running'?run.id:'';
  if(sayEl.dataset.run!==want){sayEl.dataset.run=want;sayEl.innerHTML=vSay(run)}
}
// 内容详情里「AI 写脚本」「AI 预审」按钮，按设置的调用方式显示
function aiActions(kind,id,hasScript){
  const label=kind==='script'?(hasScript?'AI 重写':'AI 写脚本'):'AI 预审';const cls=kind==='script'?'btn primary':'btn';
  if(modeOf(kind)==='oneshot'){const busy=S.gen&&S.gen.kind===kind;const dis=!aiReady()||S.gen||(kind==='check'&&!hasScript);
    return `${busy?'<button class="btn" data-act="stop">停止</button>':''}<button class="${cls}" data-act="ai-${kind}" ${dis?'disabled':''}>${busy?(kind==='script'?'生成中…':'预审中…'):label}</button>`}
  const run=itemRun(kind,id);
  if(run?.status==='running')return `<button class="btn" data-act="agent-stop" data-id="${esc(run.id)}">停止</button><button class="${cls}" disabled>Claude ${kind==='script'?'写脚本':'预审'}中…</button>`;
  const other=runningRun();const dis=!aiReady()||!!other||(kind==='check'&&!hasScript);
  return `<button class="${cls}" data-act="ai-${kind}" ${dis?'disabled':''} title="${other?'Claude 正在跑「'+esc(other.name)+'」，等它结束再点':''}">${other?'Claude 正忙':label}</button>`;
}
// 内容详情里「生成视频」按钮：视频单独排队，同一时间只生成一个
// 本机视频（绝对路径）走工作台的专门接口播放，生成的视频在 videos/ 下走 /media/
const vidUrl=(id,file)=>String(file||'').startsWith('/')?`/api/items/${encodeURIComponent(id)}/video-file?path=${encodeURIComponent(file)}`:`/media/${esc(file)}`;
// 用本机现成视频：只记下文件路径，不复制
function vLocalForm(id,it){
  if(S.localOpen!==id)return '';
  return `<div class="panel local-form">
    <div class="field"><label for="localPath">视频文件 <span class="faint">（直接用原文件，不会复制一份）</span></label>
      <div style="display:flex;gap:8px"><input type="text" id="localPath" placeholder="/Users/你/Movies/xxx.mp4" value="${esc(S.localPath?.[id]||'')}" style="flex:1"><button class="btn" data-act="video-local-pick">选择文件…</button></div></div>
    <div class="field"><label for="localGuide">这条视频讲什么 <span class="faint">（可选，写个大概方向；Claude 还会自己看画面、听语音）</span></label>
      <textarea id="localGuide" rows="3" placeholder="例如：实测三款 AI 写周报工具，结论是只有一款能直接用；想吸引被周报折磨的打工人">${esc(S.localGuide?.[id]||it.video?.guide||'')}</textarea></div>
    <div style="display:flex;gap:8px"><button class="btn primary" data-act="video-local-ok">用这条视频</button><button class="btn ghost" data-act="video-local-cancel">取消</button></div>
    <p class="hint">用了之后卡片直接进「待发布」。后面照常生成标题、简介、话题和封面，勾平台发布。原文件不要移动或删除，发布时直接读它。</p>
  </div>`;
}
function videoActions(id,it){
  const run=itemRun('video',id);
  if(run?.status==='running')return `<button class="btn" data-act="agent-stop" data-id="${esc(run.id)}">停止</button><button class="btn primary" disabled>生成中…</button>`;
  const rv=itemRun('revise',id);
  if(rv?.status==='running')return `<button class="btn" data-act="agent-stop" data-id="${esc(rv.id)}">停止修改</button>`;
  const other=runningVideo();const hasScript=!!String(S.draft?.script||it.script||'').trim();
  const dis=!aiReady()||!!other||!hasScript;
  return `<button class="btn" data-act="video-local-open" title="已经有做好的视频，跳过生成直接发布">用本机视频</button><button class="btn primary" data-act="ai-video" ${dis?'disabled':''} title="${other?'已经有一个视频在生成，等它结束':!hasScript?'先写好脚本':''}">${other?'已有视频在生成':it.video?'重新生成':'生成视频'}</button>`;
}
// 修改意见的附图：先上传到工作台（data/uploads），缩略图用本地地址显示
const vAtts=id=>(S.videoImgs?.[id]||[]).map((x,i)=>`<figure class="att"><img src="${esc(x.url)}" alt="附图 ${i+1}"><figcaption>图 ${i+1}${x.label?' · '+esc(x.label):''}</figcaption><button type="button" class="att-x" data-act="video-unatt" data-i="${i}" aria-label="删除图 ${i+1}">×</button></figure>`).join('');
function refreshAtts(){const el=$('#videoAtts');if(el)el.innerHTML=vAtts(S.open)}
async function attachImage(blob,label){
  const id=S.open;if(!id)return;
  if(!/^image\/(png|jpeg|webp)$/.test(blob.type)){toast('只支持 PNG、JPG、WebP 图片');return}
  const list=S.videoImgs?.[id]||[];if(list.length>=8){toast('最多附 8 张图');return}
  try{
    const r=await fetch('/api/uploads',{method:'POST',headers:{'content-type':blob.type},body:blob});const j=await r.json();
    if(!r.ok)throw j.error||{message:'上传失败'};
    S.videoImgs={...(S.videoImgs||{}),[id]:[...list,{path:j.path,url:URL.createObjectURL(blob),label}]};refreshAtts();
    return (S.videoImgs[id]||[]).length;
  }catch(e){toast(e.message||'上传失败')}
}
// 截取视频当前这一帧：还没解码出画面时先让它跳到当前位置，避免截到黑屏
async function grabFrame(btn){
  const v=document.querySelector('.vplayer');if(!v){return}
  btn.disabled=true;v.pause();
  try{
    if(v.readyState<2)await new Promise((ok,bad)=>{v.addEventListener('seeked',ok,{once:true});v.addEventListener('error',bad,{once:true});v.currentTime=v.currentTime||0.01});
    const t=v.currentTime.toFixed(1);const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));const n=await attachImage(blob,t+' 秒');if(n)appendFb(`[${t} 秒] 见图 ${n}：`);
  }catch{toast('截取失败：视频没加载出来')}
  btn.disabled=false;
}
function appendFb(text){const ta=$('#videoFb');if(!ta)return;ta.value=(ta.value&&!ta.value.endsWith('\n')?ta.value+'\n':ta.value)+text;S.videoFb={...(S.videoFb||{}),[S.open]:ta.value};ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length)}
function vVideo(it,id){
  const v=it.video;if(!v)return '';
  const mb=v.sizeMB?` · ${v.sizeMB} MB`:'';
  const busy=!!runningVideo();
  const local=v.source==='local';const w=v.watch||{};
  const watchLine=!local?'':w.status==='running'?'<p class="hint busy">Claude 正在看这条视频：截画面、听语音，一般不到一分钟…</p>'
    :w.status==='failed'?`<p class="err">没看成：${esc(w.message||'')} <button class="btn" data-act="video-rewatch">重新看</button></p>`
    :w.status==='done'?`<p class="hint">Claude 看过了：${w.frames} 帧画面${w.transcript?`、语音转文字 ${w.transcript.length} 字`:`（${esc(w.transcriptNote||'没有语音')}）`} · ${(w.sheets||[]).map((f,i)=>`<a href="/media/${esc(f)}" target="_blank" rel="noopener">画面 ${i+1}</a>`).join(' ')} <button class="btn ghost" data-act="video-rewatch">重新看</button></p>`:'';
  if(local)return `<video class="vplayer" style="aspect-ratio:${v.width&&v.height?v.width+'/'+v.height:'9/16'}" controls preload="metadata" src="${vidUrl(id,v.mp4)}"></video>
    <div class="kv"><span>版本 <b class="num">${v.version||1}</b></span><span>时长 <b class="num">${v.durationS} 秒</b></span><span>${v.width&&v.height?`${v.width}×${v.height}`:''}</span><span>添加于 <b class="num">${fmtTime(v.at)}</b></span></div>
    <p class="hint">本机文件：${esc(v.mp4)}</p>
    ${watchLine}
    <div class="field"><label for="vGuide">这条视频讲什么 <span class="faint">（生成发布信息时 Claude 会按这个方向写）</span></label><textarea id="vGuide" data-vguide="1" rows="2">${esc(v.guide||'')}</textarea></div>
    ${(v.history||[]).length?`<details class="vhist"><summary>旧版本（${v.history.length}）</summary>${v.history.map(h=>`<div class="row-s"><a href="${vidUrl(id,h.mp4)}" target="_blank" rel="noopener">第 ${h.version||1} 版 · ${h.durationS} 秒</a></div>`).join('')}</details>`:''}`;
  return `<video class="vplayer" style="aspect-ratio:${v.width&&v.height?v.width+'/'+v.height:'9/16'}" controls preload="metadata" src="/media/${esc(v.mp4)}"></video>
    <div class="kv"><span>版本 <b class="num">${v.version||1}</b></span><span>时长 <b class="num">${v.durationS} 秒</b>${mb}</span><span>生成于 <b class="num">${fmtTime(v.at)}</b></span>${v.contactSheet?`<a href="/media/${esc(v.contactSheet)}" target="_blank" rel="noopener">缩略图拼图</a>`:''}</div>
    ${v.notes?`<p class="hint" style="white-space:pre-wrap">Claude 的说明：${esc(v.notes)}</p>`:''}
    <div class="revise">
      <div class="field"><label for="videoFb">修改意见</label>
        <textarea id="videoFb" rows="3" placeholder="边看边写。点「标记当前时间」插入播放到的时间点，例如：[61.2 秒] 片尾这行字太素了，改成黄底黑字">${esc(S.videoFb?.[id]||'')}</textarea></div>
      <div class="atts" id="videoAtts">${vAtts(id)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="video-mark">标记当前时间</button><button class="btn" data-act="video-grab">截取当前画面</button><button class="btn" data-act="video-pick">添加图片</button><input type="file" id="videoFile" accept="image/png,image/jpeg,image/webp" multiple hidden>
        <button class="btn primary" data-act="video-revise" ${busy||!aiReady()?'disabled':''} title="${busy?'已经有视频任务在进行，等它结束':''}">让 Claude 修改</button></div>
      <p class="hint">也可以在意见框里直接粘贴截图（Cmd + V），或把图片拖进来。</p>
      <div id="reviseRun">${vRunMini(itemRun('revise',id))}</div>
      ${vSay(itemRun('revise',id))}
      <p class="hint">只改你提到的地方，渲染成新的一版，旧版本保留。一般 10–30 分钟。</p>
    </div>
    ${(v.history||[]).length?`<details class="vhist"><summary>旧版本（${v.history.length}）</summary>${v.history.map(h=>`<div class="row-s"><a href="${vidUrl(id,h.mp4)}" target="_blank" rel="noopener">第 ${h.version||1} 版 · ${h.durationS} 秒</a><span class="faint num">${fmtTime(h.at)}</span></div>`).join('')}</details>`:''}
    <p class="hint">文件：${esc(v.mp4)}。想在 HyperFrames 里继续改：在 ${esc(v.project)} 目录运行 <code>npx hyperframes preview</code></p>`;
}
// 调研：按钮、报告（正文里的 [n] 点开就是对应来源）
function researchActions(id,it){
  const run=itemRun('research',id);
  if(run?.status==='running')return `<button class="btn" data-act="agent-stop" data-id="${esc(run.id)}">停止</button><button class="btn" disabled>调研中…</button>`;
  const other=runningRun();
  return `<button class="btn ${it.research?'':'primary'}" data-act="ai-research" ${!aiReady()||other?'disabled':''} title="${other?'Claude 正在跑「'+esc(other.name)+'」，等它结束再点':''}">${other?'Claude 正忙':it.research?'重新调研':'AI 调研'}</button>`;
}
function vResearch(r,open){
  const src=r.sources||[];
  const body=esc(r.text).replace(/\[(\d+)\]/g,(m,n)=>{const x=src[Number(n)-1];return x?`<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.title)}">[${n}]</a>`:m});
  return `<details class="research"${open?' open':''}><summary>调研报告 · ${src.length} 个来源 · ${fmtTime(r.at)}</summary>
    <div class="research-text">${body}</div>
    <ol class="research-src">${src.map(x=>`<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>${x.date?` <span class="faint">${esc(x.date)}</span>`:''}</li>`).join('')}</ol>
  </details>`;
}
// 调研时收集的真实素材（网页截图、页面里的视频），做视频时直接当画面用
function vAssets(it){
  const as=it.assets||[];if(!as.length)return '';
  const imgs=as.filter(a=>a.kind==='image').length,vids=as.length-imgs;
  return `<details class="assets" open><summary>收集的素材 · ${imgs} 张截图${vids?` · ${vids} 段视频`:''}</summary><div class="asset-grid">${as.map(a=>`<figure class="asset">
    <a href="/media/${esc(a.file)}" target="_blank" rel="noopener">${a.kind==='video'?`<video src="/media/${esc(a.file)}" muted preload="metadata"></video><span class="asset-kind">视频</span>`:`<img src="/media/${esc(a.file)}" alt="${esc(a.note||a.title||'')}" loading="lazy">`}</a>
    <figcaption><span title="${esc(a.note||'')}">${esc(a.note||a.title||a.part||'')}</span>${safeUrl(a.url)?` <a class="faint" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(new URL(a.url).hostname.replace(/^www\./,''))}</a>`:''} <button class="btn ghost danger" data-act="asset-del" data-id="${esc(a.id)}" aria-label="删除这个素材">删除</button></figcaption></figure>`).join('')}</div></details>`;
}
/* ---------- 发布 ---------- */
const PUB_PLATFORMS=[{k:'douyin',n:'抖音',ready:true},{k:'bilibili',n:'B站',ready:true},{k:'xhs',n:'小红书',ready:true},{k:'youtube',n:'YouTube',ready:true}];
const PUB_LIMITS={douyin:{title:30},bilibili:{title:80},xhs:{title:20},youtube:{title:100}};
async function loadPubAcc(){try{S.pubAcc=await api('GET','/api/publish/accounts');requestRender();if(S.open)renderDrawer()}catch{}}
// 账号卡片上的抖音绑定状态
const BIND_PLATS=[{k:'douyin',n:'抖音'},{k:'xhs',n:'小红书'},{k:'bilibili',n:'B站'},{k:'youtube',n:'YouTube'}];
function vBind(accId,plat){
  const key=`${plat}:${accId}`;const pn=BIND_PLATS.find(x=>x.k===plat)?.n||plat;
  const st=S.pubAcc?.[accId]?.[plat];const lg=S.logins?.[key];
  if(lg&&lg.status!=='done'&&lg.status!=='failed')return `<span class="pill warn"><i></i>${esc(lg.status==='checking'?'正在确认登录…':'等你在弹出的 Chrome 里扫码')}</span>${lg.status==='waiting'?` <button class="btn primary" data-act="bind-done" data-id="${accId}" data-k="${plat}">我已登录</button>`:''}<p class="hint" style="margin-top:4px">${esc(lg.message||'')}</p>`;
  if(!st)return '<span class="faint">读取中…</span>';
  const res=S.bindCheck?.[key];
  return st.bound
    ?`<span class="pill ${res?.ok===false?'bad':'ok'}"><i></i>${res?esc(res.message):'已绑定'}</span> <button class="btn ghost" data-act="bind-check" data-id="${accId}" data-k="${plat}">检查</button><button class="btn ghost" data-act="bind-login" data-id="${accId}" data-k="${plat}">重新登录</button><button class="btn ghost danger" data-act="bind-off" data-id="${accId}" data-k="${plat}">解绑</button>`
    :`<span class="faint">未绑定</span> <button class="btn" data-act="bind-login" data-id="${accId}" data-k="${plat}">扫码绑定${esc(pn)}</button>${lg?.status==='failed'?` <span class="err">${esc(lg.message)}</span>`:''}`;
}
function pubActions(it,id){
  if(!it.video)return '';
  const g=it.publish?.gen;
  if(g?.status==='running')return '<button class="btn" disabled>生成中…</button>';
  if(it.video.watch?.status==='running')return '<button class="btn" disabled title="Claude 在看这条视频，看完才知道写什么">先等 Claude 看完视频…</button>';
  const missing=it.publish?.platforms?PUB_PLATFORMS.filter(p=>p.ready&&!it.publish.platforms[p.k]):[];
  return `${missing.length?`<button class="btn primary" data-act="pub-fill" title="只给还没有文案的平台写，已经写好的不动">补写${missing.map(p=>p.n).join('、')}文案</button>`:''}<button class="btn ${it.publish?.platforms?'':'primary'}" data-act="pub-gen">${it.publish?.platforms?'重新生成发布信息':'生成发布信息'}</button>`;
}
// 发布信息的修改：停顿 600ms 存一次；点发布前立刻存
let pubTimer=null,pubPending={};
function queuePub(plat,f,val){
  pubPending[plat]={...(pubPending[plat]||{}),[f]:f==='tags'?val.split(/[\s,，#]+/).map(x=>x.trim()).filter(Boolean):val};
  clearTimeout(pubTimer);pubTimer=setTimeout(flushPub,600);
}
function flushPub(){
  clearTimeout(pubTimer);const id=S.open;if(!id||!Object.keys(pubPending).length)return;
  const patchObj={publish:{platforms:pubPending}};pubPending={};store.update('items',id,patchObj);
}
// 手动发布助手：按发布顺序列好每一步，要复制的都有按钮
function vManualCard(it,p,r){
  const n=PUB_PLATFORMS.find(x=>x.k===p)?.n||p;const v=it.publish?.platforms?.[p]||{};const tags=v.tags||[];
  const tagText=p==='bilibili'||p==='youtube'?tags.join('，'):tags.map(t=>'#'+String(t).replace(/^#/,'')).join(' ');
  const row=(label,body,actions)=>`<li><span class="ms-label">${label}</span><span class="ms-body">${body}</span><span class="ms-act">${actions}</span></li>`;
  const copy=(text,what)=>text?`<button class="btn sm" data-act="copy" data-copy="${esc(text)}" data-what="${esc(what)}">复制</button>`:'';
  const coverRow=(file,label,note)=>row(label,`<span class="faint">${note}</span>`,`<button class="btn sm" data-act="reveal" data-file="${esc(file)}">在 Finder 里显示</button>${copy(file,'封面路径')}`);
  const steps=[
    row('1 打开发布页',r.url?`<span class="faint">${esc(r.url.replace(/^https?:\/\//,'').slice(0,46))}</span>`:'<span class="faint">在 App 里发也行</span>',r.url?`<a class="btn sm" href="${esc(r.url)}" target="_blank" rel="noopener">打开</a>`:''),
    row('2 选视频',`<span class="faint">${esc(String(r.video||'').split('/').pop())}</span>`,`<button class="btn sm" data-act="reveal" data-file="${esc(r.video||'')}">在 Finder 里显示</button>${copy(r.video,'视频路径')}`),
    r.cover?coverRow(r.cover,r.cover2?'3 竖封面':'3 封面',/wide/.test(r.cover)?'横版 16:9':'竖版 3:4'):'',
    r.cover2?coverRow(r.cover2,'横封面','横版 4:3 · 在封面设置里切到横封面再传'):'',
    row('标题',esc(v.title||'—'),copy(v.title,'标题')),
    row(p==='bilibili'?'简介':'正文',`<span class="ms-clip">${esc(v.desc||'—')}</span>`,copy(v.desc,'正文')),
    tags.length?row(p==='bilibili'?'标签':'话题',esc(tagText),copy(tagText,'话题')+(p==='bilibili'?'<span class="faint ms-tip">一个个粘贴后按回车</span>':'')):'',
    r.collection?row('合集',`选「${esc(r.collection)}」`,''):'',
  ].filter(Boolean).join('');
  return `<div class="manual-card"><div class="manual-hd"><span class="pill warn"><i></i>${esc(n)} · 等你手动发布</span><span class="faint">${fmtTime(r.at)}</span></div>
    <ol class="manual-steps">${steps}</ol>
    <div class="manual-foot"><button class="btn primary" data-act="manual-done" data-k="${p}">我已发布</button><button class="btn ghost" data-act="manual-cancel" data-k="${p}">这次不发了</button></div></div>`;
}
function vPubStatus(it){
  const g=it.publish?.gen;
  if(g?.status==='running')return `<p class="hint busy">${esc(g.message||'生成中')}…</p>`;
  // 失败了：已经有标题文案的只重试封面，不重写文案；连文案都没有的整套重来
  if(g?.status==='failed')return `<p class="err">生成失败：${esc(g.message||'')} <button class="btn" data-act="${it.publish?.platforms?'pub-cover':'pub-gen'}">${it.publish?.platforms?'重试生成封面':'重试'}</button></p>`;
  const rs=it.publish?.results||{};
  return Object.entries(rs).filter(([,r])=>r.status!=='cancelled').map(([p,r])=>{
    const n=PUB_PLATFORMS.find(x=>x.k===p)?.n||p;
    if(r.status==='manual')return vManualCard(it,p,r);
    const cls={running:'warn',done:'ok',failed:'bad'}[r.status]||'';
    const label={running:'发布中',done:r.manual?'已发布（手动）':'已发布',failed:'发布失败'}[r.status]||r.status;
    return `<div class="pub-res"><span class="pill ${cls}"><i></i>${esc(n)} · ${label} · ${fmtTime(r.at)}</span>
      ${r.error?`<p class="err">${esc(r.error)}${r.screenshot?` · <a href="/api/publish/shots/${esc(r.screenshot.split('/').pop())}" target="_blank" rel="noopener">看出错时的截图</a>`:''}</p>`:''}
      ${(r.steps||[]).length?`<ol class="run-log" data-run="pub-${esc(p)}">${r.steps.map(x=>`<li class="k-tool"><time>${fmtOffset(x.at,r.steps[0].at)}</time><span class="kl">步骤</span><span class="tx">${esc(x.text)}</span></li>`).join('')}</ol>`:''}</div>`}).join('');
}
// 这个账号在这个平台是不是手动发布（勾一次就记在账号上）
const manualOf=(accId,k)=>!!S.accounts[accId]?.manualPublish?.[k];
const pubSelNote=(it,k)=>{const n=PUB_PLATFORMS.find(x=>x.k===k)?.n||k;
  return manualOf(it.accountId,k)?'<span class="pub-sel-note faint">你自己发，工作台只帮你准备好要复制的东西</span>'
    :S.pubAcc?.[it.accountId]?.[k]?.bound?'<span class="pub-sel-note faint">自动发 · 账号已绑定</span>'
    :`<span class="pub-sel-note err">自动发要先在「账号矩阵」绑定${n}，或者勾右边的「手动发」</span>`};
function vPublish(it,id){
  if(!it.video)return '<p class="hint">视频做好后在这里生成封面、标题和话题，确认后勾选平台发布。</p>';
  const pb=it.publish||{};
  if(!pb.platforms)return '<p class="hint">点「生成发布信息」：Claude 按脚本给每个平台写标题、描述和话题，再做封面（配了图片生成就用 AI 画，没配就从成片里截一帧）。都可以改。</p>';
  const sel=new Set(pb.selected||['douyin']);const bound=k=>S.pubAcc?.[it.accountId]?.[k]?.bound;
  const running=Object.values(pb.results||{}).some(r=>r.status==='running');
  const genBusy=pb.gen?.status==='running'; // 发布信息或封面还在生成，等它好了再发
  const ai=!!S.conf?.image?.configured;
  const coverBtns=`<button class="btn ghost" data-act="pub-cover" data-k="frame">截取</button><label class="cover-t">截取时间（秒）<input type="number" id="pubCoverTime" min="0" step="0.5" value="${esc(pb.coverTime??1)}"></label>${ai?'<button class="btn ghost" data-act="pub-cover" data-k="ai">AI 画一张</button>':''}`;
  const cover=pb.cover?`<figure class="pub-cover"><img src="/media/${esc(pb.cover)}" alt="竖版封面图"><span class="faint">竖版 3:4 · 抖音竖封面、小红书</span>${pb.coverWide?`<img class="wide" src="/media/${esc(pb.coverWide)}" alt="横版封面图"><span class="faint">横版 16:9 · B站，横屏视频的 YouTube</span>${pb.coverWide43?`<img class="wide43" src="/media/${esc(pb.coverWide43)}" alt="横版 4:3 封面图"><span class="faint">横版 4:3 · 抖音横封面</span>`:''}`:'<span class="err" style="font-size:12px">横版封面没生成出来，B站会用竖版裁剪</span>'}<figcaption>${coverBtns}</figcaption></figure>`:`<div class="pub-cover"><p class="hint">还没有封面图</p>${coverBtns}</div>`;
  const plats=PUB_PLATFORMS.map(p=>{const v=pb.platforms[p.k]||{};const lim=PUB_LIMITS[p.k]?.title;
    return `<div class="pub-plat ${p.ready?'':'off'}">
      <div class="pub-sel-row"><label class="pub-sel"><input type="checkbox" data-pubsel="${p.k}" ${sel.has(p.k)?'checked':''}> <b>${p.n}</b> ${pubSelNote(it,p.k)}</label>
        <label class="pub-manual" title="勾上后这个平台由你自己发：工作台把视频、封面、标题、正文、话题准备好，你复制粘贴就行；不会碰你在这个平台上的账号"><input type="checkbox" data-pubmanual="${p.k}" ${manualOf(it.accountId,p.k)?'checked':''}> 手动发</label></div>
      ${pb.platforms[p.k]?'':'<p class="hint">还没有文案，点上方「补写」生成，已经写好的平台不受影响</p>'}
      <div class="field"><label for="pub-${p.k}-title">标题${lim?` <span class="faint">（不超过 ${lim} 字，现在 ${String(v.title||'').length}）</span>`:''}</label><input type="text" id="pub-${p.k}-title" data-pub="${p.k}" data-f="title" value="${esc(v.title||'')}"></div>
      <div class="field"><label for="pub-${p.k}-desc">描述</label><textarea id="pub-${p.k}-desc" data-pub="${p.k}" data-f="desc" rows="${p.k==='xhs'?6:3}">${esc(v.desc||'')}</textarea></div>
      <div class="field"><label for="pub-${p.k}-tags">话题（空格分隔）</label><input type="text" id="pub-${p.k}-tags" data-pub="${p.k}" data-f="tags" value="${esc((v.tags||[]).join(' '))}"></div>
    </div>`}).join('');
  return `<div class="pub-grid">${cover}<div class="pub-forms">${plats}</div></div>
    ${ai?`<details class="pub-prompt"><summary>封面图提示词</summary><textarea id="pubCoverPrompt" rows="4">${esc(pb.coverPrompt||'')}</textarea><p class="hint">改完点上面的「AI 画一张」，按这段重新生成。</p></details>`:''}
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class="btn primary" data-act="pub-go" ${running||genBusy||!aiReady()?'disabled':''}>${running?'发布中…':genBusy?'封面生成中，稍等…':'发布到勾选的平台'}</button><span class="hint">发布时会弹出一个 Chrome 窗口自动操作，不用管它，做完会自己关掉。每一步进度和结果显示在下面，成功后卡片进入「已发布」。</span></div>`;
}
const CHECK_NAMES={notMisleading:'不误导',noRealPerson:'不伪造真人',hook:'钩子',emotion:'情绪',anxiety:'不贩卖焦虑'};
const precheckHtml=p=>!p?'':(p.items||[]).map(x=>`<div><span class="${x.pass?'p':'f'}">${x.pass?'通过':'注意'}</span><span><b>${esc(CHECK_NAMES[x.key]||x.key)}</b> ${esc(x.note)}</span></div>`).join('')+(p.advice?`<div><span class="faint" style="flex:none">建议</span><span>${esc(p.advice)}</span></div>`:'')+(p.at?`<div class="faint" style="font-size:11.5px">预审于 ${fmtTime(p.at)}</div>`:'');
async function agentRun(task,args={}){
  try{await api('POST','/api/agent/run',{task,...args});toast(task==='curate'?'Claude 开始精选，一般要几分钟':'Claude 开始出题')}
  catch(e){toast(e.message||'启动失败')}
}
// Claude 的汇报是 Markdown，只处理加粗和链接，其余按纯文本显示
const mdLite=t=>esc(t).replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>').replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,(m,a,u)=>`<a href="${u}" target="_blank" rel="noopener">${a}</a>`);
// claude-opus-5-5 → Opus 5.5
const modelName=m=>String(m).split('、').map(x=>x.replace(/^claude-/,'').replace(/-(\d+)(?:-(\d+))?(?:-\d{8})?$/,(_,a,b)=>' '+a+(b?'.'+b:'')).replace(/^\w/,c=>c.toUpperCase())).join('、');
function vRun(run){
  if(!run)return '';
  const st={running:['warn','运行中'],done:['ok','完成'],failed:['bad','失败'],stopped:['','已停止']}[run.status]||['',run.status];
  const running=run.status==='running';const open=S.runOpen===run.id;
  // 最后一段文字就是汇报，下面单独显示，步骤里不再重复
  const steps=(run.steps||[]).filter(x=>!(x.kind==='text'&&run.result&&run.result.startsWith(x.text.slice(0,40))));
  const shown=running?steps.slice(-6):open?steps:[];
  return `<div class="panel run">
    <div class="run-head"><span class="pill ${st[0]}"><i></i>Claude ${esc(run.name)} · ${st[1]}</span>
      <span class="faint num">${fmtTime(run.startedAt)} · ${vDur(run)}${run.turns?' · '+run.turns+' 轮':''}${run.model?' · '+esc(modelName(run.model)):''}${(()=>{const other=(run.modelsUsed||[]).filter(m=>m!==run.model&&!/haiku/.test(m));return other.length?` · <span style="color:var(--warn)">中途换成 ${esc(modelName(other.join('、')))}</span>`:''})()}</span>
      <button class="btn ghost" data-act="run-view" data-id="${esc(run.id)}">全屏查看</button>${running?`<button class="btn" data-act="agent-stop" data-id="${esc(run.id)}">停止</button>`:`${(run.status==='failed'||run.status==='stopped')&&run.sessionId&&!runningRun(run.task==='video'?'video':undefined)?`<button class="btn" data-act="agent-resume" data-id="${esc(run.id)}">从中断处继续</button>`:''}<button class="btn ghost" data-act="run-toggle" data-id="${esc(run.id)}">${open?'收起':'展开过程和说明'}</button>`}</div>
    ${run.error?`<p class="err">${esc(run.error)}</p>`:''}
    ${vSay(run)}
    ${running||open?vLog(run):''}
    ${run.result&&!running?`<div class="run-result ${open?'':'clamp'}">${mdLite(run.result)}</div>`:''}
    ${open&&run.sessionId?`<p class="hint">想追问 Claude 这次为什么这么做：在项目目录运行 <code>claude --resume ${esc(run.sessionId)}</code></p>`:''}
  </div>`;
}
function vPick(p){
  const open=S.pickOpen===p.id;const busy=!!runningRun();
  const srcs=(p.sources||[]).map(s=>{const u=safeUrl(s.url);const t=`<span class="src-ch">${esc(CH_NAMES[s.channel]||s.channel)}</span>${esc(s.title)}`;
    return u?`<a class="pick-src" href="${esc(u)}" target="_blank" rel="noopener">${t}</a>`:`<span class="pick-src">${t}</span>`}).join('');
  const ideaN=(S.radar?.ideas||[]).filter(d=>d.pickId===p.id).length;
  const form=`<div class="pick-form"><span class="lbl">给哪些账号出题</span>
      <div class="chips">${accList().map(a=>`<button class="chip c-${esc(a.color)}" aria-pressed="${S.pickAcc.has(a.code)}" data-act="pick-acc" data-k="${esc(a.code)}">${esc(a.code)} · ${esc(a.name)}</button>`).join('')}</div>
      <label class="lbl" for="pickN">每个账号出几个</label><select id="pickN">${[1,2,3,5].map(n=>`<option value="${n}" ${S.pickN===n?'selected':''}>${n} 个</option>`).join('')}</select>
      <div class="idea-actions"><button class="btn primary" data-act="pick-go" data-id="${esc(p.id)}" ${busy||!S.pickAcc.size?'disabled':''}>开始出题</button><button class="btn ghost" data-act="pick-cancel">取消</button></div></div>`;
  const actions=open?form
    :p.status==='new'?`<div class="idea-actions"><button class="btn primary" data-act="pick-open" data-id="${esc(p.id)}" ${busy?'disabled':''}>给账号出题</button><button class="btn ghost" data-act="pick-status" data-id="${esc(p.id)}" data-k="dropped">不做</button></div>`
    :p.status==='ideas'?`<div class="idea-actions"><button class="btn" data-act="tab" data-k="ideas">看选题${ideaN?`（${ideaN} 个待挑）`:''}</button><button class="btn ghost" data-act="pick-open" data-id="${esc(p.id)}" ${busy?'disabled':''}>再出一轮</button></div>`
    :`<div class="idea-actions"><button class="btn ghost" data-act="pick-status" data-id="${esc(p.id)}" data-k="new">恢复</button></div>`;
  return `<article class="panel idea pick">
    <div class="pick-head"><h3>${esc(p.title)}</h3>${p.by==='manual'?'<span class="emo">手动送入</span>':''}<span class="faint num">${fmtTime(p.createdAt)}</span></div>
    ${p.why?`<p class="why">${esc(p.why)}</p>`:''}
    ${p.angle?`<div class="hook"><b>切入</b>${esc(p.angle)}</div>`:''}
    ${srcs?`<div class="pick-srcs">${srcs}</div>`:''}
    ${(p.accounts||[]).length?`<div class="chips"><span class="faint" style="font-size:12px">适合</span>${p.accounts.map(accTag).join('')}</div>`:''}
    ${p.risk?`<div class="risk">${esc(p.risk)}</div>`:''}
    ${actions}
  </article>`;
}
function vRadar(){
  const run=runningRun('curate')||lastRun('curate');const busy=runningRun();
  const picks=pickList();const by=s=>picks.filter(p=>p.status===s);const todo=by('new'),done=by('ideas'),dropped=by('dropped');
  return `<div class="section-head"><h2>选题雷达</h2><p>Claude 读这一轮各渠道的素材，挑出值得做的主题；你决定给哪些账号出题，或者不做</p>
      <div class="actions"><button class="btn primary" data-act="curate" ${busy?'disabled':''}>${runningRun('curate')?'Claude 精选中…':busy?'Claude 正在跑别的任务':'让 Claude 精选'}</button></div></div>
    ${vRun(run)}
    <div class="section-head sub"><h3>待决定</h3><p>${todo.length} 个</p></div>
    <div class="pick-list">${todo.map(vPick).join('')||'<div class="empty"><strong>没有待决定的主题</strong>点「让 Claude 精选」，或者在「素材」里把单条素材送进来</div>'}</div>
    ${done.length?`<div class="section-head sub"><h3>已出题</h3><p>${done.length} 个，选题在「账号选题」里</p></div><div class="pick-list">${done.map(vPick).join('')}</div>`:''}
    ${dropped.length?`<div class="section-head sub"><h3>不做的</h3><p>${dropped.length} 个</p><div class="actions"><button class="btn ghost" data-act="toggle-dropped">${S.showDropped?'收起':'查看'}</button></div></div>${S.showDropped?`<div class="pick-list">${dropped.map(vPick).join('')}</div>`:''}`:''}`;
}
// 内容或选题所属系列的名字
const seriesNameOf=(accId,sid)=>{const x=(S.accounts[accId]?.series||[]).find(v=>v.id===sid);return x?bareName(x.name):''};
const seriesTag=(accId,sid)=>{const n=seriesNameOf(accId,sid);return n?`<span class="emo series-tag">《${esc(n)}》</span>`:''};
function ideaCard(d){
  const tot=SCORE_KEYS.reduce((s,k)=>s+(Number(d.scores?.[k.k])||0),0);const pick=d.pickId&&S.picks?.[d.pickId];
  return `<article class="panel idea">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${accTag(d.accountId)}${seriesTag(d.accountId,d.seriesId)}${d.format?`<span class="emo">${esc(d.format)}</span>`:''}</div>
    <h3>${esc(d.title)}</h3>
    ${pick?`<div class="trend"><span class="label">精选</span>${esc(pick.title)}</div>`:d.trend?`<div class="trend"><span class="label">借势</span>${esc(d.trend.title)}<span class="faint"> · ${esc(d.trend.platforms)}</span></div>`:''}
    ${d.whyNow?`<p class="why">${esc(d.whyNow)}</p>`:''}
    ${d.hook?`<div class="hook"><b>前 3 秒</b>${esc(d.hook)}</div>`:''}
    ${d.angle?`<p>${esc(d.angle)}</p>`:''}
    <div class="score"><span class="total">${tot}/20</span><div class="bars">${SCORE_KEYS.map(k=>{const v=Math.max(0,Math.min(5,Number(d.scores?.[k.k])||0));return `<span class="bar">${k.n}<span>${[1,2,3,4,5].map(i=>`<i class="${i<=v?'on':''}"></i>`).join('')}</span></span>`}).join('')}</div></div>
    ${(d.emotions||[]).length?`<div class="chips">${d.emotions.map(e=>`<span class="emo">${esc(e)}</span>`).join('')}</div>`:''}
    ${d.risk?`<div class="risk">${esc(d.risk)}</div>`:''}
    <div class="idea-actions"><button class="btn primary" data-act="idea-add" data-id="${esc(d.id)}">加入流水线</button><button class="btn ghost" data-act="idea-drop" data-id="${esc(d.id)}">丢掉</button></div>
  </article>`;
}
function vIdeas(){
  const accs=accList();const all=S.radar?.ideas||[];const ideas=all.filter(d=>S.ideaFilter==='all'||d.accountId===S.ideaFilter);
  const chips=`<button class="chip" aria-pressed="${S.ideaFilter==='all'}" data-act="idea-filter" data-id="all">全部 ${all.length}</button>`+accs.map(a=>`<button class="chip c-${esc(a.color)}" aria-pressed="${S.ideaFilter===a.id}" data-act="idea-filter" data-id="${esc(a.id)}">${esc(a.code)} · ${esc(a.name)} ${all.filter(d=>d.accountId===a.id).length}</button>`).join('');
  const run=runningRun('ideas')||lastRun('ideas');const fresh=run&&(run.status==='running'||Date.now()-(run.finishedAt||0)<6*36e5);
  return `<div class="section-head"><h2>账号选题</h2><p>Claude 按账号人设给精选主题出的选题。挑好的加入流水线，其余丢掉</p></div>
    <div class="chips" style="margin-bottom:12px">${chips}</div>
    ${fresh?vRun(run):''}
    <div class="idea-grid">${ideas.map(ideaCard).join('')||'<div class="empty"><strong>没有待挑的选题</strong>在「选题雷达」里给精选主题点「给账号出题」</div>'}</div>`;
}
// 热点数据服务：各榜单来源最近一次抓取的状态
async function loadHs(){try{S.hs={sources:await api('GET','/api/hs/sources')}}catch(e){S.hs={down:e.message||'热点数据服务没有响应'}}requestRender()}
function vDataService(){
  const h=S.hs;
  if(!h)return `<div class="panel grid" style="gap:8px"><div class="label">热点数据服务</div><p class="hint">检查中…</p></div>`;
  if(h.down)return `<div class="panel grid" style="gap:8px"><div class="label">热点数据服务</div><p class="hint" style="color:var(--bad)">${esc(h.down)}</p></div>`;
  const src=h.sources.map(s=>`<span class="src ${s.error?'bad':s.count?'ok':''}" title="${esc(s.error||'')}">${esc(s.name)}</span>`).join('');
  return `<div class="panel grid" style="gap:10px"><div class="blk-head"><div class="label">热点数据服务</div><div class="actions"><button class="btn ghost" data-act="tab" data-k="sources">管理</button></div></div>
    <div class="srcs">${src}</div></div>`;
}
/* ---------- 素材 ---------- */
const safeUrl=u=>/^https?:\/\//i.test(u||'')?u:'';
const ago=t=>{if(!t)return '';const m=Math.round((Date.now()-new Date(t))/60000);return m<60?`${Math.max(m,1)} 分钟前`:m<1440?`${Math.round(m/60)} 小时前`:`${Math.round(m/1440)} 天前`};
const mmss=s=>`${Math.floor(s/60)}:${pad(s%60)}`;
async function loadFeed(){
  if(S.feedLoading)return;S.feedLoading=true;
  try{const [channels,feed]=await Promise.all([api('GET','/api/hs/channels'),api('GET','/api/hs/feed?hours=24&limit=800')]);
    S.feed={channels,items:feed.items}}
  catch(e){S.feed={down:e.message||'热点数据服务没有响应'}}
  S.feedLoading=false;requestRender();
}
async function feedRun(id){
  S.feedRunning=id;render();
  try{const r=await api('POST','/api/hs/channels/'+encodeURIComponent(id)+'/run');toast(r.error?'抓取失败：'+r.error:`抓到 ${r.count} 条`)}
  catch(e){toast(e.message||'抓取失败')}
  S.feedRunning=null;await loadFeed();
}
// 榜单类渠道（抖音、微博、B站、知乎……）都是排好名的词条，用同一种紧凑列表
function vHotList(id,items,max){
  const c=chan(id);const last=items.reduce((m,x)=>x.lastSeen>m?x.lastSeen:m,'');
  const cur=items.filter(x=>x.lastSeen===last);
  const top=cur.filter(x=>!x.extra?.rising).sort((a,b)=>(a.metrics.rank||999)-(b.metrics.rank||999)),rising=cur.filter(x=>x.extra?.rising);
  const shown=max?top.slice(0,max):top;
  const sub=x=>{const e=x.extra||{};const bits=[];
    if(e.since){const ms=Date.now()-new Date(e.since);bits.push('上榜 '+(ms<36e5?Math.max(1,Math.round(ms/6e4))+' 分钟':Math.round(ms/36e5)+' 小时'))}
    if(e.maxRank&&e.maxRank<(x.metrics.rank||999))bits.push('最高第 '+e.maxRank);
    if(x.metrics.videos)bits.push(x.metrics.videos+' 个视频');
    if(e.category)bits.push(e.category);
    if(e.views!=null)bits.push('播放 '+fmtN(e.views)+(e.likes!=null?' · 赞 '+fmtN(e.likes):''));
    if(e.points!=null)bits.push(e.points+' 分 · '+(e.comments||0)+' 评论');
    return bits.length?`<small class="faint">${esc(bits.join(' · '))}</small>`:''};
  const row=x=>{const e=x.extra||{};const fresh=e.since?Date.now()-new Date(e.since)<3*36e5:x.isNew;
    return `<div class="dy-row"><span class="num rk">${x.metrics.rank??'↑'}</span>
      <span class="t">${safeUrl(x.url)?`<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>`:esc(x.title)}${fresh?'<i class="badge new">新</i>':''}${e.risk?`<i class="badge risk" title="${esc(e.risk.why)}">${e.risk.level==='avoid'?'避开':'注意'}</i>`:''}${sub(x)}</span>
      <span class="num faint">${x.metrics.hot&&e.views==null?fmtN(x.metrics.hot):''}</span>
      <button class="btn ghost" data-act="feed-pick" data-ch="${esc(id)}" data-id="${esc(x.id)}" data-title="${esc(x.title)}" data-url="${esc(safeUrl(x.url))}" title="送进选题雷达">送入</button></div>`};
  return `<div class="panel dy-list"><div class="blk-head"><h3>${esc(c?.name||CH_NAMES[id]||id)}</h3><span class="faint">${top.length} 条${last?' · '+esc(last.slice(11))+' 更新':''}</span>
      ${max&&top.length>max?`<div class="actions"><button class="btn ghost" data-act="feed-chan" data-k="${esc(id)}">看全部 ${top.length} 条</button></div>`:''}</div>
    ${shown.map(row).join('')||'<p class="hint">还没有数据</p>'}
    ${!max&&rising.length?`<div class="label" style="margin-top:10px">实时上升 <span class="faint" style="font-weight:400">还没进前 50，正在往上涨</span></div>${rising.map(row).join('')}`:''}</div>`;
}
function vFeed(){
  const f=S.feed;
  if(!f)return '<div class="empty">正在读取…</div>';
  if(f.down)return `<div class="empty"><strong>热点数据服务没有响应</strong>${esc(f.down)}</div>`;
  const ch=S.feedChan||'all';const names=Object.fromEntries(f.channels.map(c=>[c.id,c.name]));
  const by={};for(const x of f.items)(by[x.channel]??=[]).push(x);
  const lists=f.channels.map(c=>c.id);
  // 榜单只数当前还在榜上的条数
  const nowCount=id=>{const it=by[id]||[];const last=it.reduce((m,x)=>x.lastSeen>m?x.lastSeen:m,'');return it.filter(x=>x.lastSeen===last&&!x.extra?.rising).length};
  const chChips=[['all','全部'],...lists.map(id=>[id,`${names[id]} ${nowCount(id)}`])].map(([k,n])=>`<button class="chip" aria-pressed="${ch===k}" data-act="feed-chan" data-k="${esc(k)}">${esc(n)}</button>`).join('');
  const body=ch!=='all'?vHotList(ch,by[ch]||[]):
    `<div class="feed-grid">${lists.map(id=>vHotList(id,by[id]||[],10)).join('')}</div>`;
  return `<div class="section-head"><h2>素材</h2><p>各渠道定时抓到的原始内容。精选交给下一步的 Claude；看到想做的，也可以直接送进选题雷达</p></div>
    <div class="feed-filters"><div class="chips">${chChips}</div></div>
    ${body}`;
}
/* ---------- 渠道（第 1 步）：每个渠道单独配置 ---------- */
const INTERVALS=[10,15,30,60,120,180,240,360,720,1440];
const fmtMin=m=>m%60?m+' 分钟':m/60+' 小时';
const chan=id=>S.feed?.channels?.find(c=>c.id===id);
// 编辑中的配置草稿，保存或放弃前不被定时刷新覆盖
function draft(id){const c=chan(id);if(!c)return null;S.cfg??={};return S.cfg[id]??={everyMin:c.config.everyMin,settings:JSON.parse(JSON.stringify(c.config.settings)),dirty:false}}
function chanState(id){const c=chan(id);if(!c)return ['','—'];if(c.running||S.feedRunning===id)return ['warn','抓取中'];if(c.lastRun?.error)return ['bad','出错'];return c.lastRun?['ok','正常']:['','还没抓过']}
function vSources(){
  const sel=S.chanSel||'douyin';
  if(S.feed?.down)return `<div class="empty"><strong>热点数据服务没有响应</strong>${esc(S.feed.down)}</div>`;
  const tabs=[...(S.feed?.channels||[]).map(c=>({k:c.id,n:c.name})),{k:'xhs',n:'小红书'}];
  const nav=tabs.map(t=>{const [cls,label]=t.k==='xhs'?['','未接入']:chanState(t.k);
    return `<button class="chan-tab" role="tab" aria-selected="${sel===t.k}" data-act="chan-sel" data-k="${t.k}"><b>${t.n}</b><span class="pill ${cls}"><i></i>${label}</span></button>`}).join('');
  return `<div class="section-head"><h2>渠道</h2><p>每个渠道单独配置多久抓一次、抓什么，保存后下一轮抓取就生效</p></div>
    <div class="chan-layout"><nav class="chan-nav" role="tablist">${nav}</nav><div class="grid" style="min-width:0">${(({douyin:vChanDouyin,xhs:vChanXhs})[sel]||(()=>vChanList(sel)))()}</div></div>`;
}
function vChanStatus(id){
  const c=chan(id);if(!c)return '<div class="panel"><p class="hint">正在读取渠道状态…</p></div>';
  const r=c.lastRun;const running=c.running||S.feedRunning===id;const when=t=>esc((t||'').slice(5).replace('T',' '));
  return `<div class="panel"><div class="feed-chan"><span class="faint">每 ${fmtMin(c.everyMin)}</span>
    <span>${r?`上次 <span class="num">${when(r.startedAt)}</span> ${r.error?`<span class="err">失败：${esc(r.error)}</span>`:`抓到 <b class="num">${r.count??'—'}</b> 条`}`:'还没抓过'}</span>
    ${c.nextRun?`<span class="faint">下次 <span class="num">${when(c.nextRun)}</span></span>`:''}<span class="faint">累计 <span class="num">${c.total}</span> 条</span>
    <button class="btn" data-act="feed-run" data-id="${esc(id)}" ${running?'disabled':''}>${running?'抓取中…':'立即抓取'}</button></div></div>`;
}
function vCfgHead(id,title){
  const d=draft(id);
  return `<div class="blk-head"><h3>${title}</h3>${d.dirty?'<span class="pill warn"><i></i>有改动没保存</span>':''}
    <div class="actions">${chan(id).config.defaults&&Object.keys(chan(id).config.defaults).length?`<button class="btn ghost" data-act="cfg-reset" data-id="${id}">恢复默认</button>`:''}${d.dirty?`<button class="btn ghost" data-act="cfg-discard" data-id="${id}">放弃改动</button>`:''}<button class="btn primary" data-act="cfg-save" data-id="${id}" ${d.dirty&&!S.cfgSaving?'':'disabled'}>${S.cfgSaving?'保存中…':'保存'}</button></div></div>
    ${S.cfgMsg?.id===id?`<p class="hint" role="status" style="${S.cfgMsg.bad?'color:var(--bad)':''}">${esc(S.cfgMsg.text)}</p>`:''}`;
}
const intervalSelect=id=>{const c=chan(id),d=draft(id);return `<label class="cfg-field">多久抓一次<select data-cfg="${id}" data-f="everyMin">${INTERVALS.filter(m=>m>=c.config.minEveryMin).map(m=>`<option value="${m}" ${d.everyMin===m?'selected':''}>${fmtMin(m)}</option>`).join('')}</select></label>`};
async function cfgSave(id){
  const d=draft(id);S.cfgSaving=true;S.cfgMsg=null;render();
  try{const cfg=await api('PUT',`/api/hs/channels/${encodeURIComponent(id)}/config`,{everyMin:d.everyMin,settings:d.settings});
    S.cfg[id]=null;const c=chan(id);if(c){c.config=cfg;c.everyMin=cfg.everyMin}
    S.cfgMsg={id,text:'已保存，下一轮抓取起生效。想马上看效果可以点「立即抓取」'};loadFeed()}
  catch(e){S.cfgMsg={id,text:e.message||'保存失败',bad:true}}
  S.cfgSaving=false;render();
}
// API key：只在本机存，页面上只显示末 4 位
function vChanDouyin(){
  const c=chan('douyin');if(!c)return vChanStatus('douyin');
  return `${vChanStatus('douyin')}
    <div class="panel grid" style="gap:12px">${vCfgHead('douyin','抓取设置')}<div class="cfg-row">${intervalSelect('douyin')}</div></div>
    <div class="panel grid" style="gap:6px"><div class="label">抓的是什么</div><ul class="rules">
      <li>抖音网页版的热搜榜，50 条，加 5 条左右「实时上升」：还没进前 50、正在往上涨的词。不用登录，不占推特号池</li>
      <li>每个词有热度值、排名、开始上榜的时间、最高排名、相关视频数，链接是抖音的热点详情页</li>
      <li>热搜词下面每条视频的点赞、评论要请求签名才能拿，不做破解，所以没有</li>
      <li>灾难、时政、刑案等词条会自动标出风险</li></ul></div>`;
}
function vChanXhs(){
  return `<div class="panel grid" style="gap:10px"><div class="blk-head"><h3>小红书</h3><span class="pill"><i></i>未接入</span></div>
    <p>小红书没有公开的热榜。网页接口要登录，每个请求还要带它前端算出来的签名，不带直接拒绝；拿数据就得破解签名，等于绕过它的反爬保护，所以不做。</p>
    <p class="hint">现在的做法：Claude 精选时上网搜几次小红书趋势；你刷到值得做的，在「素材」页之外也可以直接把想法告诉 Claude。</p>
    <div class="label" style="margin-top:4px">要接入的话</div><ol class="rules">
      <li>第三方数据平台（千瓜、新红、灰豚等）的正式接口：有热门笔记、热搜词和互动数据，最稳定，要付费</li>
      <li>在 Claude 桌面端手动跑精选时，让 Claude 用你自己登录了小红书的 Chrome 看热点页：不用破解，但只能手动、低频</li></ol></div>`;
}
function vChanList(id){
  const c=chan(id);if(!c)return vChanStatus(id);
  return `${vChanStatus(id)}
    <div class="panel grid" style="gap:12px">${vCfgHead(id,'抓取设置')}<div class="cfg-row">${intervalSelect(id)}</div></div>
    <div class="panel grid" style="gap:6px"><div class="label">抓的是什么</div><ul class="rules">
      <li>${esc(c.description||c.name)}</li>
      <li>公开接口，不用登录；和国内热榜聚合共用缓存，同一来源 10 分钟内不重复请求</li>
      <li>Claude 精选时还会读跨平台聚合：同一件事在几个平台同时上榜，会合并打分</li>
      <li>灾难、时政、刑案等词条会自动标出风险</li></ul></div>`;
}
async function ideaAdd(iid){
  const ideas=S.radar?.ideas||[];const d=ideas.find(x=>x.id===iid);if(!d)return;
  const a=S.accounts[d.accountId];const id=uid();const now=Date.now();
  const oneSeries=(S.accounts[d.accountId]?.series||[]).filter(x=>x.active!==false);
  await store.set('items',id,{accountId:d.accountId,seriesId:d.seriesId||(oneSeries.length===1?oneSeries[0].id:null),title:d.title,hook:d.hook,angle:d.angle,emotions:d.emotions||[],format:d.format||'',
    platforms:a?.platforms||['douyin'],stage:'idea',script:'',notes:[d.pickId&&S.picks[d.pickId]?`来自精选：${S.picks[d.pickId].title}`:'',d.trend?`借势热点：${d.trend.title}（${d.trend.platforms}）`:'',d.whyNow?'为什么现在做：'+d.whyNow:'',d.risk?'风险备注（供参考）：'+d.risk:''].filter(Boolean).join('\n'),checks:{},metrics:{},scheduledAt:'',publishedAt:'',score:d.scores||{},source:'ai',createdAt:now,updatedAt:now});
  await store.set('radar','latest',{...S.radar,ideas:ideas.filter(x=>x.id!==iid)});
  toast('已加入流水线的「选题」列');
}
async function ideaDrop(iid){const ideas=S.radar?.ideas||[];await store.set('radar','latest',{...S.radar,ideas:ideas.filter(x=>x.id!==iid)})}

/* ---------- 流水线 ---------- */
function vPipeline(){
  const accs=accList(true);const sf=S.filter!=='all'?S.seriesFilter||'':'';
  const its=itemList().filter(i=>(S.filter==='all'||i.accountId===S.filter)&&(!sf||(sf==='none'?!i.seriesId:i.seriesId===sf))).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  const accSeries=S.filter!=='all'?(S.accounts[S.filter]?.series||[]):[];
  const sChips=accSeries.length?`<div class="chips" style="margin:-6px 0 14px"><button class="chip" aria-pressed="${!sf}" data-act="series-filter" data-id="">全部系列</button>${accSeries.map(x=>`<button class="chip" aria-pressed="${sf===x.id}" data-act="series-filter" data-id="${esc(x.id)}">《${esc(bareName(x.name))}》</button>`).join('')}<button class="chip" aria-pressed="${sf==='none'}" data-act="series-filter" data-id="none">没选系列</button></div>`:'';
  const chips=`<button class="chip" aria-pressed="${S.filter==='all'}" data-act="filter" data-id="all">全部账号</button>`+accs.map(a=>`<button class="chip c-${esc(a.color)}" aria-pressed="${S.filter===a.id}" data-act="filter" data-id="${a.id}">${esc(a.code)} · ${esc(a.name)}</button>`).join('');
  const cols=STAGES.map(s=>{const list=its.filter(i=>(i.stage||'idea')===s.k);
    return `<section class="col" id="col-${s.k}"><div class="col-head"><i class="sd s-${s.k}"></i>${s.n}<span class="n">${list.length}</span>${s.k==='idea'?'<button class="btn" data-act="new-item">新建</button>':''}</div>
    ${list.map(i=>{const c=checksDone(i);return `<button class="card" data-act="open" data-id="${i.id}">${accTag(i.accountId)}${seriesTag(i.accountId,i.seriesId)}<span class="t">${esc(i.title)}</span>
      <span class="m">${(()=>{const vr=itemRun('video',i.id);return vr?.status==='running'?'<span class="emo by">视频生成中</span>':vr?.status==='failed'&&!i.video?'<span class="emo bad">视频生成失败</span>':i.video?'<span class="emo">有成片</span>':''})()}${(()=>{const rs=Object.entries(i.publish?.results||{});const r=rs.find(([,x])=>x.status==='running')||rs.find(([,x])=>x.status==='failed');if(!r||i.stage==='published')return '';const n=PUB_PLATFORMS.find(x=>x.k===r[0])?.n||r[0];return r[1].status==='running'?`<span class="emo by">${esc(n)}发布中</span>`:`<span class="emo bad">${esc(n)}发布失败</span>`})()}${(i.emotions||[]).slice(0,2).map(e=>`<span class="emo">${esc(e)}</span>`).join('')}
      ${i.scheduledAt&&i.stage!=='published'?`<span class="num">${fmtSched(i.scheduledAt)}</span>`:''}
      ${i.stage==='published'?`<span class="num">播放 ${fmtN(views(i))}</span>`:''}</span></button>`}).join('')}
    </section>`}).join('');
  return `<div class="section-head"><h2>内容流水线</h2><p>点卡片打开详情：写脚本、审核、排期、填数据</p></div>
    <div class="chips" style="margin-bottom:14px">${chips}</div>${sChips}
    <div class="board">${cols}</div>`;
}
async function newItem(){
  const accs=accList();if(!accs.length){toast('先添加一个账号');return}
  const a=S.filter!=='all'&&S.accounts[S.filter]?{id:S.filter,...S.accounts[S.filter]}:accs[0];
  const id=uid();const now=Date.now();
  const ser=(a.series||[]).filter(x=>x.active!==false);const sid=S.filter===a.id&&S.seriesFilter&&S.seriesFilter!=='none'?S.seriesFilter:(ser.length===1?ser[0].id:null);
  await store.set('items',id,{accountId:a.id,seriesId:sid,title:'新选题',hook:'',angle:'',emotions:[],format:'',platforms:a.platforms||['douyin'],stage:'idea',script:'',notes:'',checks:{},metrics:{},scheduledAt:'',publishedAt:'',score:{},source:'manual',createdAt:now,updatedAt:now});
  openItem(id);
}

/* ---------- 日历 ---------- */
function vCalendar(){
  const its=itemList();const base=new Date();base.setHours(0,0,0,0);const t=today();
  const days=[];for(let i=-3;i<14;i++){const d=new Date(base);d.setDate(d.getDate()+i);days.push(d)}
  const rows=days.map(d=>{const k=ymd(d);
    const list=its.filter(i=>(i.stage==='scheduled'&&i.scheduledAt&&i.scheduledAt.slice(0,10)===k)||(i.stage==='published'&&(i.publishedAt||'').slice(0,10)===k)).sort((a,b)=>String(a.scheduledAt).localeCompare(String(b.scheduledAt)));
    return `<div class="day ${k===t?'today':''}"><div class="d">${k===t?'今天':'周'+WEEK[d.getDay()]}<small>${d.getMonth()+1}/${d.getDate()}</small></div>
      <div class="items">${list.length?list.map(i=>`<button class="slot" data-act="open" data-id="${i.id}"><time>${i.stage==='published'?'已发':esc((i.scheduledAt||'').slice(11,16))}</time><i class="sd s-${i.stage}"></i>${accTag(i.accountId)}<span class="t">${esc(i.title)}</span></button>`).join(''):'<span class="faint" style="font-size:12.5px">空</span>'}</div></div>`}).join('');
  const unsched=its.filter(i=>i.stage==='scheduled'&&!i.scheduledAt);
  return `<div class="home-grid">
    <div><div class="section-head"><h2>发布日历</h2><p>前 3 天到后 14 天。排期在内容详情里设置</p></div><div class="panel cal">${rows}</div></div>
    <aside class="grid"><div class="section-head"><h2>还没排期</h2></div><div class="panel">${unsched.length?`<div class="list">${unsched.map(i=>`<button class="row" data-act="open" data-id="${i.id}"><i class="sd s-${i.stage}"></i>${accTag(i.accountId)}<span class="t">${esc(i.title)}</span></button>`).join('')}</div>`:'<div class="empty">没有待排期的内容</div>'}</div>
    <p class="hint">建议每个账号每天固定时段发一条。到点后在各平台创作者中心用官方定时发布，发完把卡片拖到「已发布」并填数据。</p></aside>
  </div>`;
}

/* ---------- 账号矩阵 ---------- */
// 系列：账号只是频道，目标人群、主角和语气、配音、画面、结构都写在系列里
const SERIES_COLL=[{k:'douyin',n:'抖音合集'},{k:'bilibili',n:'B站合集'},{k:'xhs',n:'小红书合集'},{k:'youtube',n:'YouTube 播放列表'}];
const voiceLabel=id=>(S.voices?.voices||[]).find(x=>x.id===id)?.label||id;
const bareName=n=>String(n||'').replace(/[《》]/g,'');
function vSeriesCard(a,s){
  const n=itemList().filter(i=>i.accountId===a.id&&i.seriesId===s.id).length;
  const who=s.persona?((s.persona.match(/[“"「]([^”"」]{1,12})[”"」]/)||[])[1]||s.persona.split(/[：:，,。]/)[0]):'';
  const tags=[s.audience,who,s.length,s.voice&&voiceLabel(s.voice),...SERIES_COLL.filter(c=>s.collections?.[c.k]).map(c=>`${c.n.replace(/合集|播放列表/,'').trim()}合集「${s.collections[c.k]}」`)].filter(Boolean);
  return `<div class="series-card ${s.active===false?'off':''}" data-act="edit-series" data-id="${a.id}" data-k="${esc(s.id)}" role="button" tabindex="0" aria-label="编辑系列 ${esc(bareName(s.name))}">
    <div class="series-hd"><b>《${esc(bareName(s.name))}》</b>${s.active===false?'<span class="pill">已停用</span>':''}<button class="linkish" data-act="series-items" data-id="${a.id}" data-k="${esc(s.id)}" title="在流水线里只看这个系列">${n} 条内容</button></div>
    ${s.summary?`<p class="series-sum">${esc(s.summary)}</p>`:''}
    <div class="series-tags">${tags.map(t=>`<span title="${esc(t)}">${esc(t)}</span>`).join('')}</div>
  </div>`;
}
// 平台连接：一颗小标签，点开是 检查 / 重新登录 / 解绑；没连的点一下就去绑定
function vBindPill(accId,plat){
  const key=`${plat}:${accId}`;const pn=BIND_PLATS.find(x=>x.k===plat)?.n||plat;
  const st=S.pubAcc?.[accId]?.[plat];const lg=S.logins?.[key];const res=S.bindCheck?.[key];
  if(lg&&lg.status!=='done'&&lg.status!=='failed')return `<span class="bind-pill warn"><i class="dot"></i>${esc(pn)} · ${lg.status==='checking'?'确认中…':'等你扫码'}${lg.status==='waiting'?` <button class="btn primary sm" data-act="bind-done" data-id="${accId}" data-k="${plat}">我已登录</button>`:''}</span>`;
  if(!st)return `<span class="bind-pill"><i class="dot"></i>${esc(pn)}</span>`;
  if(!st.bound)return `<button class="bind-pill off" data-act="bind-login" data-id="${accId}" data-k="${plat}" title="${lg?.status==='failed'?esc(lg.message):'用这个平台的 App 扫码登录'}"><i class="dot"></i>${esc(pn)} · 绑定${lg?.status==='failed'?' <span class="err">（上次失败）</span>':''}</button>`;
  const bad=res?.ok===false;const open=S.bindMenu===key;
  return `<span class="bind-wrap"><button class="bind-pill ${bad?'bad':'ok'}" data-act="bind-menu" data-id="${esc(key)}" aria-expanded="${open}" title="${esc(res?.message||'已绑定')}"><i class="dot"></i>${esc(pn)}${bad?' · 登录失效':''} <span class="caret">▾</span></button>
    ${open?`<span class="bind-menu" role="menu"><button role="menuitem" data-act="bind-check" data-id="${accId}" data-k="${plat}">检查登录</button><button role="menuitem" data-act="bind-login" data-id="${accId}" data-k="${plat}">重新登录</button><button role="menuitem" class="danger" data-act="bind-off" data-id="${accId}" data-k="${plat}">解绑</button></span>`:''}</span>`;
}
function vAccounts(){
  const accs=accList(true);
  if(!accs.length)return `<div class="section-head"><h2>账号矩阵</h2></div><div class="empty"><strong>还没有账号</strong>先添加一个账号，再在它下面建系列。<div style="margin-top:10px"><button class="btn primary" data-act="edit-acc" data-id="">添加账号</button></div></div>`;
  const sel=accs.find(a=>a.id===S.accSel)||accs[0];
  const linked=a=>BIND_PLATS.filter(p=>S.pubAcc?.[a.id]?.[p.k]?.bound).length;
  const rows=accs.map(a=>`<button class="acc-row c-${esc(a.color)} ${a.id===sel.id?'on':''} ${a.active===false?'off':''}" data-act="acc-sel" data-id="${a.id}" data-search="${esc([a.code,a.name,a.brief,...(a.series||[]).map(x=>x.name)].join(' ').toLowerCase())}">
      <span class="acc-row-name"><i class="acc-dot"></i>${esc(a.code)} · ${esc(a.name)}${a.active===false?' <span class="faint">（暂停）</span>':''}</span>
      <span class="acc-row-meta">${(a.series||[]).length} 个系列 · ${linked(a)}/${BIND_PLATS.length} 平台已连</span></button>`).join('');
  const lgMsg=BIND_PLATS.map(p=>S.logins?.[`${p.k}:${sel.id}`]).find(l=>l&&l.status==='waiting');
  return `<div class="section-head"><h2>账号矩阵</h2><p>账号是频道；目标人群、主角、风格都写在系列里，写得越具体，AI 出的选题和脚本越像</p></div>
  <div class="acc-layout">
    <aside class="acc-side panel">
      <input type="search" id="accQ" placeholder="搜索账号或系列" value="${esc(S.accQ||'')}" aria-label="搜索账号">
      <div class="acc-rows">${rows}</div>
      <button class="btn ghost" data-act="edit-acc" data-id="">+ 添加账号</button>
    </aside>
    <section class="acc-main">
      <div class="acc-head">${accTag(sel.id)}${sel.active===false?'<span class="pill">已暂停</span>':''}<span class="faint">${sel.brief?`大方向：${esc(sel.brief)}`:'大方向：未填'}</span><button class="btn" data-act="edit-acc" data-id="${sel.id}">编辑账号</button></div>
      <div class="bind-strip">${BIND_PLATS.map(p=>vBindPill(sel.id,p.k)).join('')}</div>
      ${lgMsg?`<p class="hint">${esc(lgMsg.message||'')}</p>`:''}
      <div class="series-grid">${(sel.series||[]).map(x=>vSeriesCard(sel,x)).join('')}
        <button class="series-card new" data-act="edit-series" data-id="${sel.id}" data-k=""><span>+ 新系列</span><span class="faint">一句话让 Claude 写</span></button></div>
      <p class="hint" style="margin-top:14px">个人身份证原则上只能实名一个抖音号。要开更多号，用营业执照开企业蓝 V，不要借证或买号。</p>
    </section>
  </div>`;
}
function openAccModal(id){
  const a=id?S.accounts[id]:{code:'',name:'',brief:'',platforms:['douyin'],color:COLORS[accList(true).length%COLORS.length],active:true,series:[]};
  if(!a)return;
  const m=$('#modalRoot');
  m.innerHTML=`<div class="modal" data-act="modal-bg"><form class="modal-box" id="accForm" role="dialog" aria-label="账号设置">
    <h2 style="font-size:17px">${id?'编辑账号':'添加账号'}</h2>
    <div class="ai-fill"><label for="fBrief">让 Claude 帮你填</label>
      <div class="ai-row"><input type="text" id="fBrief" maxlength="300" placeholder="一句话写个方向，比如：什么 AI 都聊的科技号"><button type="button" class="btn" data-act="acc-ai">生成</button></div>
      <p class="hint" id="aiFillMsg">只填账号名称、大方向和平台。目标人群、主角、风格在保存后的「添加系列」里写</p></div>
    <div class="two"><div class="field"><label for="fCode">代号</label><input type="text" id="fCode" maxlength="3" value="${esc(a.code)}" placeholder="A" required></div>
      <div class="field"><label for="fName">名称</label><input type="text" id="fName" maxlength="20" value="${esc(a.name)}" placeholder="老T说AI" required></div></div>
    <div class="field"><label for="fAccBrief">大方向 <span class="faint">（可选，可以很宽泛；只在内容没选系列时兜底用）</span></label><input type="text" id="fAccBrief" maxlength="200" value="${esc(a.brief||'')}" placeholder="AI 相关的一切，拆真相也玩新东西"></div>
    <div class="field"><span class="lbl">平台</span><div class="chips">${PLATFORMS.map(p=>`<button type="button" class="chip" aria-pressed="${(a.platforms||[]).includes(p.k)}" data-act="toggle-chip" data-group="plat" data-v="${p.k}">${p.n}</button>`).join('')}</div></div>
    <div class="field"><span class="lbl">颜色</span><div class="swatches">${COLORS.map(c=>`<button type="button" class="sw c-${c}" aria-label="${c}" aria-pressed="${a.color===c}" data-act="toggle-chip" data-group="color" data-v="${c}"></button>`).join('')}</div></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="fActive" ${a.active!==false?'checked':''}> 正在运营（取消后不再出现在选题和总览里）</label>
    <div class="modal-foot">${id?`<button type="button" class="btn danger left" data-act="del-acc" data-id="${id}">删除账号</button>`:''}<button type="button" class="btn" data-act="modal-close">取消</button><button type="submit" class="btn primary">保存</button></div>
  </form></div>`;
  const f=$('#accForm');f.dataset.id=id||'';
  f.addEventListener('submit',async e=>{e.preventDefault();
    const pick=g=>[...f.querySelectorAll(`[data-group="${g}"][aria-pressed="true"]`)].map(b=>b.dataset.v);
    const base=id?S.accounts[id]:{series:[]};
    const data={...base,code:$('#fCode').value.trim().toUpperCase(),name:$('#fName').value.trim(),brief:$('#fAccBrief').value.trim(),platforms:pick('plat'),color:pick('color')[0]||'blue',active:$('#fActive').checked};
    if(!data.code||!data.name){toast('代号和名称必填');return}
    const aid=f.dataset.id||uid();data.order=id?(S.accounts[id].order??99):accList(true).length;
    await store.set('accounts',aid,data);m.innerHTML='';toast(id?'已保存':'已保存，接着点「添加系列」写目标人群、主角和风格');
  });
  setTimeout(()=>$('#fCode')?.focus(),30);
}
// 等后台 Agent 跑完，拿结构化结果
async function waitRun(runId,formEl,onTick){
  const started=Date.now();
  while(true){
    await new Promise(r=>setTimeout(r,1500));
    if(formEl&&!document.body.contains(formEl))return null; // 表单已经关掉
    const r=S.runs[runId];
    if(r&&r.status!=='running')return r;
    onTick?.(Math.round((Date.now()-started)/1000));
  }
}
async function accAiFill(btn){
  const f=$('#accForm');const brief=$('#fBrief').value.trim();const msg=$('#aiFillMsg');
  if(!brief){toast('先写一句方向');$('#fBrief').focus();return}
  let run;
  try{run=await api('POST','/api/agent/run',{task:'account',brief,editing:f.dataset.id||null})}
  catch(e){msg.textContent=e.message||'启动失败';msg.style.color='var(--bad)';return}
  btn.disabled=true;btn.textContent='生成中…';msg.style.color='';msg.textContent='Claude 正在写，一般要半分钟左右';
  const r=await waitRun(run.id,f,s=>{msg.textContent=`Claude 正在写，已经 ${s} 秒`});
  if(!r)return;
  btn.disabled=false;btn.textContent='重新生成';
  const a=r.structured;
  if(r.status!=='done'||!a){msg.textContent=r.error||'没有拿到结果，再试一次';msg.style.color='var(--bad)';return}
  if(!$('#fCode').value.trim())$('#fCode').value=String(a.code||'').slice(0,3).toUpperCase();
  $('#fName').value=a.name||'';$('#fAccBrief').value=a.brief||'';
  f.querySelectorAll('[data-group="plat"]').forEach(x=>x.setAttribute('aria-pressed',(a.platforms||[]).includes(x.dataset.v)));
  msg.textContent=`已填好，检查一下再保存。${a.reason?'和其他账号的区别：'+a.reason:''}`;
}
// ---------- 系列编辑：可以让 Claude 生成，也可以提意见让它接着改；保存时旧版本留一份，能退回 ----------
const SERIES_TEXT=[['sName','name'],['sSummary','summary'],['sAud','audience'],['sPersona','persona'],['sVisual','visual'],['sStructure','structure'],['sLength','length'],['sTopics','topics']];
function readSeriesForm(){
  const f=$('#seriesForm');const o={id:f.dataset.sid||''};
  for(const [el,k] of SERIES_TEXT)o[k]=$('#'+el).value.trim();
  o.voice=$('#fVoice').value||null;
  o.emotions=[...f.querySelectorAll('[data-group="semo"][aria-pressed="true"]')].map(b=>b.dataset.v);
  o.collections=Object.fromEntries(SERIES_COLL.map(c=>[c.k,$('#sColl-'+c.k).value.trim()]).filter(([,v])=>v));
  o.active=$('#sActive').checked;
  return o;
}
function fillSeriesForm(o){
  const f=$('#seriesForm');
  for(const [el,k] of SERIES_TEXT)if(o[k]!=null)$('#'+el).value=o[k];
  if(o.voice!==undefined){const sel=$('#fVoice');if(o.voice&&![...sel.options].some(x=>x.value===o.voice))sel.insertAdjacentHTML('beforeend',`<option value="${esc(o.voice)}">${esc(o.voice)}</option>`);sel.value=o.voice||''}
  if(o.emotions)f.querySelectorAll('[data-group="semo"]').forEach(x=>x.setAttribute('aria-pressed',o.emotions.includes(x.dataset.v)));
  if(o.collections)for(const c of SERIES_COLL)$('#sColl-'+c.k).value=o.collections[c.k]||'';
}
function openSeriesModal(accId,sid){ // 右侧滑出的面板
  const a=S.accounts[accId];if(!a)return;
  const cur=sid?(a.series||[]).find(x=>x.id===sid):null;
  const s=cur||{name:'',summary:'',audience:'',persona:'',voice:null,visual:'',emotions:[],structure:'',length:'',topics:'',collections:{},active:true};
  const hist=cur?.history||[];
  const m=$('#modalRoot');
  m.innerHTML=`<div class="side-wrap" data-act="modal-bg"><form class="side-panel" id="seriesForm" role="dialog" aria-label="系列设置">
    <div class="side-head"><h2>${cur?`《${esc(bareName(cur.name))}》`:'新系列'} <span class="faint">· ${esc(a.name)}</span></h2><button type="button" class="btn ghost" data-act="modal-close" aria-label="关闭">关闭</button></div>
    <div class="side-body">
      <aside class="side-ai">
        <div class="field"><label for="sBrief">一句话让 Claude 写</label>
          <textarea id="sBrief" rows="3" maxlength="300" placeholder="拆 AI 卖课话术，面向被割过韭菜的职场人，主角是毒舌的 AI 打假员"></textarea>
          <button type="button" class="btn" data-act="series-ai-new">${cur?'按这句重写':'生成'}</button></div>
        <div class="field"><label for="sFeedback">提意见，让 Claude 接着改</label>
          <textarea id="sFeedback" rows="3" maxlength="500" placeholder="语气再毒舌一点；人群收窄到 25–35 岁程序员；结构里加一段实测对比"></textarea>
          <button type="button" class="btn" data-act="series-ai-revise">按意见修改</button></div>
        <p class="hint" id="seriesMsg">Claude 只改你提到的地方，改完先填进右边给你看，满意了再保存。</p>
        ${hist.length?`<div class="side-hist"><span class="faint">保存过 ${hist.length} 个旧版本</span><button type="button" class="btn ghost" data-act="series-undo" title="${esc(fmtTime(hist[0].savedAt))} 保存前的那一版">退回上一版</button></div>`:''}
      </aside>
      <div class="side-fields">
        <div class="two"><div class="field"><label for="sName">系列名</label><input type="text" id="sName" maxlength="30" value="${esc(s.name)}" placeholder="老T说AI" required></div>
          <div class="field"><label for="sLength">时长</label><input type="text" id="sLength" maxlength="40" value="${esc(s.length)}" placeholder="45–60 秒"></div></div>
        <div class="field"><label for="sSummary">一句话定位</label><input type="text" id="sSummary" maxlength="200" value="${esc(s.summary)}" placeholder="每集拆一个 AI 神话"></div>
        <div class="field"><label for="sAud">目标人群</label><input type="text" id="sAud" maxlength="200" value="${esc(s.audience)}" placeholder="25–40 岁一二线城市职场人"></div>
        <div class="field"><label for="sPersona">主角和语气</label><textarea id="sPersona" rows="3" placeholder="固定角色的形象、性格、说话方式、口头禅">${esc(s.persona)}</textarea></div>
        <div class="field"><label for="fVoice">配音音色</label>
          <div class="say"><select id="fVoice"><option value="">不指定（生成视频时按主角挑一个）</option>${(S.voices?.voices||[]).map(v=>`<option value="${esc(v.id)}" ${s.voice===v.id?'selected':''}>${esc(v.label)}｜${esc(v.hint)}</option>`).join('')}${s.voice&&!(S.voices?.voices||[]).some(v=>v.id===s.voice)?`<option value="${esc(s.voice)}" selected>${esc(s.voice)}</option>`:''}</select>
          </div></div>
        <div class="field"><label for="sVisual">视觉风格</label><textarea id="sVisual" rows="2" placeholder="画面风格、色调、版式、常用素材">${esc(s.visual)}</textarea></div>
        <div class="field"><span class="lbl">主打情绪</span><div class="chips">${EMOTIONS.map(e=>`<button type="button" class="chip" aria-pressed="${(s.emotions||[]).includes(e)}" data-act="toggle-chip" data-group="semo" data-v="${e}">${e}</button>`).join('')}</div></div>
        <div class="field"><label for="sStructure">固定结构</label><textarea id="sStructure" rows="3" placeholder="开头怎么钩人 → 中间分几段 → 结尾怎么收">${esc(s.structure)}</textarea></div>
        <div class="field"><label for="sTopics">适合的题材</label><input type="text" id="sTopics" maxlength="300" value="${esc(s.topics)}" placeholder="AI 工具实测、AI 课程话术拆解"></div>
        <div class="field"><span class="lbl">各平台的合集 <span class="faint">（填合集名，发布时自动放进去；要先在平台上建好同名合集，目前抖音已接上）</span></span>
          <div class="coll-grid">${SERIES_COLL.map(c=>`<label class="coll"><span class="faint">${c.n}</span><input type="text" id="sColl-${c.k}" maxlength="40" value="${esc(s.collections?.[c.k]||'')}"></label>`).join('')}</div></div>
        <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="sActive" ${s.active!==false?'checked':''}> 在用（停用后出选题时不再用它）</label>
      </div>
    </div>
    <div class="side-foot">${cur?`<button type="button" class="btn danger left" data-act="del-series">删除系列</button>`:''}<button type="button" class="btn" data-act="modal-close">取消</button><button type="submit" class="btn primary">保存</button></div>
  </form></div>`;
  const f=$('#seriesForm');f.dataset.acc=accId;f.dataset.sid=cur?.id||'';
  f.addEventListener('submit',async e=>{e.preventDefault();
    const o=readSeriesForm();if(!o.name){toast('系列名必填');return}
    const acc=S.accounts[accId];const list=[...(acc.series||[])];
    const at=list.findIndex(x=>x.id===o.id&&o.id);
    if(at>=0){
      const old=list[at];const {history:h=[],...snap}=old;
      const changed=JSON.stringify({...snap,savedAt:undefined})!==JSON.stringify({...snap,...o,savedAt:undefined});
      list[at]={...old,...o,history:changed?[{...snap,savedAt:Date.now()},...h].slice(0,5):h};
    }else list.push({...o,id:'s'+uid(),history:[]});
    await store.set('accounts',accId,{...acc,series:list});m.innerHTML='';toast('系列已保存');
  });
  setTimeout(()=>$(cur?'#sFeedback':'#sBrief')?.focus(),30);
}
async function seriesAi(btn,mode){
  const f=$('#seriesForm');const msg=$('#seriesMsg');
  const brief=mode==='new'?$('#sBrief').value.trim():'';const feedback=mode==='revise'?$('#sFeedback').value.trim():'';
  if(mode==='new'&&!brief){toast('先写一句方向');$('#sBrief').focus();return}
  if(mode==='revise'&&!feedback){toast('先写要改哪里');$('#sFeedback').focus();return}
  const draftNow=readSeriesForm();
  if(mode==='revise'&&!draftNow.name&&!draftNow.persona&&!draftNow.audience){toast('还没有内容可改，先「生成」一版');return}
  let run;
  try{run=await api('POST','/api/agent/run',{task:'series',accountId:f.dataset.acc,brief,feedback,draft:mode==='revise'?draftNow:null})}
  catch(e){msg.textContent=e.message||'启动失败';msg.style.color='var(--bad)';return}
  const label=btn.textContent;btn.disabled=true;btn.textContent='写着呢…';msg.style.color='';msg.textContent='Claude 正在写，一般要半分钟左右';
  const r=await waitRun(run.id,f,s=>{msg.textContent=`Claude 正在写，已经 ${s} 秒`});
  if(!r)return;
  btn.disabled=false;btn.textContent=label;
  const o=r.structured;
  if(r.status!=='done'||!o){msg.textContent=r.error||'没有拿到结果，再试一次';msg.style.color='var(--bad)';return}
  fillSeriesForm(o);
  if(mode==='revise')$('#sFeedback').value='';
  msg.textContent=`${o.note?'Claude：'+o.note+' ':''}检查一下，满意了点保存；不满意就接着提意见。`;
}
/* ---------- 设置 ---------- */
async function loadModels(){try{S.modelCfg=await api('GET','/api/models')}catch(e){S.modelCfg={down:e.message||'读取失败'}}requestRender()}
async function setModel(key,model){
  // 只存改过的；改回默认就删掉，以后默认值调整了能跟着变
  const f=S.modelCfg.features.find(x=>x.key===key);const cur={...(local.settings.models||{})};
  if(model===f.default)delete cur[key];else cur[key]=model;
  await store.set('settings','models',cur);toast(`「${f.name}」改成 ${modelName(model)}，下次运行生效`);loadModels();
}
// 连接：Claude 长期令牌（可选）、图片生成（可选，OpenAI 兼容接口）。密钥只存在本机，页面只显示末 4 位
async function loadConf(){try{S.conf=await api('GET','/api/config')}catch{S.conf=null}requestRender()}
function vConnect(){
  const cf=S.conf;if(!cf)return '<div class="panel"><p class="hint">正在读取连接设置…</p></div>';
  const im=cf.image,cl=cf.claude;
  return `<div class="panel grid" style="gap:14px"><div class="blk-head"><h3>连接</h3>
      <label class="cfg-field" style="margin-left:auto;flex-direction:row;align-items:center;gap:8px">界面语言<select id="uiLang" class="no-tr"><option value="zh" ${window.UI_LANG!=='en'?'selected':''}>中文</option><option value="en" ${window.UI_LANG==='en'?'selected':''}>English</option></select></label></div>
    <div class="grid" style="gap:6px"><div class="label">Claude Code ${cl.tokenSet?`<span class="pill ok"><i></i>长期令牌 ····${esc(cl.tail)}</span>`:'<span class="pill"><i></i>用本机 claude 的登录</span>'}</div>
      <p class="hint">所有 AI 环节都通过本机的 Claude Code 跑，用你自己的 Claude 订阅。装好 Claude Code 并在终端登录过就能用；想更稳（不和终端、桌面端抢登录），在终端运行 <code>claude setup-token</code>，把生成的令牌粘贴到这里。</p>
      <div class="cfg-row"><input type="password" id="confClaude" autocomplete="off" spellcheck="false" placeholder="${cl.tokenSet?'粘贴新令牌可替换':'sk-ant-oat…（可选）'}" aria-label="Claude 长期令牌" style="flex:1;min-width:14em">
        <button class="btn" data-act="conf-claude-save">保存令牌</button>${cl.tokenSet?'<button class="btn ghost danger" data-act="conf-claude-del">删除</button>':''}</div></div>
    <div class="grid" style="gap:6px"><div class="label">图片生成（可选） ${im.configured?`<span class="pill ok"><i></i>已配置 ····${esc(im.tail)}</span>`:'<span class="pill"><i></i>未配置：封面从成片里截一帧</span>'}</div>
      <p class="hint">配了就让 AI 画封面。填 OpenAI 的 key，或者任何兼容 OpenAI 图片接口（/images/generations）的地址和 key。</p>
      <div class="cfg-row"><label class="cfg-field">接口地址<input type="text" id="confImgUrl" value="${esc(im.baseUrl)}" spellcheck="false" style="min-width:18em"></label>
        <label class="cfg-field">模型<input type="text" id="confImgModel" value="${esc(im.model)}" spellcheck="false" style="width:12em"></label></div>
      <div class="cfg-row"><input type="password" id="confImgKey" autocomplete="off" spellcheck="false" placeholder="${im.configured?'不改 key 就留空':'sk-…'}" aria-label="图片接口的 key" style="flex:1;min-width:14em">
        <button class="btn" data-act="conf-image-save">保存</button>${im.configured?'<button class="btn ghost danger" data-act="conf-image-del">删除</button>':''}</div></div>
  </div>`;
}
/* ---------- 技能：每个环节的岗位说明，是你的本地数据 ---------- */
async function loadSkills(){
  try{S.skills=await api('GET','/api/skills');if(!S.skillSel&&S.skills.length)S.skillSel=S.skills[0].name;if(S.skillSel)await loadSkill(S.skillSel)}
  catch(e){S.skills={down:e.message||'读取失败'}}
  requestRender();
}
async function loadSkill(name){try{S.skillCur=await api('GET','/api/skills/'+encodeURIComponent(name))}catch(e){S.skillCur={err:e.message||'读取失败'}}requestRender()}
const skillPill=x=>x.origin==='custom'?'<span class="pill"><i></i>自己加的</span>':x.update?'<span class="pill warn"><i></i>出厂说明有更新</span>':x.modified?'<span class="pill ok"><i></i>改过</span>':'<span class="pill"><i></i>出厂</span>';
function vSkills(){
  const L=S.skills;
  if(!L)return '<div class="empty">正在读取…</div>';
  if(L.down)return `<div class="empty"><strong>读取技能失败</strong>${esc(L.down)}</div>`;
  const cur=S.skillCur&&S.skillCur.name===S.skillSel?S.skillCur:null;
  const nav=L.map(x=>`<button class="chan-tab" role="tab" aria-selected="${S.skillSel===x.name}" data-act="skill-sel" data-k="${esc(x.name)}"><b class="no-tr">${esc(x.name)}</b>${skillPill(x)}</button>`).join('');
  const text=cur?(S.skillDraft?.[cur.name]??cur.content):'';
  const dirty=cur&&S.skillDraft?.[cur.name]!=null&&S.skillDraft[cur.name]!==cur.content;
  const upd=cur?.update?`<div class="panel grid" style="gap:8px;border-color:var(--warn)"><div class="label">出厂说明有新版本</div>
      <p class="hint">这个技能你改过，所以没有自动更新。可以让 Claude 把新版的改进合进你的版本（结果会先填进下面给你看），也可以直接用新版覆盖，或者保留你的版本。</p>
      <div class="actions"><button class="btn primary" data-act="skill-merge" ${S.skillBusy?'disabled':''}>${S.skillBusy==='merge'?'Claude 合并中…':'让 Claude 合并'}</button>
        <button class="btn ghost" data-act="skill-take-new">用新版覆盖</button><button class="btn ghost" data-act="skill-keep">保留我的版本</button></div>
      <details><summary class="faint">看新的出厂版本</summary><pre class="skill-pre no-tr">${esc(cur.defaultContent||'')}</pre></details></div>`:'';
  const merged=S.skillMerged&&cur&&S.skillMerged.name===cur.name?`<div class="panel" style="border-color:var(--ok)"><p class="hint">下面是 Claude 合并后的版本，检查一下，满意了点「采用合并结果」。</p><div class="actions"><button class="btn primary" data-act="skill-accept-merged">采用合并结果</button><button class="btn ghost" data-act="skill-merge-cancel">放弃</button></div></div>`:'';
  const hist=cur?.history?.length?`<details class="vhist"><summary>历史版本（${cur.history.length}）</summary>${cur.history.map(at=>`<div class="row-s"><span class="num faint">${esc(fmtTime(at))}</span><button class="btn ghost" data-act="skill-hist" data-k="${at}">载入这一版</button></div>`).join('')}</details>`:'';
  const editor=!cur?'<div class="panel"><p class="hint">正在读取…</p></div>':cur.err?`<div class="panel"><p class="err">${esc(cur.err)}</p></div>`:`
    ${upd}${merged}
    <div class="panel grid" style="gap:10px">
      <div class="blk-head"><h3 class="no-tr">${esc(cur.name)}</h3>${skillPill(cur)}${dirty?'<span class="pill warn"><i></i>有改动没保存</span>':''}
        <div class="actions">${cur.origin==='default'?'<button class="btn ghost" data-act="skill-reset">恢复出厂</button>':''}${dirty?'<button class="btn ghost" data-act="skill-discard">放弃改动</button>':''}<button class="btn primary" data-act="skill-save" ${dirty?'':'disabled'}>保存</button></div></div>
      <p class="hint">${esc(cur.description)}</p>
      <textarea id="skillText" class="skill-text no-tr" rows="28" spellcheck="false">${esc(text)}</textarea>
      ${cur.files.length>1?`<p class="hint">这个技能目录里还有：${cur.files.filter(f=>f!=='SKILL.md').map(f=>`<code class="no-tr">${esc(f)}</code>`).join('、')}（在 <code>.claude/skills/${esc(cur.name)}/</code> 里，可以用编辑器改）</p>`:''}
      ${hist}
    </div>`;
  return `<div class="section-head"><h2>技能</h2><p>每个环节怎么做，都写在这里的岗位说明里。改这里就是改流程，不用碰代码。这些是你的本地数据，不会提交到代码仓库；在 Claude Code 里直接跑这些技能，用的也是同一份。</p></div>
    <div class="chan-layout"><nav class="chan-nav" role="tablist">${nav}</nav><div class="grid" style="min-width:0">${editor}</div></div>`;
}
async function skillAction(k,b){
  const cur=S.skillCur;if(!cur)return;const name=cur.name;const url='/api/skills/'+encodeURIComponent(name);
  const done=async(msg)=>{if(S.skillDraft)delete S.skillDraft[name];S.skillMerged=null;toast(msg);await loadSkills()};
  try{
    if(k==='save'){await api('PUT',url,{content:S.skillDraft?.[name]??cur.content});await done('已保存，下次运行这个技能就用新的说明')}
    else if(k==='reset'){await api('POST',url+'/reset');await done('已恢复成出厂说明，原来的版本存进了历史')}
    else if(k==='take-new'){await api('POST',url+'/accept',{content:cur.defaultContent});await done('已换成新的出厂说明，原来的版本存进了历史')}
    else if(k==='keep'){await api('POST',url+'/accept',{content:cur.content});await done('保留了你的版本，这次出厂更新不再提示')}
    else if(k==='merge'){S.skillBusy='merge';render();const r=await api('POST',url+'/merge');S.skillDraft={...(S.skillDraft||{}),[name]:r.content};S.skillMerged={name};toast('合并好了，检查一下')}
    else if(k==='accept-merged'){await api('POST',url+'/accept',{content:S.skillDraft?.[name]??cur.content});await done('已采用合并结果')}
  }catch(e){toast(e.message||'操作失败')}
  S.skillBusy=null;render();
}
function vSettings(){
  const c=S.modelCfg;
  if(!c)return '<div class="empty">正在读取…</div>';
  if(c.down)return `<div class="empty"><strong>读取设置失败</strong>${esc(c.down)}</div>`;
  const rows=c.features.map(f=>`<tr><td><b>${esc(f.name)}</b><div class="faint" style="font-size:12px">${esc(f.where)}</div></td>
    <td>${f.modes?`<select data-mode="${esc(f.key)}" aria-label="${esc(f.name)}的调用方式">${f.modes.map(m=>`<option value="${m}" ${modeOf(f.key)===m?'selected':''}>${m==='agent'?'后台 Agent':'单次调用'}</option>`).join('')}</select>`:'<span class="pill ok"><i></i>后台 Agent</span>'}</td>
    <td><select data-model="${esc(f.key)}" aria-label="${esc(f.name)}用的模型">${c.models.map(m=>`<option value="${esc(m.id)}" ${f.model===m.id?'selected':''}>${esc(m.name)}</option>`).join('')}</select>
      ${f.lastUsed?`<div class="faint" style="font-size:11.5px;margin-top:3px">最近一次实际用的：${esc(modelName(f.lastUsed))}</div>`:''}</td>
    <td><select data-effort="${esc(f.key)}" aria-label="${esc(f.name)}的思考强度">${(c.efforts||[]).map(e=>`<option value="${esc(e.id)}" ${f.effort===e.id?'selected':''}>${esc(e.name)}</option>`).join('')}</select></td></tr>`).join('');
  return `<div class="section-head"><h2>设置</h2><p>用到 Claude 的功能各自用什么模型、想得多深，改完下次运行就生效</p></div>
    ${vConnect()}
    <div class="home-grid" style="margin-top:16px">
      <div class="panel grid" style="gap:10px"><div class="blk-head"><h3>模型</h3></div>
        <div class="tbl-wrap"><table class="model-tbl"><thead><tr><th>功能</th><th>调用方式</th><th>模型</th><th>思考强度</th></tr></thead><tbody>${rows}</tbody></table></div>
        <p class="hint">每次运行实际用了哪个模型，会显示在选题雷达、账号选题的运行记录里</p></div>
      <aside class="grid">
        <div class="panel grid" style="gap:10px"><div class="label">怎么选</div>${c.models.map(m=>`<div><b>${esc(m.name)}</b><div class="faint" style="font-size:12.5px">${esc(m.note)}</div></div>`).join('')}
          <p class="hint">选的是系列，新版本发布后自动跟上：本机 Claude Code 自己解析成该系列最新的模型</p></div>
        <div class="panel grid" style="gap:10px"><div class="label">思考强度（effort）</div>${(c.efforts||[]).map(e=>`<div><b>${esc(e.name)}</b><div class="faint" style="font-size:12.5px">${esc(e.note)}</div></div>`).join('')}
          <p class="hint">每次运行都明确带上这里选的强度，不受本机 Claude Code 自己设置的影响</p></div>
        <div class="panel grid" style="gap:6px"><div class="label">两种调用方式</div><ul class="rules">
          <li>全部通过本机 Claude Code 调用，用你登录的订阅额度，不需要 API Key</li>
          <li>后台 Agent：能上网查背景、读工作台里的资料，结果自动存回，页面上能看到每一步；同一时间只跑一个任务，要排队</li>
          <li>单次调用：只根据卡片里的内容直接回答，不上网；更快，文字逐段出来，可以和后台 Agent 同时进行</li>
          <li>精选、出题、账号资料固定用后台 Agent；写脚本、AI 预审、AI 复盘可以在左边选</li>
          <li>登录用本机 claude 的登录状态，或上面「连接」里填的长期令牌</li></ul></div>
      </aside></div>`;
}

/* ---------- 数据复盘 ---------- */
function vData(){
  const accs=accList(true);const pub=itemList().filter(i=>i.stage==='published');
  const busy=S.gen&&S.gen.kind==='analysis';
  if(!pub.length)return `<div class="section-head"><h2>数据复盘</h2></div><div class="empty"><strong>还没有已发布的内容</strong>内容发布后，在详情里填上各平台的播放、点赞等数据，这里会自动汇总，也可以让 AI 帮你复盘。</div>`;
  const per=accs.map(a=>{const mine=pub.filter(i=>i.accountId===a.id);const v=mine.reduce((s,i)=>s+views(i),0);const inter=mine.reduce((s,i)=>s+msum(i,'likes')+msum(i,'comments')+msum(i,'shares'),0);
    return {a,n:mine.length,v,f:mine.reduce((s,i)=>s+msum(i,'follows'),0),rate:v?inter/v:0}}).filter(x=>x.n);
  const max=Math.max(1,...per.map(x=>x.v));
  const totalV=pub.reduce((s,i)=>s+views(i),0),totalF=pub.reduce((s,i)=>s+msum(i,'follows'),0);
  const best=[...pub].sort((a,b)=>views(b)-views(a));
  const rows=best.map(i=>{const v=views(i);const r=v?(msum(i,'likes')+msum(i,'comments')+msum(i,'shares'))/v:0;
    return `<tr data-act="open" data-id="${i.id}"><td class="num">${esc((i.publishedAt||'').slice(5,10))}</td><td>${accTag(i.accountId)}</td><td class="title">${esc(i.title)}</td>
    <td class="n">${fmtN(v)}</td><td class="n">${fmtN(msum(i,'likes'))}</td><td class="n">${fmtN(msum(i,'comments'))}</td><td class="n">${fmtN(msum(i,'shares'))}</td><td class="n">${fmtN(msum(i,'follows'))}</td><td class="n">${(r*100).toFixed(1)}%</td></tr>`}).join('');
  const an=S.analysis;
  return `<div class="section-head"><h2>数据复盘</h2><p>已发布 ${pub.length} 条，数据来自你在详情里填写的数字</p></div>
  <div class="kpis" style="margin-bottom:16px">
    <div class="panel kpi"><span class="label">总播放</span><span class="v">${fmtN(totalV)}</span><span class="sub">平均每条 ${fmtN(Math.round(totalV/pub.length))}</span></div>
    <div class="panel kpi"><span class="label">总涨粉</span><span class="v">${fmtN(totalF)}</span><span class="sub">每万播放涨粉 ${totalV?(totalF/totalV*1e4).toFixed(1):'0'}</span></div>
    <div class="panel kpi"><span class="label">最好的一条</span><span class="v">${fmtN(views(best[0]))}</span><span class="sub" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(best[0].title)}</span></div>
  </div>
  <div class="home-grid">
    <div class="grid">
      <div class="panel"><div class="label" style="margin-bottom:12px">各账号播放</div><div class="hbar">${per.map(x=>`<div class="r c-${esc(x.a.color)}"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.a.code)} · ${esc(x.a.name)}</span><div class="track"><div class="fill" style="width:${(x.v/max*100).toFixed(1)}%"></div></div><span class="val">${fmtN(x.v)}</span></div>`).join('')}</div>
        <p class="hint" style="margin-top:12px">${per.map(x=>`${esc(x.a.code)} 号 ${x.n} 条，互动率 ${(x.rate*100).toFixed(1)}%`).join('；')}</p></div>
      <div class="panel tbl-wrap"><table><thead><tr><th>发布</th><th>账号</th><th>标题</th><th class="n">播放</th><th class="n">点赞</th><th class="n">评论</th><th class="n">分享</th><th class="n">涨粉</th><th class="n">互动率</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>
    <aside class="panel grid" style="gap:12px">
      <div class="blk-head"><h3>AI 复盘</h3><span class="faint" style="font-size:12px">${modeOf('analysis')==='agent'?'后台 Agent':'单次调用'}</span><div class="actions">${(()=>{
        if(modeOf('analysis')==='oneshot')return `${busy?'<button class="btn" data-act="stop">停止</button>':''}<button class="btn primary" data-act="ai-analysis" ${!aiReady()||S.gen?'disabled':''}>${an?'重新复盘':'开始复盘'}</button>`;
        const r=runningRun('analysis');if(r)return `<button class="btn" data-act="agent-stop" data-id="${esc(r.id)}">停止</button><button class="btn primary" disabled>Claude 复盘中…</button>`;
        const other=runningRun();return `<button class="btn primary" data-act="ai-analysis" ${!aiReady()||other?'disabled':''} title="${other?'Claude 正在跑「'+esc(other.name)+'」，等它结束再点':''}">${other?'Claude 正忙':an?'重新复盘':'开始复盘'}</button>`;
      })()}</div></div>
      ${modeOf('analysis')==='agent'?vRunMini(runningRun('analysis')||lastRun('analysis')):''}
      <div id="anOut">${busy?'<p class="hint busy">Claude 正在分析数据…</p>':an?`<p class="ai-out">${esc(an.text)}</p><p class="hint" style="margin-top:8px">生成于 ${new Date(an.at).toLocaleString('zh-CN',{hour12:false})}</p>`:'<p class="hint">把所有已发布内容的数据交给 Claude，找出哪类选题、情绪、账号在赢，并给出下周的选题方向。</p>'}</div>
    </aside>
  </div>`;
}
async function aiAnalysis(){
  if(modeOf('analysis')==='agent'){try{await api('POST','/api/agent/run',{task:'analysis'});toast('Claude 开始复盘，完成后结果会出现在这里')}catch(e){toast(e.message||'启动失败')}return}
  const ctl=startGen('analysis');if(!ctl)return;render();
  let text='',err=null;
  try{
    await sse('/api/ai/analysis',{},{signal:ctl.signal,onEvent:(ev,d)=>{
      if(ev==='text'){text+=d.delta;const o=$('#anOut');if(o)o.innerHTML=`<p class="ai-out">${esc(text)}</p>`}
      else if(ev==='done'){local.notes.analysis=d.note;applyLocal('notes')}
      else if(ev==='error')err=d}});
    if(err)throw err;
  }catch(e){toast(aiErr(e))}
  finally{endGen();render()}
}
/* ---------- 内容详情抽屉 ---------- */
let saveTimers={};
function openItem(id,tries=0){if(!S.items[id]){if(tries<25)setTimeout(()=>openItem(id,tries+1),120);return}
  const it=S.items[id];S.open=id;S.draft={title:it.title||'',hook:it.hook||'',angle:it.angle||'',script:it.script||'',notes:it.notes||''};renderDrawer();}
function flushSaves(){for(const k in saveTimers){clearTimeout(saveTimers[k].t);saveTimers[k].fn()}saveTimers={}}
function closeDrawer(){flushSaves();flushPub();S.open=null;S.draft=null;$('#drawerRoot').innerHTML='';requestRender()}
function saveField(field,val,delay=700){const id=S.open;if(!id)return;S.draft[field]=val;
  if(saveTimers[field])clearTimeout(saveTimers[field].t);
  const fn=()=>{delete saveTimers[field];store.update('items',id,{[field]:val,updatedAt:Date.now()})};
  saveTimers[field]={t:setTimeout(fn,delay),fn};}
// 重画详情时，眼前看的那一块保持不动：按钮变状态、多出进度框这类高度变化，不会把内容挤走。
// 锚点优先用刚点过的按钮所在的那一块，没有就用滚动区顶部第一块看得见的
function captureAnchors(){
  const all=[...document.querySelectorAll('#drawerRoot .blk')];
  return ['#dcolL','#dcolR','.drawer-body'].map(sel=>{const sc=$(sel);if(!sc)return null;
    const top=sc.getBoundingClientRect().top;
    let el=S.lastClick&&sc.contains(S.lastClick)?S.lastClick.closest('.blk'):null;
    if(!el)el=[...sc.querySelectorAll('.blk')].find(b=>b.getBoundingClientRect().bottom>top+8);
    return {sel,scroll:sc.scrollTop,idx:el?all.indexOf(el):-1,off:el?el.getBoundingClientRect().top-top:0};
  });
}
function restoreAnchors(list){
  const all=[...document.querySelectorAll('#drawerRoot .blk')];
  for(const a of list){if(!a)continue;const sc=$(a.sel);if(!sc)continue;
    sc.scrollTop=a.scroll;
    const el=a.idx>=0?all[a.idx]:null;
    if(el)sc.scrollTop+=el.getBoundingClientRect().top-sc.getBoundingClientRect().top-a.off;
  }
}
function renderDrawer(){
  const id=S.open;const it=S.items[id];if(!it){$('#drawerRoot').innerHTML='';return}
  drawerSig=drawerSigOf(id,local.items[id]||it);
  const d=S.draft;const accs=accList(true);const cur=STAGE_IDX[it.stage||'idea'];const done=checksDone(it);const allOk=done===CHECKS.length;
  const busyS=S.gen&&S.gen.kind==='script',busyC=S.gen&&S.gen.kind==='check';
  const anchors=captureAnchors();
  keepLogScroll($('#drawerRoot'),()=>{$('#drawerRoot').innerHTML=`<div class="backdrop" data-act="close-drawer"></div>
  <aside class="drawer" role="dialog" aria-label="内容详情">
    <div class="drawer-head">
      <div class="r1"><select id="dAcc" aria-label="账号">${accs.map(a=>`<option value="${a.id}" ${a.id===it.accountId?'selected':''}>${esc(a.code)} · ${esc(a.name)}</option>`).join('')}</select>
        ${(S.accounts[it.accountId]?.series||[]).length?`<select id="dSeries" aria-label="系列"><option value="">不选系列（按账号大方向）</option>${S.accounts[it.accountId].series.map(x=>`<option value="${esc(x.id)}" ${x.id===it.seriesId?'selected':''}>《${esc(bareName(x.name))}》${x.active===false?'（已停用）':''}</option>`).join('')}</select>`:''}
        <span class="faint num" style="font-size:12px">${it.source==='ai'?'AI 选题':'手动'}</span>
        <button class="btn ghost" data-act="close-drawer" aria-label="关闭">关闭</button></div>
      <div class="steps">${STAGES.map((s,i)=>`<button class="step" data-act="stage" data-k="${s.k}" ${i===cur?'aria-current="step"':''}><i class="sd s-${s.k}"></i>${s.n}</button>`).join('')}</div>
    </div>
    <div class="drawer-body">
      <div class="dcol" id="dcolL">
      <div class="blk">
        <div class="field"><label for="dTitle">标题</label><input type="text" id="dTitle" value="${esc(d.title)}"></div>
        <div class="field"><label for="dHook">前 3 秒钩子</label><input type="text" id="dHook" value="${esc(d.hook)}" placeholder="开头的画面和第一句台词"></div>
        <div class="field"><label for="dAngle">内容概要</label><textarea id="dAngle" rows="2">${esc(d.angle)}</textarea></div>
      </div>
      <div class="blk" id="researchBlk">
        <div class="blk-head"><h3>调研</h3><span class="faint" style="font-size:12px">后台 Agent · 上网查资料</span><div class="actions">${researchActions(id,it)}</div></div>
        <div id="researchRun">${vRunMini(itemRun('research',id))}</div>
        ${vSay(itemRun('research',id))}
        ${vAssets(it)}
        ${it.research?vResearch(it.research,!d.script):'<p class="hint">写脚本之前先调研：上网查真实的价格、工具能力、操作步骤和反方观点，写成每条都有出处的报告；同时把能当画面的网页截图和官方视频收集成素材，做视频时直接用。写脚本时会以它为依据，台词里的数字都能追溯来源。一般 3–10 分钟。</p>'}
      </div>
      <div class="blk">
        <div class="blk-head"><h3>分镜脚本</h3><span class="faint" style="font-size:12px">${modeOf('script')==='agent'?'后台 Agent':'单次调用'}</span><div class="actions">${aiActions('script',id,!!d.script)}</div></div>
        <textarea id="dScript" placeholder="点「AI 写脚本」，Claude 会按这个账号的人设写一份可直接制作的分镜。你也可以自己写。">${esc(d.script)}</textarea>
        <div id="scriptRun">${modeOf('script')==='agent'?vRunMini(itemRun('script',id)):''}</div>
        ${modeOf('script')==='agent'?vSay(itemRun('script',id)):''}
        <p class="hint ${busyS?'busy':''}" id="scriptHint">${busyS?'Claude 正在写脚本，通常 20–60 秒开始出字。':modeOf('script')==='agent'?'后台 Agent 会先读账号人设，需要时上网查热点背景，写完自动存回这里。可以关掉详情去做别的。':'脚本会自动保存。'}</p>
      </div>
      </div>
      <div class="dcol" id="dcolR">
      <div class="blk" id="videoBlk">
        <div class="blk-head"><h3>视频</h3><span class="faint" style="font-size:12px">后台 Agent</span><div class="actions">${videoActions(id,it)}</div></div>
        <div id="videoRun">${vRunMini(itemRun('video',id))}</div>
        ${vSay(itemRun('video',id))}
        ${vLocalForm(id,it)}
        ${vVideo(it,id)}
        ${!it.video?'<p class="hint">按脚本做成成片 MP4，包含配音、字幕和动画。前期不加创作声明或安全提示，统一留给你在成片阶段处理。一般要 20–60 分钟，消耗的订阅额度比写脚本多得多；可以关掉详情去做别的。</p>':''}
      </div>
      <div class="blk" id="pubBlk">
        <div class="blk-head"><h3>发布</h3><div class="actions">${pubActions(it,id)}</div></div>
        ${vPublish(it,id)}
        <div id="pubStatus">${vPubStatus(it)}</div>
      </div>
      <div class="blk">
        <div class="blk-head"><h3>各平台数据</h3><span class="hint">发布后从创作者中心抄过来</span></div>
        <div class="metrics"><span></span>${METRICS.map(m=>`<span class="h">${m.n}</span>`).join('')}
          ${PLATFORMS.map(p=>`<span>${p.n}</span>${METRICS.map(m=>`<input type="number" min="0" inputmode="numeric" aria-label="${p.n}${m.n}" data-metric="${p.k}.${m.k}" value="${it.metrics?.[p.k]?.[m.k]??''}">`).join('')}`).join('')}
        </div>
      </div>
      <div class="blk">
        <div class="field"><label for="dNotes">备注</label><textarea id="dNotes" rows="3" placeholder="素材链接、制作备注、复盘想法">${esc(d.notes)}</textarea></div>
      </div>
      <div><button class="btn danger" data-act="del-item">删除这条内容</button></div>
      </div>
    </div>
  </aside>`});
  restoreAnchors(anchors);
}
function setStage(k){
  const id=S.open;const it=S.items[id];if(!it)return;
  const patch={stage:k,updatedAt:Date.now()};
  if(k==='published'&&!it.publishedAt){const d=new Date();patch.publishedAt=ymd(d)+'T'+pad(d.getHours())+':'+pad(d.getMinutes())}
  flushSaves();store.update('items',id,patch).then(()=>{if(S.open===id)setTimeout(renderDrawer,60)});
}
// 后台 Agent 方式：先把详情里还没存的修改存好，Agent 读到的才是最新的
async function agentItemTask(task){
  const id=S.open;if(!id)return;flushSaves();
  try{
    await store.update('items',id,{title:S.draft.title,hook:S.draft.hook,angle:S.draft.angle,script:S.draft.script,updatedAt:Date.now()});
    await api('POST','/api/agent/run',{task,itemId:id});
    toast(task==='research'?'Claude 开始调研，一般 3–10 分钟，报告会存到这张卡片上':task==='script'?'Claude 开始写脚本，写完会自动存回，可以先去做别的':task==='video'?'Claude 开始生成视频，一般要 20–60 分钟，可以先去做别的':'Claude 开始预审');
  }catch(e){toast(e.message||'启动失败')}
}
async function aiScript(){
  if(modeOf('script')==='agent')return agentItemTask('script');
  const id=S.open;const it=S.items[id];if(!it)return;
  const ctl=startGen('script');if(!ctl)return;flushSaves();renderDrawer();
  let text='',err=null;
  const ta=()=>$('#dScript');
  try{
    await sse('/api/ai/script',{itemId:id,draft:{title:S.draft.title,hook:S.draft.hook,angle:S.draft.angle}},{signal:ctl.signal,onEvent:(ev,d)=>{
      if(ev==='text'){text+=d.delta;const t=ta();if(t&&S.open===id){t.value=text;t.scrollTop=t.scrollHeight}}
      else if(ev==='done'){if(d.item){local.items[id]=d.item;applyLocal('items')}if(S.open===id)S.draft.script=d.text;if(d.truncated)toast('脚本太长被截断了，可以手动补完')}
      else if(ev==='error')err=d}});
    if(err)throw err;
  }catch(e){toast(aiErr(e));if(text&&S.open===id){S.draft.script=text;saveField('script',text,0)}}
  finally{endGen();if(S.open===id)setTimeout(renderDrawer,60)}
}
async function aiCheck(){
  if(modeOf('check')==='agent')return agentItemTask('check');
  const id=S.open;const it=S.items[id];if(!it)return;
  const ctl=startGen('check');if(!ctl)return;renderDrawer();
  try{
    const r=await api('POST','/api/ai/check',{itemId:id,draft:{title:S.draft.title,hook:S.draft.hook,script:S.draft.script}},ctl.signal);
    local.items[id]={...local.items[id],precheck:r};applyLocal('items');
  }catch(e){toast(aiErr(e))}
  endGen();
  if(S.open===id)renderDrawer();
}

/* ---------- events ---------- */
const armed=new WeakMap();
function arm(btn,label,fn){if(armed.get(btn)){armed.delete(btn);fn();return}armed.set(btn,1);const old=btn.textContent;btn.textContent=label;btn.classList.add('armed');setTimeout(()=>{if(armed.get(btn)){armed.delete(btn);btn.textContent=old;btn.classList.remove('armed')}},3500)}

// 平台连接的小菜单：点别处就收起
document.addEventListener('click',e=>{if(S.bindMenu&&!e.target.closest('.bind-wrap')){S.bindMenu=null;render()}});
document.addEventListener('click',e=>{
  if(e.target.closest('#drawerRoot'))S.lastClick=e.target; // 重画详情时用来对齐
  const b=e.target.closest('[data-act]');if(!b)return;const act=b.dataset.act,id=b.dataset.id,k=b.dataset.k;
  if(act==='modal-bg'&&e.target!==b)return;
  switch(act){
    case 'tab':S.tab=k;try{localStorage.setItem('wb.tab',k)}catch(_){};history.replaceState(null,'','#'+k);render();window.scrollTo(0,0);if(k==='sources'){loadHs();loadFeed()}if(k==='feed')loadFeed();if(k==='settings')loadModels();if(k==='skills')loadSkills();break;
    case 'goto-stage':S.tab='pipeline';S.filter='all';render();setTimeout(()=>$('#col-'+k)?.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'}),30);break;
    case 'hs-refresh':S.hs=null;render();loadHs();break;
    case 'feed-run':feedRun(id);break;
    case 'feed-toggle':S.feedOpen??=new Set();S.feedOpen.has(id)?S.feedOpen.delete(id):S.feedOpen.add(id);render();break;
    case 'feed-pick':{const d=b.dataset;const pid=uid();const now=Date.now();
      store.set('picks',pid,{title:d.title.slice(0,60),why:'',angle:'',sources:[{channel:d.ch,id:d.id,title:d.title,url:safeUrl(d.url)}],accounts:[],risk:'',status:'new',by:'manual',createdAt:now,updatedAt:now});
      toast('已送进选题雷达，可以直接给账号出题');break}
    case 'feed-chan':S.feedChan=k;render();break;
    case 'chan-sel':S.chanSel=k;S.cfgMsg=null;render();break;
    case 'cfg-save':cfgSave(id);break;
    case 'cfg-discard':S.cfg[id]=null;S.cfgMsg=null;render();break;
    case 'cfg-reset':{const d=draft(id);d.settings=JSON.parse(JSON.stringify(chan(id).config.defaults));d.dirty=true;render();break}
    case 'curate':agentRun('curate');break;
    case 'skill-sel':S.skillSel=k;S.skillMerged=null;S.skillCur=null;render();loadSkill(k);break;
    case 'skill-save':skillAction('save');break;
    case 'skill-reset':arm(b,'确认恢复',()=>skillAction('reset'));break;
    case 'skill-take-new':arm(b,'确认覆盖',()=>skillAction('take-new'));break;
    case 'skill-keep':skillAction('keep');break;
    case 'skill-merge':skillAction('merge');break;
    case 'skill-accept-merged':skillAction('accept-merged');break;
    case 'skill-merge-cancel':if(S.skillDraft&&S.skillCur)delete S.skillDraft[S.skillCur.name];S.skillMerged=null;render();break;
    case 'skill-discard':if(S.skillDraft&&S.skillCur)delete S.skillDraft[S.skillCur.name];render();break;
    case 'skill-hist':api('GET','/api/skills/'+encodeURIComponent(S.skillCur.name)+'/history/'+k).then(r=>{S.skillDraft={...(S.skillDraft||{}),[S.skillCur.name]:r.content};render();toast('已载入这一版，点保存才生效')}).catch(e=>toast(e.message||'读取失败'));break;
    case 'conf-claude-save':{const v=($('#confClaude')?.value||'').trim();if(!v){toast('先粘贴令牌');break}
      api('PUT','/api/config/claude',{token:v}).then(r=>{S.conf=r;toast('已保存，下次运行 Claude 时生效');render()}).catch(e=>toast(e.message||'保存失败'));break}
    case 'conf-claude-del':arm(b,'确认删除',()=>api('DELETE','/api/config/claude').then(r=>{S.conf=r;toast('已删除，改用本机 claude 的登录');render()}));break;
    case 'conf-image-save':{const body={baseUrl:$('#confImgUrl')?.value,model:$('#confImgModel')?.value,apiKey:$('#confImgKey')?.value};
      if(!S.conf?.image?.configured&&!String(body.apiKey||'').trim()){toast('先填 key');break}
      api('PUT','/api/config/image',body).then(r=>{S.conf=r;toast('已保存，之后生成封面会用 AI 画');render()}).catch(e=>toast(e.message||'保存失败'));break}
    case 'conf-image-del':arm(b,'确认删除',()=>api('DELETE','/api/config/image').then(r=>{S.conf=r;toast('已删除，封面改为从成片截取');render()}));break;
    case 'agent-say':{const inp=b.closest('.say')?.querySelector('input');const text=(inp?.value||'').trim();if(!text){toast('先写要说的话');break}
      b.disabled=true;api('POST',`/api/agent/runs/${encodeURIComponent(id)}/say`,{text}).then(()=>{if(S.say)delete S.say[id];if(inp)inp.value='';toast('已插话：它会打断当前这一步，按你说的调整后继续')}).catch(e=>toast(e.message||'插话失败')).finally(()=>{b.disabled=false});break}
    case 'video-mark':{const v=document.querySelector('.vplayer');const ta=$('#videoFb');if(!v||!ta)break;const tag=`[${v.currentTime.toFixed(1)} 秒] `;
      ta.value=(ta.value&&!ta.value.endsWith('\n')?ta.value+'\n':ta.value)+tag;S.videoFb={...(S.videoFb||{}),[S.open]:ta.value};ta.focus();ta.setSelectionRange(ta.value.length,ta.value.length);break}
    case 'video-revise':{const fb=(S.videoFb?.[S.open]||'').trim();const imgs=(S.videoImgs?.[S.open]||[]).map(x=>x.path);if(fb.length<2&&!imgs.length){toast('先写一下要改哪里，或附一张图');break}
      const iid=S.open;b.disabled=true;api('POST','/api/agent/run',{task:'revise',itemId:iid,feedback:fb,images:imgs}).then(()=>{if(S.videoFb)delete S.videoFb[iid];if(S.videoImgs)delete S.videoImgs[iid];toast('Claude 开始修改，改好会生成新的一版');renderDrawer()}).catch(e=>{b.disabled=false;toast(e.message||'启动失败')});break}
    case 'video-grab':grabFrame(b);break;
    case 'video-pick':$('#videoFile')?.click();break;
    case 'video-unatt':{const id2=S.open;const list=[...(S.videoImgs?.[id2]||[])];list.splice(Number(b.dataset.i),1);S.videoImgs={...S.videoImgs,[id2]:list};refreshAtts();break}
    case 'run-view':S.runView=id;if(!$('#runViewRoot')){const d=document.createElement('div');d.id='runViewRoot';document.body.appendChild(d)}renderRunView();break;
    case 'run-view-close':S.runView=null;renderRunView();break;
    case 'run-view-bg':if(e.target===b){S.runView=null;renderRunView()}break;
    case 'bind-login':{S.bindMenu=null;const acc=id,plat=b.dataset.k,key=`${plat}:${acc}`,pn=BIND_PLATS.find(x=>x.k===plat)?.n||plat;b.disabled=true;
      api('POST',`/api/publish/${plat}/login`,{accountId:acc}).then(st=>{S.logins={...(S.logins||{}),[key]:st};render();toast('已打开一个新的 Chrome 窗口，扫码登录后回来点「我已登录」');
        const poll=setInterval(async()=>{try{const x=await api('GET','/api/publish/logins/'+encodeURIComponent(st.id));S.logins={...S.logins,[key]:x};requestRender();
          if(x.status==='done'||x.status==='failed'){clearInterval(poll);toast(x.status==='done'?`${pn}绑定成功`:'绑定失败：'+x.message);if(S.bindCheck)delete S.bindCheck[key];loadPubAcc()}}catch{clearInterval(poll)}},2000)})
      .catch(e=>{b.disabled=false;toast(e.message||'打开登录窗口失败')});break}
    case 'bind-done':b.disabled=true;api('POST',`/api/publish/${b.dataset.k}/login-done`,{accountId:id}).catch(e=>{b.disabled=false;toast(e.message||'操作失败')});break;
    case 'bind-check':{S.bindMenu=null;const acc=id,plat=b.dataset.k;b.disabled=true;b.textContent='检查中…';api('POST',`/api/publish/${plat}/check`,{accountId:acc}).then(r=>{S.bindCheck={...(S.bindCheck||{}),[`${plat}:${acc}`]:r};render()}).catch(e=>toast(e.message||'检查失败')).finally(()=>{b.disabled=false;b.textContent='检查'});break}
    case 'bind-off':{const plat=b.dataset.k;arm(b,'确认解绑',async()=>{S.bindMenu=null;await api('POST',`/api/publish/${plat}/unbind`,{accountId:id});if(S.bindCheck)delete S.bindCheck[`${plat}:${id}`];loadPubAcc();toast('已解绑')});break}
    case 'pub-gen':{const iid=S.open;const go=()=>api('POST',`/api/publish/items/${encodeURIComponent(iid)}/info`,{}).catch(e=>toast(e.message||'生成失败'));
      if(local.items[iid]?.publish?.platforms&&!armed.get(b))arm(b,'会覆盖已改的内容，确认？',go);else{armed.delete(b);go()}break}
    case 'asset-del':{const iid=S.open;arm(b,'确认删除',()=>api('DELETE',`/api/items/${encodeURIComponent(iid)}/assets/${encodeURIComponent(id)}`).catch(e=>toast(e.message||'删除失败')));break}
    case 'video-local-open':S.localOpen=S.open;renderDrawer();setTimeout(()=>$('#localPath')?.focus(),50);break;
    case 'video-local-cancel':S.localOpen=null;renderDrawer();break;
    case 'video-local-pick':{const iid=S.open;b.disabled=true;b.textContent='在选文件…';
      api('POST','/api/pick-video').then(r=>{if(r.path){S.localPath={...(S.localPath||{}),[iid]:r.path};const el=$('#localPath');if(el)el.value=r.path}})
        .catch(e=>toast(e.message||'打不开选文件窗口，直接粘贴路径')).finally(()=>{b.disabled=false;b.textContent='选择文件…'});break}
    case 'video-local-ok':{const iid=S.open;const pth=$('#localPath')?.value.trim();if(!pth){toast('先选视频文件或粘贴路径');break}b.disabled=true;
      api('POST',`/api/items/${encodeURIComponent(iid)}/video-local`,{path:pth,guide:$('#localGuide')?.value||''})
        .then(()=>{S.localOpen=null;toast('好了，卡片进了「待发布」。Claude 在看这条视频，看完就能生成发布信息')})
        .catch(e=>{b.disabled=false;toast(e.message||'没用上')});break}
    case 'video-rewatch':{const iid=S.open;b.disabled=true;api('POST',`/api/items/${encodeURIComponent(iid)}/video-watch`).catch(e=>{b.disabled=false;toast(e.message||'失败')});break}
    case 'pub-fill':{const iid=S.open;b.disabled=true;api('POST',`/api/publish/items/${encodeURIComponent(iid)}/info`,{missingOnly:true}).then(()=>toast('Claude 在补写缺的平台文案，约半分钟')).catch(e=>{b.disabled=false;toast(e.message||'生成失败')});break}
    case 'pub-cover':{const iid=S.open;const pr=$('#pubCoverPrompt')?.value?.trim();const t=$('#pubCoverTime')?.value;
      api('POST',`/api/publish/items/${encodeURIComponent(iid)}/info`,{coverOnly:true,mode:k,coverTime:k==='frame'?t:undefined,coverPrompt:k==='ai'?pr||undefined:undefined}).then(()=>toast(k==='ai'?'正在用 AI 画新封面（竖版和横版），约半分钟':'正在从成片截取封面')).catch(e=>toast(e.message||'生成失败'));break}
    case 'pub-go':{const iid=S.open;flushPub();const plats=[...document.querySelectorAll('[data-pubsel]:checked')].map(x=>x.dataset.pubsel);if(!plats.length){toast('至少勾选一个平台');break}
      const accId=S.items[iid]?.accountId;const manual=plats.filter(k=>manualOf(accId,k));const auto=plats.filter(k=>!manual.includes(k));const nm=l=>l.map(p=>PUB_PLATFORMS.find(x=>x.k===p)?.n).join('、');
      const go=()=>setTimeout(()=>api('POST',`/api/publish/items/${encodeURIComponent(iid)}/go`,{platforms:auto,manual}).then(()=>{toast(auto.length?`开始自动发${nm(auto)}${manual.length?`；${nm(manual)}的手动发布步骤在「发布」下面`:''}`:'手动发布的步骤在「发布」下面');setTimeout(()=>$('#pubStatus')?.scrollIntoView({behavior:'smooth',block:'center'}),600)}).catch(e=>toast(e.message||'发布失败')),400);
      if(!armed.get(b))arm(b,`确认：${auto.length?`自动发 ${nm(auto)}`:''}${auto.length&&manual.length?'，':''}${manual.length?`手动发 ${nm(manual)}`:''}？`,go);else{armed.delete(b);go()}break}
    case 'copy':{const t=b.dataset.copy||'';const ok=()=>{toast(`${b.dataset.what||''}已复制`);b.textContent='已复制';setTimeout(()=>{b.textContent='复制'},1500)};
      // 剪贴板接口不让用时（有的环境限制），退回到选中文字再复制的老办法
      const legacy=()=>{const ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;top:-1000px;opacity:0';document.body.appendChild(ta);ta.select();let done=false;try{done=document.execCommand('copy')}catch(_){}ta.remove();done?ok():toast('复制失败，手动选中复制')};
      (navigator.clipboard?.writeText?navigator.clipboard.writeText(t).then(ok):Promise.reject()).catch(legacy);break}
    case 'reveal':api('POST',`/api/publish/items/${encodeURIComponent(S.open)}/reveal`,{file:b.dataset.file}).then(r=>{if(!r.ok&&r.path)toast(r.path)}).catch(e=>toast(e.message||'打不开'));break;
    case 'manual-done':b.disabled=true;api('POST',`/api/publish/items/${encodeURIComponent(S.open)}/manual/${k}/done`).then(()=>toast('记下了')).catch(e=>{b.disabled=false;toast(e.message||'失败')});break;
    case 'manual-cancel':arm(b,'确认不发',()=>api('POST',`/api/publish/items/${encodeURIComponent(S.open)}/manual/${k}/cancel`).catch(e=>toast(e.message||'失败')));break;
    case 'agent-resume':b.disabled=true;api('POST',`/api/agent/runs/${encodeURIComponent(id)}/resume`).then(()=>toast('从中断处继续了')).catch(e=>{b.disabled=false;toast(e.message||'继续失败')});break;
    case 'agent-stop':api('POST',`/api/agent/runs/${encodeURIComponent(id)}/stop`).catch(e=>toast(e.message||'停止失败'));break;
    case 'run-toggle':S.runOpen=S.runOpen===id?null:id;render();break;
    case 'toggle-dropped':S.showDropped=!S.showDropped;render();break;
    case 'pick-open':{const p=S.picks[id];S.pickOpen=id;S.pickAcc=new Set((p?.accounts||[]).map(a=>S.accounts[a]?.code).filter(Boolean));render();break}
    case 'pick-cancel':S.pickOpen=null;render();break;
    case 'pick-acc':S.pickAcc.has(k)?S.pickAcc.delete(k):S.pickAcc.add(k);render();break;
    case 'pick-go':{const accounts=[...S.pickAcc];S.pickOpen=null;agentRun('ideas',{pickId:id,accounts,n:S.pickN});S.tab='ideas';history.replaceState(null,'','#ideas');render();break}
    case 'pick-status':store.update('picks',id,{status:k,updatedAt:Date.now()});break;
    case 'idea-filter':S.ideaFilter=id;render();break;
    case 'stop':S.gen?.ctl.abort();break;
    case 'idea-add':ideaAdd(id);break;
    case 'idea-drop':ideaDrop(id);break;
    case 'filter':S.filter=id;S.seriesFilter='';render();break;
    case 'series-filter':S.seriesFilter=id;render();break;
    case 'series-items':S.tab='pipeline';S.filter=id;S.seriesFilter=k;history.replaceState(null,'','#pipeline');render();window.scrollTo(0,0);break;
    case 'new-item':newItem();break;
    case 'open':openItem(id);break;
    case 'close-drawer':closeDrawer();break;
    case 'stage':setStage(k);break;
    case 'ai-script':if(S.draft?.script&&!armed.get(b)){arm(b,'确认覆盖现有脚本？',aiScript)}else{armed.delete(b);aiScript()}break;
    case 'ai-check':aiCheck();break;
    case 'ai-research':if(local.items[S.open]?.research&&!armed.get(b)){arm(b,'确认重新调研？',()=>agentItemTask('research'))}else{armed.delete(b);agentItemTask('research')}break;
    case 'ai-video':if(local.items[S.open]?.video&&!armed.get(b)){arm(b,'确认重新生成？',()=>agentItemTask('video'))}else{armed.delete(b);agentItemTask('video')}break;
    case 'ai-analysis':aiAnalysis();break;
    case 'del-item':arm(b,'再点一次确认删除',async()=>{const i=S.open;flushSaves();S.open=null;$('#drawerRoot').innerHTML='';await store.del('items',i);toast('已删除')});break;
    case 'edit-acc':openAccModal(id);break;
    case 'toggle-chip':{const g=b.dataset.group;if(g==='color'){b.parentElement.querySelectorAll('[data-group="color"]').forEach(x=>x.setAttribute('aria-pressed','false'));b.setAttribute('aria-pressed','true')}else b.setAttribute('aria-pressed',b.getAttribute('aria-pressed')!=='true');break}
    case 'modal-close':case 'modal-bg':$('#modalRoot').innerHTML='';break;
    case 'acc-ai':accAiFill(b);break;
    case 'edit-series':openSeriesModal(id,b.dataset.k||'');break;
    case 'acc-sel':S.accSel=id;S.bindMenu=null;render();break;
    case 'bind-menu':S.bindMenu=S.bindMenu===id?null:id;render();break;
    case 'series-ai-new':seriesAi(b,'new');break;
    case 'series-ai-revise':seriesAi(b,'revise');break;
    case 'series-undo':{const f=$('#seriesForm');const cur=(S.accounts[f.dataset.acc]?.series||[]).find(x=>x.id===f.dataset.sid);const prev=cur?.history?.[0];if(!prev)break;
      fillSeriesForm(prev);$('#seriesMsg').textContent=`已经退回到 ${fmtTime(prev.savedAt)} 保存前的那一版，点保存才生效`;break}
    case 'del-series':{const f=$('#seriesForm');arm(b,'确认删除？用它的内容会改按账号大方向做',async()=>{const acc=S.accounts[f.dataset.acc];await store.set('accounts',f.dataset.acc,{...acc,series:(acc.series||[]).filter(x=>x.id!==f.dataset.sid)});$('#modalRoot').innerHTML='';toast('系列已删除')});break}
    case 'del-acc':arm(b,'确认删除？内容会保留',async()=>{await store.del('accounts',id);$('#modalRoot').innerHTML='';toast('账号已删除')});break;
  }
});
document.addEventListener('input',e=>{
  const t=e.target;
  if(t.id==='skillText'&&S.skillCur){S.skillDraft={...(S.skillDraft||{}),[S.skillCur.name]:t.value};const sv=document.querySelector('[data-act="skill-save"]');if(sv)sv.disabled=t.value===S.skillCur.content;return}
  if(t.id==='videoFb'){S.videoFb={...(S.videoFb||{}),[S.open]:t.value};return}
  if(t.id==='accQ'){S.accQ=t.value;const q=t.value.trim().toLowerCase();document.querySelectorAll('.acc-row').forEach(r=>{r.hidden=!!q&&!r.dataset.search.includes(q)});return}
  if(t.id==='localPath'){S.localPath={...(S.localPath||{}),[S.open]:t.value};return}
  if(t.id==='localGuide'){S.localGuide={...(S.localGuide||{}),[S.open]:t.value};return}
  if(t.dataset?.vguide){const iid=S.open;clearTimeout(S.guideT);S.guideT=setTimeout(()=>store.update('items',iid,{video:{guide:t.value.slice(0,2000)}}),600);return}
  if(t.dataset?.pub){queuePub(t.dataset.pub,t.dataset.f,t.value);
    return}
  if(t.id&&t.id.startsWith('say-')){S.say={...(S.say||{}),[t.id.slice(4)]:t.value};return}
  if(!S.open)return;
  const map={dTitle:'title',dHook:'hook',dAngle:'angle',dScript:'script',dNotes:'notes'};
  if(map[t.id])saveField(map[t.id],t.value);
});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.id==='pickN'){S.pickN=Number(t.value)||3;return}
  if(t.dataset.pubmanual){const it=S.items[S.open];if(!it)return;const k=t.dataset.pubmanual;
    // 只改这个平台的说明文字，不重画整个详情（重画时封面图重新加载会让页面跳动）
    store.update('accounts',it.accountId,{manualPublish:{[k]:t.checked}});
    const lab=t.closest('.pub-sel-row')?.querySelector('.pub-sel-note');if(lab)lab.outerHTML=pubSelNote(it,k);
    toast(t.checked?`${PUB_PLATFORMS.find(x=>x.k===k)?.n}改成手动发，这个账号以后默认都手动`:'改回自动发');return}
  if(t.id==='uiLang'){store.set('settings','ui',{...(local.settings.ui||{}),lang:t.value}).finally(()=>window.setUiLang(t.value));return}
  if(t.dataset.model){setModel(t.dataset.model,t.value);return}
  if(t.dataset.effort){const f=S.modelCfg.features.find(x=>x.key===t.dataset.effort);const cur={...(local.settings.efforts||{})};if(t.value===f?.defaultEffort)delete cur[t.dataset.effort];else cur[t.dataset.effort]=t.value;store.set('settings','efforts',cur).then(()=>{toast(`「${f?.name||''}」思考强度改成 ${t.value}，下次运行生效`);loadModels()});return}
  if(t.dataset.mode){const cur={...(local.settings.modes||{})};cur[t.dataset.mode]=t.value;store.set('settings','modes',cur);toast(`改成${t.value==='agent'?'后台 Agent':'单次调用'}，下次点按钮生效`);return}
  if(t.dataset.cfg){const d=draft(t.dataset.cfg);const v=Number(t.value);if(t.dataset.f==='everyMin')d.everyMin=v;else d.settings[t.dataset.f]=v;d.dirty=true;render();return}
  if(!S.open)return;const id=S.open;
  if(t.dataset?.pubsel){const sel=[...document.querySelectorAll('[data-pubsel]:checked')].map(x=>x.dataset.pubsel);store.update('items',S.open,{publish:{selected:sel}});return}
  if(t.id==='dAcc'){const ser=(S.accounts[t.value]?.series||[]).filter(x=>x.active!==false);store.update('items',id,{accountId:t.value,seriesId:ser.length===1?ser[0].id:null,updatedAt:Date.now()});renderDrawer();return}
  if(t.id==='dSeries'){store.update('items',id,{seriesId:t.value||null,updatedAt:Date.now()});return}
  if(t.id==='dSched'){store.update('items',id,{scheduledAt:t.value,updatedAt:Date.now()});return}
  if(t.id==='dPub'){store.update('items',id,{publishedAt:t.value,updatedAt:Date.now()});return}
  if(t.dataset.check){store.update('items',id,{checks:{[t.dataset.check]:t.checked},updatedAt:Date.now()});
    const n=document.querySelectorAll('[data-check]:checked').length;const c=$('#chkCount');if(c){c.textContent=n+'/'+CHECKS.length;c.classList.toggle('full',n===CHECKS.length)}
    document.querySelectorAll('.step').forEach((s,i)=>s.classList.toggle('locked',i>=4&&n<CHECKS.length));return}
  if(t.dataset.metric){const [p,m]=t.dataset.metric.split('.');const v=t.value===''?0:Math.max(0,Math.round(Number(t.value)||0));store.update('items',id,{metrics:{[p]:{[m]:v}},updatedAt:Date.now()})}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&S.runView){S.runView=null;renderRunView();return}if(e.key==='Escape'){if($('#modalRoot').innerHTML){$('#modalRoot').innerHTML=''}else if(S.open)closeDrawer()}});

/* ---------- boot ---------- */
render();
loadState();
loadHs();setInterval(loadHs,120000);
api('GET','/api/voices').then(v=>{S.voices=v}).catch(()=>{});
loadConf();
loadPubAcc();
loadFeed();setInterval(loadFeed,120000);
if(S.tab==='settings')loadModels();
if(S.tab==='skills')loadSkills();
// 数据变化（包括 Claude 通过 MCP 写入）时自动刷新
let reloadT;
// 工作台重启时连接会断，浏览器自动重连；重连后重新读一遍数据，补上断开期间漏掉的变化
try{const es=new EventSource('/api/events');let connected=false;es.addEventListener('change',()=>{clearTimeout(reloadT);reloadT=setTimeout(loadState,300)});es.onopen=()=>{if(connected)loadState();connected=true}}catch(_){}
api('GET','/api/health').then(h=>{S.health=h;renderStatus();renderBanner()}).catch(()=>{});

// 修改意见框：粘贴截图、拖入图片、选择文件
document.addEventListener('paste',async e=>{
  if(e.target?.id!=='videoFb')return;
  const files=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
  if(!files.length)return;e.preventDefault();
  for(const f of files){const n=await attachImage(f,'截图');if(n)appendFb(`见图 ${n}：`)}
});
document.addEventListener('dragover',e=>{if(e.target.closest?.('.revise'))e.preventDefault()});
document.addEventListener('drop',async e=>{
  if(!e.target.closest?.('.revise'))return;e.preventDefault();
  for(const f of [...(e.dataTransfer?.files||[])].filter(f=>f.type.startsWith('image/'))){const n=await attachImage(f,f.name);if(n)appendFb(`见图 ${n}：`)}
});
document.addEventListener('change',async e=>{
  if(e.target?.id!=='videoFile')return;
  for(const f of [...e.target.files]){const n=await attachImage(f,f.name);if(n)appendFb(`见图 ${n}：`)}
  e.target.value='';
});
