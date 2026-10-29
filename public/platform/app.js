const $=s=>document.querySelector(s);
function newRequestId(){
 if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
 // Plain HTTP on a LAN still supports getRandomValues, but not randomUUID.
 const bytes=crypto.getRandomValues(new Uint8Array(16));
 bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
let user=null,authMode='login',assistants=[],selected=null,readOnly=false,mode='workspace',adminScope=null,stream=null,selectionVersion=0,loadingList=false;
let messages=new Map(),hasMore=false,historyBusy=false,sending=false,pendingSend=null,pairId=null,pairMessageSeq=0,toastTimer,frame=null,busy=false;
const drafts=new Map(),phaseNames={offline:'未连接微信',loading:'获取二维码',waiting:'等待扫码',scanned:'等待确认',verifying:'等待配对码',connecting:'连接中',connected:'微信已连接',reconnecting:'微信重连中',paused:'微信已暂停',expired:'微信登录失效',error:'连接异常'};
const date=new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
function node(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,3500);}
async function api(path,body){const res=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json','X-Wxbot-Platform':'1'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(25000)});const data=await res.json();if(!res.ok){if(res.status===401&&user)showAuth();throw Object.assign(new Error(data.error||'请求失败'),{status:res.status,code:data.code,details:data.details});}return data;}
function showAuth(){setSidebar(false);stream?.close();stream=null;user=null;selected=null;assistants=[];messages.clear();drafts.clear();selectionVersion++;for(const d of document.querySelectorAll('dialog[open]'))d.close();$('#app-view').hidden=true;$('#auth-view').hidden=false;$('#boot').hidden=true;$('#password').value='';}
function authTab(register){authMode=register?'register':'login';$('#login-tab').classList.toggle('selected',!register);$('#register-tab').classList.toggle('selected',register);$('#auth-submit').textContent=register?'注册':'登录';$('#password').autocomplete=register?'new-password':'current-password';$('#auth-error').hidden=true;}
$('#login-tab').onclick=()=>authTab(false);$('#register-tab').onclick=()=>authTab(true);
$('#auth-form').onsubmit=async e=>{e.preventDefault();$('#auth-submit').disabled=true;$('#auth-error').hidden=true;try{const d=await api(authMode==='login'?'/login':'/register',{username:$('#username').value.trim(),password:$('#password').value});await enter(d.user);}catch(error){$('#auth-error').hidden=false;$('#auth-error').textContent=error.message;}finally{$('#auth-submit').disabled=false;}};
async function enter(u){user=u;mode='workspace';adminScope=null;selected=null;readOnly=false;messages.clear();$('#auth-view').hidden=true;$('#app-view').hidden=false;$('#boot').hidden=true;$('#password').value='';$('#user-name').textContent=u.username;$('#user-role').textContent=u.role==='admin'?'管理员':'个人工作空间';$('#user-avatar').textContent=u.username[0].toUpperCase();$('#admin-nav').hidden=u.role!=='admin';await refreshList();render();}
async function refreshList(){if(!user||loadingList)return;loadingList=true;const scope=`${mode}:${adminScope}`;try{const data=mode==='admin'&&adminScope?await api(`/admin/users/${adminScope}/assistants`):mode==='admin'?{assistants:[]}:await api('/assistants');if(scope!==`${mode}:${adminScope}`)return;assistants=data.assistants;$('#connection-status').textContent='工作台已连接';renderList();if(!selected&&assistants.length)await selectAssistant(assistants[0].id);if(selected){const fresh=assistants.find(a=>a.id===selected.id);if(fresh){selected={...fresh,connection:{...fresh.connection,qr:selected.connection?.qr}};renderChat();}}}catch(error){$('#connection-status').textContent=error.status===401?'登录已过期':'连接中断，正在重试';}finally{loadingList=false;}}
function renderList(){const admin=mode==='admin';$('#admin-users-panel').hidden=!admin;$('#workspace-nav').classList.toggle('selected',!admin);$('#admin-nav').classList.toggle('selected',admin);$('#empty-detail').textContent=admin?'选择一个用户，查看其会话。':'正在打开你的默认助手…';}
function render(){renderList();renderChat();}
const canChat=()=>Boolean(selected?.active&&selected.connection?.phase==='connected'&&selected.connection?.account?.userId);
function renderChat(){
 const empty=!selected;$('#chat-empty').hidden=!empty;$('#chat-content').hidden=empty;
 if(empty){$('#chat-title').textContent=mode==='admin'?'用户与会话':'我的助手';$('#chat-subtitle').textContent='';$('#pair-open').hidden=true;$('#rename-open').hidden=true;return;}
 const a=selected,disabled=readOnly||mode==='admin',connected=canChat();
 $('#chat-title').textContent=a.name;$('#chat-subtitle').textContent=phaseNames[a.connection.phase]||a.connection.phase;
 $('#readonly-banner').hidden=!disabled;$('#rename-open').hidden=disabled;$('#pair-open').hidden=disabled;$('#pair-open').disabled=busy;
 $('#pair-open').textContent=connected?'微信已连接':'连接微信';$('#pair-open').classList.toggle('connected',connected);
 $('#connection-gate').hidden=disabled||connected;$('#gate-connect').disabled=busy;
 $('#chat-input').disabled=disabled||!connected;$('#send').disabled=disabled||!connected||sending;
 $('#send').textContent=sending?'…':pendingSend?'重试':'↑';
 $('#interrupt').hidden=disabled||!a.running;
 $('#chat-input').placeholder=!connected?'连接微信后发送消息…':a.running?'补充新的想法…':'给助手发消息…';
 $('#composer-hint').textContent=!connected?'请先连接微信':a.running?'正在回复 · 可以继续补充':a.connection.waitingForFirstMessage?'请先在微信发送第一条消息，收到后即可接收微信回复':'Enter 发送 · Shift + Enter 换行';
 $('#chat-status').textContent=!connected?'':a.running?'正在处理你的消息…':a.deliveryErrors?.length?'部分微信消息发送未成功，可在网页查看完整回复。':'';
 $('#chat-status').hidden=!$('#chat-status').textContent;$('#chat-form').hidden=disabled;renderPair();
}
function mergeMessages(rows){for(const m of rows)messages.set(m.id,m);scheduleMessages();}
function scheduleMessages(){if(frame)return;frame=requestAnimationFrame(()=>{frame=null;renderMessages();});}
function renderMessages(){const scroll=$('#message-scroll'),follow=scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<100;const list=[...messages.values()].sort((a,b)=>a.seq-b.seq);$('#messages').replaceChildren(...list.map(m=>{const box=node('article',`message ${m.role} ${m.kind}`);box.dataset.state=m.state;box.dataset.id=m.id;const title=m.role==='user'?'你':m.role==='system'?'系统':m.kind==='summary'?'最近对话总结':m.kind==='greeting'?'助手问候':m.kind==='progress'?'助手 · 进度':selected?.name||'助手';const meta=node('div','message-meta');meta.append(node('span','',title),node('time','',date.format(new Date(m.created_at))));box.append(meta);if(m.text||!m.attachments?.length)box.append(node('div','message-body',m.text||'…'));for(const a of m.attachments||[]){const item=node('div','message-attachment');if(a.id&&!a.error){const url=`/api/assistants/${m.assistant_id}/attachments/${a.id}`;if(a.kind==='image'&&a.mime?.startsWith('image/')){const img=node('img','attachment-preview');img.src=url;img.alt=a.name;img.loading='lazy';item.append(img);}const link=node('a','',`下载 ${a.name}${a.size?' · '+Math.ceil(a.size/1024)+' KB':''}`);link.href=url+'?download=1';link.download=a.name;item.append(link);}else item.append(node('span','',`${a.name}：${a.error||'附件不可用'}`));box.append(item);}return box;}));$('#conversation-empty').hidden=list.length>0;$('#load-history').hidden=!hasMore;$('#load-history').disabled=historyBusy;if(follow)scroll.scrollTop=scroll.scrollHeight;}
async function selectAssistant(id){if(selected?.id===id)return;const version=++selectionVersion;if(selected)drafts.set(selected.id,{text:$('#chat-input').value,pending:pendingSend});stream?.close();stream=null;selected=null;messages.clear();hasMore=false;pendingSend=null;renderChat();try{const data=await api(`/assistants/${id}`);if(version!==selectionVersion)return;selected=data.assistant;readOnly=data.readOnly||mode==='admin';const draft=drafts.get(id);$('#chat-input').value=draft?.text||'';pendingSend=draft?.pending||null;$('#send-error').hidden=true;render();const history=await api(`/assistants/${id}/messages`);if(version!==selectionVersion)return;hasMore=history.hasMore;mergeMessages(history.messages);connectStream(id,version);}catch(error){toast(error.message);}}
function connectStream(id,version){const current=stream=new EventSource(`/api/assistants/${id}/events`);const valid=()=>stream===current&&version===selectionVersion;current.addEventListener('snapshot',e=>{if(!valid())return;const data=JSON.parse(e.data);selected=data.assistant;readOnly=data.readOnly||mode==='admin';mergeMessages(data.messages);renderChat();$('#connection-status').textContent='实时对话已连接';});current.addEventListener('update',e=>{if(!valid())return;const event=JSON.parse(e.data);if(event.type==='message')mergeMessages([event.data]);if(event.type==='assistant'){selected=event.data;assistants=assistants.map(a=>a.id===id?selected:a);render();}if(event.type==='error')toast(event.data.message);if(event.type==='status')$('#chat-status').textContent=event.data.message;});current.onerror=()=>{if(valid())$('#connection-status').textContent='实时连接中断，正在重连';};}
$('#load-history').onclick=async()=>{if(!selected||historyBusy)return;historyBusy=true;const id=selected.id;const oldest=Math.min(...[...messages.values()].map(m=>m.seq));const scroll=$('#message-scroll'),oldHeight=scroll.scrollHeight;try{const data=await api(`/assistants/${id}/messages?before=${oldest}`);if(selected?.id!==id)return;hasMore=data.hasMore;mergeMessages(data.messages);renderMessages();scroll.scrollTop+=scroll.scrollHeight-oldHeight;}catch(error){toast(error.message);}finally{historyBusy=false;}};
$('#chat-form').onsubmit=async e=>{e.preventDefault();if(!canChat()||sending||readOnly||mode==='admin')return;const id=selected.id,text=$('#chat-input').value.trim();if(!text&&!pendingSend)return;pendingSend||={text,requestId:newRequestId()};const pending=pendingSend;sending=true;$('#send-error').hidden=true;renderChat();try{const data=await api(`/assistants/${id}/messages`,pending);if(selected?.id===id){mergeMessages([data.message]);if($('#chat-input').value.trim()===pending.text)$('#chat-input').value='';pendingSend=null;}else drafts.delete(id);}catch(error){if(selected?.id===id){$('#send-error').hidden=false;$('#send-error').textContent=error.message;}if(error.status&&error.status<500)pendingSend=null;}finally{sending=false;renderChat();}};
$('#chat-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#chat-form').requestSubmit();}};
$('#interrupt').onclick=async()=>{try{await api(`/assistants/${selected.id}/interrupt`,{});}catch(error){toast(error.message);}};
$('#rename-open').onclick=()=>{setSidebar(false);$('#assistant-name').value=selected.name;$('#name-error').hidden=true;$('#name-dialog').showModal();};
$('#name-form').onsubmit=async e=>{e.preventDefault();const button=$('#name-form button[type=submit]');if(button.disabled)return;button.disabled=true;try{const data=await api(`/assistants/${selected.id}/rename`,{name:$('#assistant-name').value.trim()});$('#name-dialog').close();selected=data.assistant;await refreshList();render();}catch(error){$('#name-error').hidden=false;$('#name-error').textContent=error.message;}finally{button.disabled=false;}};
function renderPair(){
 if(!$('#pair-dialog').open||selected?.id!==pairId)return;
 const c=selected.connection,connected=c.phase==='connected'&&Boolean(c.account?.userId);
 if(connected&&(selected.lastWechatMessageSeq||0)>pairMessageSeq){$('#pair-dialog').close();return;}
 $('#pair-title').textContent=connected?'微信连接成功':`连接「${selected.name}」`;
 $('#pair-detail').textContent=connected?'现在可以直接在微信中输入消息，与助手对话。':c.detail;
 $('#pair-success').hidden=!connected;$('#pair-qr-panel').hidden=connected;
 $('#qr').hidden=!c.qr;if(c.qr&&$('#qr').src!==c.qr)$('#qr').src=c.qr;
 $('#qr-placeholder').hidden=Boolean(c.qr);$('#qr-placeholder').textContent=c.account?'正在连接微信…':'▦ 连接微信';
 $('#qr-refresh').hidden=Boolean(c.account)&&['connected','connecting','reconnecting'].includes(c.phase);
 $('#qr-refresh').disabled=busy||c.phase==='loading';$('#qr-refresh').textContent=c.qr?'刷新二维码':'生成二维码';
 $('#verify-form').hidden=c.phase!=='verifying';$('#disconnect').hidden=!c.account;$('#verify-form button').disabled=busy;
}
$('#pair-open').onclick=async()=>{
 const id=selected.id;busy=true;renderChat();
 try{
  const data=await api(`/assistants/${id}`);if(selected?.id!==id)return;
  selected=data.assistant;pairId=id;pairMessageSeq=selected.lastWechatMessageSeq||0;
  $('#pair-error').hidden=true;$('#pair-code').value='';$('#pair-dialog').showModal();renderPair();
 }catch(error){toast(error.message);}finally{busy=false;renderChat();}
};
async function channelAction(action,body={}){const id=pairId;if(action==='login')pairMessageSeq=selected.lastWechatMessageSeq||0;busy=true;renderPair();try{const data=await api(`/assistants/${id}/channel/${action}`,body);if(selected?.id===id){selected=data.assistant;renderChat();}await refreshList();}catch(error){$('#pair-error').hidden=false;$('#pair-error').textContent=error.message;}finally{busy=false;renderChat();}}
$('#qr-refresh').onclick=()=>channelAction('login');$('#verify-form').onsubmit=e=>{e.preventDefault();channelAction('verify',{code:$('#pair-code').value.trim()});};$('#disconnect').onclick=()=>{if(confirm('断开微信后将无法继续使用助手，当前回复也会停止。历史记录保留，重新连接后可继续。'))channelAction('disconnect');};
async function showWorkspace(){setSidebar(false);selectionVersion++;stream?.close();stream=null;selected=null;messages.clear();mode='workspace';adminScope=null;await refreshList();render();}
$('#workspace-nav').onclick=showWorkspace;
$('#admin-nav').onclick=async()=>{setSidebar(false);selectionVersion++;stream?.close();stream=null;selected=null;messages.clear();mode='admin';adminScope=null;assistants=[];render();try{const data=await api('/admin/users');$('#admin-users').replaceChildren(...data.users.map(u=>{const b=node('button','admin-user',u.username+(u.role==='admin'?' · admin':''));b.append(node('small','','查看会话'));b.dataset.id=u.id;b.onclick=async()=>{selectionVersion++;stream?.close();stream=null;selected=null;messages.clear();adminScope=u.id;for(const el of $('#admin-users').children)el.classList.toggle('selected',el===b);await refreshList();render();};return b;}));}catch(error){toast(error.message);}};
$('#logout').onclick=async()=>{try{await api('/logout',{});}finally{showAuth();}};
$('#password-open').onclick=()=>{setSidebar(false);$('#old-password').value='';$('#new-password').value='';$('#password-error').hidden=true;$('#password-dialog').showModal();};
$('#password-form').onsubmit=async e=>{e.preventDefault();const b=$('#password-form button[type=submit]');b.disabled=true;try{await api('/password',{oldPassword:$('#old-password').value,newPassword:$('#new-password').value});$('#password-dialog').close();toast('密码已更新，其他登录会话已失效');}catch(error){$('#password-error').hidden=false;$('#password-error').textContent=error.message;}finally{b.disabled=false;}};
$('#gate-connect').onclick=()=>$('#pair-open').click();
const mobile=matchMedia('(max-width: 800px)');let drawerOpen=false;
function setSidebar(open){
 drawerOpen=open&&mobile.matches;$('#sidebar').classList.toggle('open',drawerOpen);$('#sidebar-backdrop').hidden=!drawerOpen;
 $('#menu-open').setAttribute('aria-expanded',String(drawerOpen));$('#main-content').inert=drawerOpen;
 $('#sidebar').inert=mobile.matches&&!drawerOpen;
 if(drawerOpen){$('#sidebar').setAttribute('role','dialog');$('#sidebar').setAttribute('aria-modal','true');$('#sidebar-close').focus();}
 else{$('#sidebar').removeAttribute('role');$('#sidebar').removeAttribute('aria-modal');if(mobile.matches&&!$('#app-view').hidden)$('#menu-open').focus();}
}
$('#menu-open').onclick=()=>setSidebar(true);$('#sidebar-close').onclick=()=>setSidebar(false);$('#sidebar-backdrop').onclick=()=>setSidebar(false);
document.addEventListener('keydown',e=>{
 if(!drawerOpen)return;if(e.key==='Escape'){e.preventDefault();setSidebar(false);}
 if(e.key==='Tab'){const els=[...$('#sidebar').querySelectorAll('a,button')].filter(el=>!el.hidden&&el.getClientRects().length&&!el.disabled),first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}
});
mobile.addEventListener('change',()=>setSidebar(false));setSidebar(false);
function resizeViewport(){document.documentElement.style.setProperty('--app-height',`${window.visualViewport?.height||innerHeight}px`);document.documentElement.style.setProperty('--app-top',`${window.visualViewport?.offsetTop||0}px`);}
window.visualViewport?.addEventListener('resize',resizeViewport);window.visualViewport?.addEventListener('scroll',resizeViewport);window.addEventListener('resize',resizeViewport);resizeViewport();
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>document.getElementById(b.dataset.close).close();
setInterval(()=>{if(user&&!document.hidden)void refreshList();},5000);
window.addEventListener('pagehide',()=>stream?.close());
window.addEventListener('pageshow',e=>{if(e.persisted&&selected)connectStream(selected.id,selectionVersion);});
try{const d=await api('/auth');if(d.user)await enter(d.user);else showAuth();}catch(error){showAuth();$('#auth-error').hidden=false;$('#auth-error').textContent='无法连接服务，请刷新重试。';}
