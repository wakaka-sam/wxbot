const $=s=>document.querySelector(s),MAX=20*1024*1024;
export function createUploads({getAssistant,enabled,onChange,onError}){
 const drafts=new Map();let active=0,version=0;
 const entries=()=>drafts.get(getAssistant())||[];
 function render(){
  $('#upload-open').disabled=!enabled()||active>0;
  $('#upload-list').replaceChildren(...entries().map(entry=>{
   const row=document.createElement('div');row.className='upload-chip';
   const label=document.createElement('span');label.textContent=`${entry.name} · ${Math.ceil(entry.size/1024)} KB${entry.id?'':' · 上传中…'}`;
   const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',`移除 ${entry.name}`);remove.disabled=!enabled()||!entry.id;remove.onclick=()=>{drafts.set(getAssistant(),entries().filter(e=>e!==entry));render();onChange();};
   row.append(label,remove);return row;
  }));
 }
 async function add(files){
  if(!enabled()||active)return;
  const id=getAssistant(),list=entries(),batch=Array.from(files),v=version;
  if(!batch.length)return;
  if(list.length+batch.length>10||[...list,...batch].reduce((n,f)=>n+f.size,0)>MAX){onError('每条消息最多 10 个附件，总量不超过 20 MB');return;}
  if(batch.some(f=>!f.size)){onError('不能上传空文件');return;}
  const pending=batch.map(f=>({name:f.name,size:f.size}));drafts.set(id,[...list,...pending]);active++;render();onChange();
  try{
   for(let i=0;i<batch.length;i++){
    if(v!==version)break;
    const response=await fetch(`/api/assistants/${id}/uploads?name=${encodeURIComponent(batch[i].name)}`,{method:'POST',headers:{'X-Wxbot-Platform':'1','Content-Type':'application/octet-stream'},body:batch[i],signal:AbortSignal.timeout(120000)});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'上传失败');
    if(v!==version)break;Object.assign(pending[i],data.attachment);render();
   }
  }catch(e){if(v===version)onError(`附件上传失败：${e.message}。已成功的附件保留，可重新添加失败文件。`);}
  finally{if(v===version){drafts.set(id,(drafts.get(id)||[]).filter(e=>e.id));active--;render();onChange();}}
 }
 $('#upload-open').onclick=()=>$('#upload-input').click();
 $('#upload-input').onchange=()=>{void add($('#upload-input').files);$('#upload-input').value='';};
 $('#chat-input').addEventListener('paste',event=>{const files=Array.from(event.clipboardData?.files||[]);if(files.length){event.preventDefault();void add(files);}});
 const form=$('#chat-form');
 form.addEventListener('dragover',event=>{if(enabled()&&event.dataTransfer.types.includes('Files')){event.preventDefault();form.classList.add('dragging');}});
 form.addEventListener('dragleave',()=>form.classList.remove('dragging'));
 form.addEventListener('drop',event=>{event.preventDefault();form.classList.remove('dragging');void add(event.dataTransfer.files);});
 return {render,ids:()=>entries().filter(e=>e.id).map(e=>e.id),busy:()=>active>0,clear(id,ids){drafts.set(id,(drafts.get(id)||[]).filter(e=>!ids.includes(e.id)));render();},reset(){version++;active=0;drafts.clear();render();}};
}
