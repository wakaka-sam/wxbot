export function createFileBrowser({api,toast}){
 const $=s=>document.querySelector(s),dialog=$('#files-dialog');
 let assistantId=null,readonly=false,memory=false,path='',next=null,selected=null,baseline='',dirty=false,version=0,loading=false,saving=false;
 const element=(tag,cls,text)=>{const e=document.createElement(tag);e.className=cls;if(text!=null)e.textContent=text;return e;};
 const endpoint=action=>`/assistants/${assistantId}/${action}`;
 const query=p=>'?path='+encodeURIComponent(p);
 const size=n=>n<1024?`${n} B`:n<1024*1024?`${(n/1024).toFixed(1)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
 const error=e=>{$('#files-error').textContent=e.message;$('#files-error').hidden=false;};
 const clearError=()=>{$('#files-error').hidden=true;};
 const discard=()=>!dirty||confirm('记忆文件有未保存的修改，确定放弃吗？');
 function controls(){
  $('#memory-new').hidden=!memory||readonly;$('#memory-save').disabled=saving||!dirty;$('#memory-delete').disabled=saving||!selected?.version;
  $('#memory-dirty').textContent=saving?'正在保存…':dirty?'有未保存的修改':'已保存';
  $('#files-refresh').disabled=loading||saving;$('#files-more').disabled=loading;
 }
 function resetDetail(){selected=null;baseline='';dirty=false;$('#memory-editor').value='';$('#file-text').textContent='';$('#file-detail').hidden=true;$('#file-empty').hidden=false;dialog.classList.remove('show-file');$('#file-image').removeAttribute('src');controls();}
 function renderEntry(e){
  const b=element('button','file-row');b.type='button';b.dataset.path=e.path;b.disabled=e.type==='blocked';
  const icon=element('span','file-icon',e.type==='directory'?'▸':e.memory?'M':'▤');const body=element('span','file-row-body');body.append(element('strong','',e.name),element('small','',e.type==='directory'?'文件夹':e.type==='blocked'?'链接或特殊文件不可访问':`${size(e.size)}${e.modifiedAt?' · '+new Date(e.modifiedAt).toLocaleString('zh-CN',{hour12:false}):''}`));b.append(icon,body);
  b.onclick=()=>{if(saving||!discard())return;e.type==='directory'?loadDirectory(e.path):openFile(e.path);};return b;
 }
 async function loadDirectory(folder,append=false){
  const request=++version,id=assistantId;loading=true;clearError();controls();if(!append){path=folder;resetDetail();$('#files-list').replaceChildren(element('p','muted','正在读取文件…'));}
  $('#files-path').textContent=folder?'/workspace/'+folder:'/workspace';$('#files-path').title=$('#files-path').textContent;$('#files-up').disabled=!folder;
  try{
   const data=await api(endpoint('files')+query(folder)+`&offset=${append?next:0}&memory=${memory?1:0}`);
   if(id!==assistantId||request!==version||!dialog.open)return;
   if(!append)$('#files-list').replaceChildren();$('#files-list').append(...data.entries.map(renderEntry));next=data.nextOffset;$('#files-more').hidden=next===null;
   if(!data.total)$('#files-list').append(element('p','file-empty',memory?'还没有记忆文件，点击「新建记忆」开始。':'此目录暂无文件'));
  }catch(e){if(request===version){error(e);if(!append)$('#files-list').replaceChildren();}}finally{if(request===version){loading=false;controls();}}
 }
 function renderFile(data){
  for(const row of $('#files-list').children)row.classList.toggle('selected',row.dataset.path===data.path);
  selected=data;baseline=data.text||'';dirty=false;$('#file-detail').hidden=false;$('#file-empty').hidden=true;dialog.classList.add('show-file');
  $('#file-name').textContent=data.name;$('#file-name').title=data.path;$('#file-meta').textContent=`${size(data.size)}${data.modifiedAt?' · 修改于 '+new Date(data.modifiedAt).toLocaleString('zh-CN',{hour12:false}):''}`;
  const link=$('#file-download');link.href='/api'+endpoint('files/download')+query(data.path);link.download=data.name;link.hidden=!data.version&&data.new;
  const editable=data.editable&&!readonly;$('#memory-editor').hidden=!editable;$('#memory-editor').value=baseline;$('#memory-hint').hidden=!editable;$('#memory-actions').hidden=!editable;
  $('#file-text').hidden=editable||data.text===null;$('#file-text').textContent=data.text||'';
  const image=data.text===null&&/\.(png|jpe?g|gif|webp)$/i.test(data.path)&&data.size<=20*1024*1024;
  $('#file-image').hidden=!image;if(image)$('#file-image').src='/api'+endpoint('files/image')+query(data.path);else $('#file-image').removeAttribute('src');
  $('#file-preview-note').textContent=data.truncated?'仅展示前 64 KB，请下载查看完整文件。':data.text===null&&!image?'此格式暂不支持在线预览，可以下载查看。':readonly?'管理员只读查看。':'';
  controls();
 }
 async function openFile(file){const request=++version,id=assistantId;clearError();resetDetail();try{const data=await api(endpoint('files/preview')+query(file));if(request!==version||id!==assistantId||!dialog.open)return;renderFile(data);}catch(e){if(request===version)error(e);}}
 function close(){if(saving||!discard())return;dialog.close();version++;}
 $('#files-close').onclick=close;dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
 $('#files-tab-all').onclick=()=>switchTab(false);$('#files-tab-memory').onclick=()=>switchTab(true);
 function switchTab(value){if(saving||!discard())return;memory=value;$('#files-tab-all').setAttribute('aria-selected',String(!value));$('#files-tab-memory').setAttribute('aria-selected',String(value));$('#files-description').textContent=value?'管理长期偏好与上下文，下一轮对话读取最新内容。':'上传的附件与助手生成的文件，都在这里。';$('#memory-new-form').hidden=true;loadDirectory('');}
 $('#files-refresh').onclick=()=>{if(discard())loadDirectory(path);};$('#files-up').onclick=()=>{if(!saving&&discard())loadDirectory(path.split('/').slice(0,-1).join('/'));};$('#files-more').onclick=()=>loadDirectory(path,true);
 $('#file-back').onclick=()=>{if(!saving&&discard()){resetDetail();version++;}};
 $('#memory-new').onclick=()=>{if(saving||!discard())return;$('#memory-new-form').hidden=false;$('#memory-path').value='MEMORY.md';$('#memory-path').focus();};$('#memory-new-cancel').onclick=()=>$('#memory-new-form').hidden=true;
 $('#memory-new-form').onsubmit=e=>{e.preventDefault();if(saving||!discard())return;const file=$('#memory-path').value.trim();if(!file){return;}$('#memory-new-form').hidden=true;renderFile({path:file,name:file.split('/').at(-1),text:'',size:0,editable:true,version:null,new:true});dirty=true;controls();$('#memory-editor').focus();};
 $('#file-image').onerror=()=>{$('#file-image').hidden=true;$('#file-preview-note').textContent='图片无法预览，请下载查看。';};
 $('#memory-editor').oninput=()=>{dirty=$('#memory-editor').value!==baseline||Boolean(selected?.new);controls();};
 $('#memory-save').onclick=async()=>{
  if(saving||readonly||!selected)return;const id=assistantId,file=selected.path,content=$('#memory-editor').value;saving=true;clearError();controls();
  try{const data=await api(endpoint('memory/save'),{path:file,content,version:selected.version});if(id!==assistantId)return;selected={...selected,version:data.version,new:false};baseline=content;dirty=$('#memory-editor').value!==content;toast('记忆已保存，下条消息生效');$('#file-download').hidden=false;if(!dirty){await loadDirectory(file.split('/').slice(0,-1).join('/'));await openFile(file);}}catch(e){error(e);}finally{saving=false;controls();}
 };
 $('#memory-delete').onclick=async()=>{
  if(saving||readonly||!selected?.version||!confirm(`确定删除记忆文件「${selected.name}」吗？`))return;saving=true;controls();clearError();
  try{await api(endpoint('memory/delete'),{path:selected.path,version:selected.version});dirty=false;toast('记忆文件已删除');await loadDirectory(path);}catch(e){error(e);}finally{saving=false;controls();}
 };
 window.addEventListener('beforeunload',e=>{if(dirty&&dialog.open){e.preventDefault();e.returnValue='';}});
 return{open(id,readOnly){assistantId=id;readonly=readOnly;version++;resetDetail();dialog.showModal();switchTab(false);},reset(){assistantId=null;version++;dirty=false;dialog.close();resetDetail();}};
}
