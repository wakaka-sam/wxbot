const $=s=>document.querySelector(s);
const stateNames={active:'已启用',paused:'已暂停',queued:'等待执行',completed:'已结束',cancelled:'已取消'};
const jobNames={pending:'排队中',running:'执行中',done:'执行完成',failed:'执行失败',interrupted:'执行中断',cancelled:'已取消'};
const el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
const at=(value,zone='Asia/Shanghai')=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:zone,dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value)):'—';
function rule(spec){
 if(spec.type==='once')return `一次性 · ${at(spec.at)}（北京时间）`;
 if(spec.type==='interval')return `每 ${spec.minutes} 分钟`;
 return `${spec.type==='weekly'?'每周'+'日一二三四五六'[spec.weekday]:'每天'} ${spec.time}（${spec.timezone}）`;
}
export function createScheduleManager({api,newRequestId}){
 let assistantId=null,generation=0,busy=false,pending=null;
 const dialog=$('#schedules-dialog'),error=$('#schedules-error');
 function fail(e){error.textContent=e.message;error.hidden=false;}
 async function refresh(){
  const id=assistantId,g=generation;
  const data=await api(`/assistants/${id}/schedules`);
  if(g!==generation||!dialog.open)return;
  $('#schedules-list').replaceChildren(...data.tasks.map(task=>{
   const card=el('article','');card.className='schedule-card';
   const title=el('h3',task.name),status=el('span',stateNames[task.status]||task.status);
   const heading=el('div','');heading.className='schedule-card-heading';heading.append(title,status);
   card.append(heading,el('p',task.prompt),el('p',rule(task.spec)),el('p',`下次：${at(task.next_run_at,task.spec.timezone)}${task.next_run_at?'（'+(task.spec.timezone||'Asia/Shanghai')+'）':''}`));
   if(task.last_job_state)card.append(el('p',`最近执行：${jobNames[task.last_job_state]||task.last_job_state} · ${at(task.last_run_at)}（北京时间）`));
   const taskId=el('small',`ID：${task.id}`);card.append(taskId);
   const actions=el('div','');actions.className='schedule-actions';
   for(const [action,label] of task.status==='active'?[['pause','暂停'],['remove','取消任务']]:task.status==='paused'?[['resume','恢复'],['remove','取消任务']]:task.status==='queued'?[['remove','取消任务']]:[]){
    const button=el('button',label);button.type='button';button.className='secondary';button.onclick=async()=>{
     if(busy)return;if(action==='remove'&&!confirm(`取消「${task.name}」？已经运行的任务会继续完成。`))return;
     busy=true;button.disabled=true;error.hidden=true;
     try{await api(`/assistants/${id}/schedules`,{action,id:task.id});await refresh();}catch(e){fail(e);}finally{busy=false;button.disabled=false;}
    };actions.append(button);
   }
   card.append(actions);return card;
  }));
  $('#schedules-empty').hidden=data.tasks.length>0;
 }
 function fields(){const type=$('#schedule-type').value;for(const n of dialog.querySelectorAll('[data-schedule-types]')){n.hidden=!n.dataset.scheduleTypes.split(' ').includes(type);for(const input of n.querySelectorAll('input,select'))input.disabled=n.hidden;}}
 $('#schedule-type').onchange=fields;
 $('#schedules-refresh').onclick=()=>refresh().catch(fail);
 $('#schedules-close').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{generation++;assistantId=null;pending=null;});
 $('#schedule-form').onsubmit=async event=>{
  event.preventDefault();if(busy||!assistantId)return;
  const type=$('#schedule-type').value;
  const spec=type==='once'?{type,at:$('#schedule-at').value+':00+08:00'}:type==='interval'?{type,minutes:Number($('#schedule-minutes').value)}:{type,time:$('#schedule-time').value,timezone:$('#schedule-timezone').value.trim(),...(type==='weekly'?{weekday:Number($('#schedule-weekday').value)}:{})};
  const body={action:'add',name:$('#schedule-name').value.trim(),prompt:$('#schedule-prompt').value.trim(),spec};
  const fingerprint=JSON.stringify(body);
  if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,requestId:newRequestId()};
  const id=assistantId,g=generation;busy=true;error.hidden=true;$('#schedule-submit').disabled=true;
  try{await api(`/assistants/${id}/schedules`,{...body,requestId:pending.requestId});if(g!==generation)return;pending=null;$('#schedule-name').value='';$('#schedule-prompt').value='';await refresh();}
  catch(e){if(g===generation)fail(e);}finally{busy=false;$('#schedule-submit').disabled=false;}
 };
 fields();
 return {open(id){generation++;assistantId=id;error.hidden=true;$('#schedules-list').replaceChildren();$('#schedules-empty').hidden=true;dialog.showModal();void refresh().catch(fail);},reset(){generation++;assistantId=null;pending=null;dialog.close();$('#schedule-form').reset();fields();}};
}
