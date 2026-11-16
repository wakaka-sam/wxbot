const $=s=>document.querySelector(s);
const stateNames={active:'已启用',paused:'已暂停',queued:'等待执行',completed:'已结束',cancelled:'已取消'};
const jobNames={pending:'排队中',running:'执行中',done:'执行完成',failed:'执行失败',interrupted:'执行中断',cancelled:'已取消'};
const deliveryNames={pending:'待发送（连接或额度不足时等待）',sending:'发送中',sent:'微信已接收',failed:'发送失败',unknown:'发送结果未确认',skipped:'已跳过'};
const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
const at=(value,zone='Asia/Shanghai')=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value)):'—';
const localInput=value=>value?new Date(Date.parse(value)+8*3600000).toISOString().slice(0,16):'';
function rule(spec){
 const text=spec.type==='once'?`一次性 · ${at(spec.at)}（北京时间）`:spec.type==='interval'?`每 ${spec.minutes} 分钟`:
 `${spec.type==='weekly'?'每周'+'日一二三四五六'[spec.weekday]:spec.type==='workdays'?'周一至周五':spec.type==='monthly'?`每月 ${spec.day} 号`:'每天'} ${spec.time}（${spec.timezone}）`;
 return text+(spec.until?` · 截止 ${at(spec.until)}（北京时间）`:'');
}
export function createScheduleManager({api,newRequestId}){
 let assistantId=null,generation=0,busy=false,pending=null,editing=null,refreshing=false;
 const dialog=$('#schedules-dialog'),error=$('#schedules-error'),runRequests=new Map(),openHistory=new Set();
 function fail(e){error.textContent=e.message;error.hidden=false;}
 function resetForm(){editing=null;pending=null;$('#schedule-form').reset();$('#schedule-submit').textContent='创建任务';$('#schedule-edit-cancel').hidden=true;fields();}
 function edit(task){
  editing=task;pending=null;$('#schedule-name').value=task.name;$('#schedule-prompt').value=task.prompt;$('#schedule-mode').value=task.mode;
  $('#schedule-type').value=task.spec.type;$('#schedule-at').value=localInput(task.spec.at);$('#schedule-minutes').value=task.spec.minutes||30;
  $('#schedule-time').value=task.spec.time||'09:00';$('#schedule-timezone').value=task.spec.timezone||'Asia/Shanghai';$('#schedule-weekday').value=task.spec.weekday??1;$('#schedule-day').value=task.spec.day||1;$('#schedule-until').value=localInput(task.spec.until);
  $('#schedule-submit').textContent='保存修改';$('#schedule-edit-cancel').hidden=false;fields();$('#schedule-form').scrollIntoView({block:'start'});$('#schedule-name').focus();
 }
 async function history(task,container,before=null,append=false){
  const id=assistantId,g=generation;
  const data=await api(`/assistants/${id}/schedules/${task.id}/runs${before?'?before='+before:''}`);
  if(g!==generation||!dialog.open)return;
  if(!append)container.replaceChildren();
  if(!data.runs.length&&!append)container.append(el('p','还没有执行记录。'));
  for(const run of data.runs){
   const row=el('section','');row.className='schedule-run';
   row.append(el('strong',`${run.manual?'手动试运行':'计划执行'} · ${jobNames[run.state]||run.state} · ${run.execution_mode==='reminder'?'轻量提醒':'智能任务'}`),el('p',`入队 ${at(run.created_at)} · 开始 ${at(run.started_at)} · 结束 ${at(run.finished_at)}（北京时间）`));
   if(run.error)row.append(el('p',run.error));
   for(const m of run.messages)row.append(el('p',m.text+(m.truncated?'…（完整结果请看聊天记录）':'')));
   row.append(el('p',run.deliveries.length?'微信投递：':'微信投递：尚无投递记录'));
   for(const d of run.deliveries)row.append(el('p',`${deliveryNames[d.state]||d.state}${d.error?' · '+d.error:''} · ${at(d.updated_at||d.created_at)}`));
   container.append(row);
  }
  if(data.nextBefore){const more=el('button','加载更早记录');more.type='button';more.className='text-button';more.onclick=async()=>{more.disabled=true;try{await history(task,container,data.nextBefore,true);more.remove();}catch(e){more.disabled=false;fail(e);}};container.append(more);}
 }
 async function refresh(){
  if(refreshing||!assistantId||!dialog.open)return;refreshing=true;
  const id=assistantId,g=generation;
  try{
   const data=await api(`/assistants/${id}/schedules`);if(g!==generation||!dialog.open)return;
   $('#schedules-list').replaceChildren(...data.tasks.map(task=>{
    const card=el('article','');card.className='schedule-card';
    const heading=el('div','');heading.className='schedule-card-heading';heading.append(el('h3',task.name),el('span',stateNames[task.status]||task.status));
    card.append(heading,el('p',`${task.mode==='reminder'?'轻量提醒':'智能任务'} · ${task.prompt}`),el('p',rule(task.spec)),el('p',`下次：${at(task.next_run_at,task.spec.timezone)}${task.next_run_at?'（'+(task.spec.timezone||'Asia/Shanghai')+'）':''}`));
    if(task.last_job_state)card.append(el('p',`最近执行：${jobNames[task.last_job_state]||task.last_job_state} · ${at(task.last_run_at)}（北京时间）`));
    card.append(el('small',`ID：${task.id}`));
    const actions=el('div','');actions.className='schedule-actions';
    const items=task.status==='active'?[['update','编辑'],['run','立即试运行'],['pause','暂停'],['remove','取消任务']]:task.status==='paused'?[['update','编辑'],['run','立即试运行'],['resume','恢复'],['remove','取消任务']]:task.status==='queued'?[['remove','取消任务']]:task.status==='completed'?[['run','立即试运行']]:[];
    for(const [action,label] of items){
     const button=el('button',label);button.type='button';button.className='secondary';button.onclick=async()=>{
      if(busy)return;if(action==='update'){edit(task);return;}
      if(action==='remove'&&!confirm(`取消「${task.name}」？已经运行的任务会继续完成。`))return;
      if(action==='run'&&!confirm(`立即真实执行「${task.name}」并发送结果？原计划不变；如任务涉及外部操作，也会实际执行。`))return;
      busy=true;button.disabled=true;error.hidden=true;
      if(action==='run'&&!runRequests.has(task.id))runRequests.set(task.id,newRequestId());
      try{await api(`/assistants/${id}/schedules`,{action,id:task.id,...(action==='run'?{requestId:runRequests.get(task.id)}:{})});runRequests.delete(task.id);if(g===generation)await refresh();}
      catch(e){if(g===generation)fail(e);if(e.status&&e.status<500)runRequests.delete(task.id);}finally{busy=false;button.disabled=false;}
     };actions.append(button);
    }
    card.append(actions);
    const details=el('details',''),summary=el('summary','执行与投递记录'),content=el('div','');details.append(summary,content);details.open=openHistory.has(task.id);
    details.ontoggle=()=>{if(details.open){openHistory.add(task.id);void history(task,content).catch(fail);}else openHistory.delete(task.id);};card.append(details);
    return card;
   }));
   $('#schedules-empty').hidden=data.tasks.length>0;
  }finally{refreshing=false;}
 }
 function fields(){const type=$('#schedule-type').value;for(const n of dialog.querySelectorAll('[data-schedule-types]')){n.hidden=!n.dataset.scheduleTypes.split(' ').includes(type);for(const input of n.querySelectorAll('input,select'))input.disabled=n.hidden;}$('#schedule-mode-hint').textContent=$('#schedule-mode').value==='reminder'?'到点原样发送正文，不调用模型。':'到点由助手执行查询、总结或其他操作。';}
 $('#schedule-type').onchange=fields;$('#schedule-mode').onchange=fields;
 $('#schedules-refresh').onclick=()=>refresh().catch(fail);$('#schedule-edit-cancel').onclick=resetForm;
 $('#schedules-close').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{generation++;assistantId=null;pending=null;openHistory.clear();resetForm();});
 $('#schedule-form').onsubmit=async event=>{
  event.preventDefault();if(busy||!assistantId)return;
  const type=$('#schedule-type').value;
  const spec=type==='once'?{type,at:$('#schedule-at').value+':00+08:00'}:type==='interval'?{type,minutes:Number($('#schedule-minutes').value)}:{type,time:$('#schedule-time').value,timezone:$('#schedule-timezone').value.trim(),...(type==='weekly'?{weekday:Number($('#schedule-weekday').value)}:type==='monthly'?{day:Number($('#schedule-day').value)}:{})};
  if(type!=='once'&&$('#schedule-until').value)spec.until=$('#schedule-until').value+':00+08:00';
  const body={action:editing?'update':'add',...(editing?{id:editing.id,version:editing.version}:{}),mode:$('#schedule-mode').value,name:$('#schedule-name').value.trim(),prompt:$('#schedule-prompt').value.trim(),spec};
  const fingerprint=JSON.stringify(body);if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,requestId:newRequestId()};
  const id=assistantId,g=generation;busy=true;error.hidden=true;$('#schedule-submit').disabled=true;
  try{await api(`/assistants/${id}/schedules`,{...body,...(!editing?{requestId:pending.requestId}:{})});if(g!==generation)return;resetForm();await refresh();}
  catch(e){if(g===generation)fail(e);}finally{busy=false;$('#schedule-submit').disabled=false;}
 };
 setInterval(()=>{if(dialog.open&&!document.hidden&&!busy&&!editing&&!openHistory.size)void refresh().catch(fail);},10000);
 fields();
 return {open(id){generation++;assistantId=id;error.hidden=true;$('#schedules-list').replaceChildren();$('#schedules-empty').hidden=true;dialog.showModal();void refresh().catch(fail);},reset(){generation++;assistantId=null;pending=null;runRequests.clear();dialog.close();resetForm();}};
}
