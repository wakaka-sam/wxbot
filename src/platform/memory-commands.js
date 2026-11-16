import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {AppError} from './store.js';
import {listWorkspace,previewWorkspaceFile,changeMemory,isMemoryPath} from './workspace-files.js';
import {submitCommand} from './commands.js';
const clip=s=>String(s).replace(/\s+/g,' ').slice(0,100);
export function submitMemoryCommand(engine,id,text,source,key,command,attachments){
 return engine.lock(`memory-command:${id}`,async()=>{
  const store=engine.store,hash=createHash('sha256').update(`${id}:${source}:${key}`).digest('hex'),sourceKey=`${source}:${key}`;
  if(attachments.length||store.db.prepare('SELECT id FROM messages WHERE assistant_id=? AND source_key=?').get(id,sourceKey))return submitCommand(engine,id,text,source,key,command,attachments);
  const resultKey=`memory-result:${hash}`,intentKey=`memory-intent:${hash}`;
  let outcome=store.get(resultKey);
  if(!outcome){
   const root=join(engine.dir,'assistants',id,'harness','workspace'),history=join(engine.dir,'assistants',id,'harness','memory-history');
   const preview=async path=>{try{return await previewWorkspaceFile(root,path);}catch(e){if(e.status===404)return null;throw e;}};
   const entries=async()=>[...(await listWorkspace(root,'',0,true)).entries,...(await listWorkspace(root,'memory',0,true)).entries].filter(e=>e.type==='file');
   try{
    const match=command.args.match(/^(\S+)(?:\s+([\s\S]*))?$/),action=match?.[1]||'list',value=(match?.[2]||'').trim();
    if(action==='list'){
     const page=value?Number(value):1;if(!Number.isSafeInteger(page)||page<1)throw new AppError(400,'用法：/memory list [页码]');
     const files=await entries(),pages=Math.max(1,Math.ceil(files.length/6));if(page>pages)throw new AppError(400,`只有 ${pages} 页`);
     const rows=[];for(const file of files.slice((page-1)*6,page*6)){const p=await preview(file.path);if(p)rows.push(`${file.path}\n${clip(p.text||'无法预览')}\n${file.path.match(/^memory\/quick-([a-f0-9]{64})\.md$/)?'删除：/memory delete '+file.path.slice(13,25):'查看：/memory show '+file.path}`);}
     outcome={text:rows.length?`记忆 · ${page}/${pages} 页\n`+rows.join('\n\n')+(page<pages?`\n下一页：/memory list ${page+1}`:'')+'\n完整目录及编辑请打开网页“文件与记忆”。':'还没有记忆。发送 /memory add 回复简短，保存一条偏好。'};
    }else if(action==='show'){
     const path=value||'MEMORY.md';if(!isMemoryPath(path))throw new AppError(400,'请选择 MEMORY.md、AGENTS.md 或 memory/ 下的记忆文件');
     const p=await preview(path);if(!p)throw new AppError(404,'记忆文件不存在');
     outcome={text:`${path}\n${p.text?.slice(0,2000)||'无法预览'}${p.truncated||p.text?.length>2000?'\n内容较长，请在网页查看全文。':''}`};
    }else if(action==='add'||action==='delete'){
     let intent=store.get(intentKey);
     if(!intent){
      if(action==='add'){
       if(!value||Buffer.byteLength(value)>2000||value.includes('\0'))throw new AppError(400,'记忆须为 1–2000 字节文本');
       const files=await entries();if(files.filter(e=>/^memory\/quick-/.test(e.path)).length>=100)throw new AppError(400,'快捷记忆最多 100 条，请先整理');
       intent={action,path:`memory/quick-${hash}.md`,content:value+'\n',version:null};
      }else{
       if(!/^[a-f0-9]{12,64}$/.test(value))throw new AppError(400,'请复制 /memory 列表中的删除命令；仅删除快捷创建的单条记忆');
       const files=(await entries()).filter(e=>e.path.startsWith('memory/quick-'+value)&&/^memory\/quick-[a-f0-9]{64}\.md$/.test(e.path));
       if(files.length!==1)throw new AppError(404,'找不到唯一的快捷记忆，请重新 /memory 查看');
       const p=await preview(files[0].path);if(!p?.editable)throw new AppError(409,'文件不可编辑，请在网页检查');
       intent={action,path:p.path,version:p.version};
      }
      // Durable intent freezes the exact version before crossing the filesystem boundary.
      store.set(intentKey,intent);
     }
     const current=await preview(intent.path);
     if(intent.action==='add'){
      if(!current)await changeMemory(root,history,{path:intent.path,content:intent.content,version:null});
      else if(current.text!==intent.content)throw new AppError(409,'这条记忆已被修改，不覆盖现有内容，请在网页检查');
      outcome={text:`已保存记忆：${clip(intent.content)}\n从下一轮回复开始读取。\n删除：/memory delete ${hash.slice(0,12)}`};
     }else{
      if(current)await changeMemory(root,history,{path:intent.path,version:intent.version,remove:true});
      outcome={text:'已删除这条快捷记忆。文件修改前已备份；历史对话中的内容仍保留。'};
     }
    }else throw new AppError(400,'用法：/memory；/memory add 内容；/memory show 文件路径；/memory delete 记忆ID');
   }catch(error){if(!(error instanceof AppError)||error.status>=500)throw error;outcome={text:'命令未执行：'+error.message,error:true};}
   store.set(resultKey,outcome);
  }
  return submitCommand(engine,id,text,source,key,command,attachments,outcome);
 });
}
