const $=s=>document.querySelector(s),el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
const at=value=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value));
export function createWorkspaceTools({api,toast,saveMessage}){
 let assistantId=null,generation=0,nextBefore=null,query='',busy=false;
 const search=$('#history-dialog'),notify=$('#notifications-dialog');
 function error(e){toast(e.message);}
 async function context(seq){
  const id=assistantId,g=generation;try{
   const data=await api(`/assistants/${id}/history/context?seq=${seq}`);if(g!==generation||!search.open)return;
   const box=$('#history-context');box.replaceChildren();
   for(const m of data.messages){const row=el('article','');row.className='history-entry'+(m.seq===data.seq?' history-target':'');row.append(el('strong',`#${m.seq} · ${m.role==='user'?'你':'助手/系统'} · ${at(m.created_at)}`),el('p',m.text));
    if(saveMessage){const save=el('button','收藏这条消息');save.type='button';save.className='text-button';save.onclick=()=>saveMessage(id,m.seq,save);row.append(save);}
    for(const a of m.attachments||[]){if(a.error||!a.id)continue;const link=el('a','下载 '+a.name);link.href=`/api/assistants/${id}/attachments/${a.id}?download=1`;row.append(link);}box.append(row);
   }
   $('#history-results').hidden=true;$('#history-more').hidden=true;box.hidden=false;$('#history-back').hidden=false;box.querySelector('.history-target')?.scrollIntoView({block:'center'});
  }catch(e){if(g===generation)error(e);}
 }
 async function find(append=false){
  if(busy||!assistantId)return;const id=assistantId,g=generation;busy=true;$('#history-submit').disabled=true;
  if(!append){query=$('#history-query').value.trim();nextBefore=null;$('#history-results').replaceChildren();}
  $('#history-context').hidden=true;$('#history-back').hidden=true;$('#history-results').hidden=false;
  try{
   const data=await api(`/assistants/${id}/history/search?q=${encodeURIComponent(query)}${append&&nextBefore?'&before='+nextBefore:''}`);if(g!==generation||!search.open)return;
   for(const m of data.results){const button=el('button','');button.type='button';button.className='history-result';button.append(el('strong',`#${m.seq} · ${m.role==='user'?'你':'助手/系统'} · ${at(m.created_at)}`),el('span',m.excerpt));button.onclick=()=>context(m.seq);$('#history-results').append(button);}
   if(!append&&!data.results.length)$('#history-results').append(el('p','未找到匹配消息。'));
   nextBefore=data.nextBefore;$('#history-more').hidden=!nextBefore;
  }catch(e){if(g===generation)error(e);}finally{if(g===generation){busy=false;$('#history-submit').disabled=false;}}
 }
 $('#history-form').onsubmit=e=>{e.preventDefault();void find();};$('#history-more').onclick=()=>find(true);
 $('#history-back').onclick=()=>{$('#history-context').hidden=true;$('#history-back').hidden=true;$('#history-results').hidden=false;$('#history-more').hidden=!nextBefore;};
 $('#history-close').onclick=()=>search.close();$('#notifications-close').onclick=()=>notify.close();
 const quietFields=()=>{for(const s of ['#notify-start','#notify-end'])$(s).disabled=!$('#notify-quiet').checked;};$('#notify-quiet').onchange=quietFields;
 $('#notifications-form').onsubmit=async e=>{
  e.preventDefault();if(busy||!assistantId)return;const id=assistantId,g=generation;busy=true;$('#notify-save').disabled=true;
  try{await api(`/assistants/${id}/notifications`,{quiet:$('#notify-quiet').checked?{start:$('#notify-start').value,end:$('#notify-end').value}:null,finalOnly:$('#notify-final').checked,digestMinutes:Number($('#notify-digest').value)});if(g===generation){notify.close();toast('通知偏好已保存');}}
  catch(e){if(g===generation)error(e);}finally{if(g===generation){busy=false;$('#notify-save').disabled=false;}}
 };
 function reset(){generation++;assistantId=null;busy=false;search.close();notify.close();$('#history-results').replaceChildren();$('#history-context').replaceChildren();}
 for(const dialog of [search,notify])dialog.addEventListener('close',()=>{if(search.open||notify.open)return;generation++;assistantId=null;busy=false;});
 return {reset,openSearch(id){reset();assistantId=id;$('#history-query').value='';$('#history-context').hidden=true;$('#history-back').hidden=true;$('#history-results').hidden=false;$('#history-more').hidden=true;$('#history-submit').disabled=false;search.showModal();$('#history-query').focus();},async openNotifications(id){
  reset();assistantId=id;const g=generation;$('#notify-save').disabled=true;notify.showModal();
  try{const p=await api(`/assistants/${id}/notifications`);if(g!==generation||!notify.open)return;$('#notify-quiet').checked=Boolean(p.quiet);$('#notify-start').value=p.quiet?.start||'23:00';$('#notify-end').value=p.quiet?.end||'08:00';$('#notify-final').checked=p.finalOnly;$('#notify-digest').value=p.digestMinutes;quietFields();$('#notify-save').disabled=false;}
  catch(e){if(g===generation){error(e);notify.close();}}
 }};
}
