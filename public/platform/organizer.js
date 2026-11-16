const $=s=>document.querySelector(s),el=(tag,text)=>{const n=document.createElement(tag);n.textContent=text;return n;};
const time=t=>t?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(t)):'无截止时间';
export function createOrganizer({api,toast,newRequestId}){
 let owner=null,kind='todo',generation=0,page=1,pages=1,editing=null,pending=null,busy=false;
 const bookmarks=new Map();
 const dialog=$('#organizer-dialog');
 function fields(){const todo=kind==='todo';$('#organizer-todo-fields').hidden=!todo;$('#organizer-collection-fields').hidden=todo;$('#organizer-value').required=!todo&&!editing;$('#organizer-value-row').hidden=Boolean(editing);$('#organizer-type').disabled=Boolean(editing);$('#organizer-title-input').required=todo;$('#organizer-title').textContent=todo?'我的待办':'收藏箱';$('#organizer-new').textContent=todo?'新建待办':'新增收藏';$('#organizer-export').hidden=todo;$('#organizer-tag-filter').hidden=todo;$('#organizer-submit').textContent=editing?'保存修改':'添加';$('#organizer-edit-cancel').hidden=!editing;}
 function resetForm(){editing=null;pending=null;$('#organizer-form').reset();$('#organizer-form').hidden=true;fields();}
 function setBusy(value){busy=value;$('#organizer-form fieldset').disabled=value;$('#organizer-refresh').disabled=value;$('#organizer-prev').disabled=value||page<=1;$('#organizer-next').disabled=value||page>=pages;}
 async function change(request,button){
  if(busy||!owner)return;const id=owner,g=generation;setBusy(true);if(button)button.disabled=true;
  try{await api(`/assistants/${id}/organizer`,{kind,...request});if(g!==generation)return;resetForm();await list();toast('已保存');}
  catch(e){if(g===generation)toast(e.message);}finally{if(g===generation){setBusy(false);if(button)button.disabled=false;}}
 }
 function action(row,label,request){const b=el('button',label);b.type='button';b.className='secondary';const requestId=newRequestId();b.onclick=()=>change({...request,id:row.id,requestId},b);return b;}
 function edit(row){$('#organizer-form').hidden=false;editing=row.id;pending=null;$('#organizer-title-input').value=row.title;if(kind==='todo'){$('#organizer-priority').value=row.priority;$('#organizer-due').value=row.due_at?new Date(Date.parse(row.due_at)+8*3600000).toISOString().slice(0,16):'';$('#organizer-due').dataset.original=row.due_at||'';}else{$('#organizer-tags').value=row.tags.join(',');$('#organizer-type').value=row.kind;}fields();$('#organizer-title-input').focus();dialog.scrollTop=0;}
 async function list(){
  const id=owner,g=generation,k=kind;if(!id)return;const query=new URLSearchParams({kind:k,filter:$('#organizer-filter').value,page:String(page),q:$('#organizer-query').value,tag:k==='collection'?$('#organizer-tag-filter').value:''});
  try{const data=await api(`/assistants/${id}/organizer?${query}`);if(g!==generation||!dialog.open)return;pages=data.pages;if(page>pages){page=pages;return list();}
   $('#organizer-page').textContent=`第 ${page}/${pages} 页 · 共 ${data.total} 条`;const box=$('#organizer-list');box.replaceChildren();if(!data.items.length)box.append(el('p','暂无记录。'));
   for(const row of data.items){const card=el('article','');card.className='organizer-card';card.dataset.id=row.id;card.append(el('h3',row.title),el('small',`ID：${row.id}`));const actions=el('div','');actions.className='organizer-actions';
    if(k==='todo'){card.append(el('p',`${row.status==='done'?'已完成':'待办'} · 优先级${{high:'高',normal:'普通',low:'低'}[row.priority]}\n${time(row.due_at)}${row.due_at?'（北京时间）':''}`));if(row.status==='open'){actions.append(action(row,'完成',{action:'done'}));const b=el('button','编辑');b.className='secondary';b.onclick=()=>edit(row);actions.append(b);}}
    else{card.append(el('p',`${row.status==='read'?'已读':'稍后读'} · 标签：${row.tags.join('、')||'无'}`));if(row.kind==='link'){const a=el('a',row.content);a.href=row.content;a.target='_blank';a.rel='noopener noreferrer';card.append(a);}else{const details=el('details','');details.append(el('summary','查看内容'),el('p',row.content));card.append(details);}
     for(const a of row.attachments){if(!a.id||a.error)continue;const link=el('a','下载 '+a.name);link.href=`/api/assistants/${id}/attachments/${encodeURIComponent(a.id)}?download=1`;link.className='organizer-download';card.append(link);}
     actions.append(action(row,row.status==='read'?'设为稍后读':'标为已读',{action:row.status==='read'?'unread':'read'}));const b=el('button','编辑');b.className='secondary';b.onclick=()=>edit(row);actions.append(b);
    }
    const remove=action(row,'删除',{action:'remove'}),run=remove.onclick;remove.onclick=()=>{if(confirm(`删除「${row.title}」？`))run();};actions.append(remove);card.append(actions);box.append(card);
   }setBusy(busy);
  }catch(e){if(g===generation)toast(e.message);}
 }
 $('#organizer-form').onsubmit=e=>{e.preventDefault();if(busy)return;const body={action:editing?'update':'add',...(editing?{id:editing}:{}),title:$('#organizer-title-input').value.trim()};
  if(kind==='todo'){body.priority=$('#organizer-priority').value;const due=$('#organizer-due').value;body.dueAt=due?due+':00+08:00':null;if(editing&&due&&$('#organizer-due').dataset.original&&due===new Date(Date.parse($('#organizer-due').dataset.original)+8*3600000).toISOString().slice(0,16))delete body.dueAt;}
  else{body.tags=$('#organizer-tags').value.split(',').map(s=>s.trim()).filter(Boolean);if(!editing){body.type=$('#organizer-type').value;const value=$('#organizer-value').value.trim();body[{link:'url',message:'messageSeq',file:'attachmentId'}[body.type]]=body.type==='message'?Number(value):value;if(!body.title)delete body.title;}}
  const signature=JSON.stringify(body);if(pending?.signature!==signature)pending={signature,requestId:newRequestId()};void change({...body,requestId:pending.requestId});
 };
 $('#organizer-new').onclick=()=>{if(busy)return;resetForm();$('#organizer-form').hidden=false;$('#organizer-title-input').focus();};
 $('#organizer-edit-cancel').onclick=resetForm;
 $('#organizer-type').onchange=()=>{$('#organizer-value-label').textContent={link:'链接地址',message:'消息编号（历史搜索可查询）',file:'消息附件 ID'}[$('#organizer-type').value];};
 $('#organizer-search').onsubmit=e=>{e.preventDefault();if(busy)return;page=1;generation++;void list();};
 $('#organizer-filter').onchange=()=>{if(busy)return;page=1;generation++;void list();};
 $('#organizer-refresh').onclick=()=>{generation++;void list();};$('#organizer-prev').onclick=()=>{page--;generation++;void list();};$('#organizer-next').onclick=()=>{page++;generation++;void list();};
 $('#organizer-close').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{if(dialog.open)return;generation++;owner=null;pending=null;$('#organizer-list').replaceChildren();});
 $('#organizer-export').onclick=async()=>{const id=owner,g=generation;try{const result=await api(`/assistants/${id}/organizer`,{kind:'collection',action:'export'});if(g!==generation)return;const url=URL.createObjectURL(new Blob([JSON.stringify(result.items,null,2)],{type:'application/json'})),link=el('a','');link.href=url;link.download='wxbot-collections.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){if(g===generation)toast(e.message);}};
 return {
  async open(id,type){generation++;owner=id;kind=type;page=1;pages=1;busy=false;resetForm();$('#organizer-value-label').textContent='链接地址';$('#organizer-query').value='';$('#organizer-tag-filter').value='';$('#organizer-filter').replaceChildren(...(type==='todo'?[['open','未完成'],['today','今日及逾期'],['done','已完成'],['all','全部']]:[['all','全部'],['unread','稍后读'],['read','已读']]).map(([value,label])=>{const option=el('option',label);option.value=value;return option;}));$('#organizer-list').replaceChildren();setBusy(false);dialog.showModal();await list();},
  async saveMessage(id,seq,button){if(button.disabled)return;const key=id+':'+seq;let saved=bookmarks.get(key);if(!saved){saved={requestId:newRequestId()};bookmarks.set(key,saved);}button.disabled=true;if(saved.done){button.textContent='已收藏';toast('这条消息已收藏');return;}try{await api(`/assistants/${id}/organizer`,{kind:'collection',action:'add',type:'message',messageSeq:seq,requestId:saved.requestId});saved.done=true;button.textContent='已收藏';toast('已加入收藏箱');}catch(e){toast(e.message);button.disabled=false;}},
  reset(){generation++;owner=null;pending=null;editing=null;busy=false;dialog.close();$('#organizer-list').replaceChildren();$('#organizer-form').reset();}
 };
}
