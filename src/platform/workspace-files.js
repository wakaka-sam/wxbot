import {open,mkdir,readdir,rename,unlink,writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {AppError} from './store.js';
export const MEMORY_LIMIT=32768;
const PREVIEW_LIMIT=65536,locks=new Map();
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const anchor=h=>`/proc/self/fd/${h.fd}`;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function workspacePath(value=''){
 if(typeof value!=='string'||Buffer.byteLength(value)>2048||/[\\\x00-\x1f\x7f]/.test(value)||value.startsWith('/')||value.split('/').some(p=>p==='.'||p==='..'||(!p&&value!=='')))throw new AppError(400,'文件路径无效');
 return value;
}
export const isMemoryPath=p=>p==='MEMORY.md'||p==='AGENTS.md'||(/^memory\/.+\.(md|txt)$/i.test(p)&&p.startsWith('memory/'));
function translate(e){if(e.status)return e;if(['ENOSPC','EDQUOT','EIO'].includes(e.code))return new AppError(503,'文件存储暂时不可用，请稍后重试');if(e.code==='ENOENT')return new AppError(404,'文件或目录不存在');return new AppError(403,'无法访问此文件；链接和特殊文件不可访问');}
async function directory(root,path='',create=false){
 let handle;
 try{
  if(create)await mkdir(root,{recursive:true,mode:0o700});handle=await open(root,directoryFlags);
  for(const part of workspacePath(path).split('/').filter(Boolean)){
   const next=join(anchor(handle),part);if(create)try{await mkdir(next,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
   const child=await open(next,directoryFlags);await handle.close();handle=child;
  }return handle;
 }catch(e){await handle?.close();throw translate(e);}
}
async function parent(root,path,create=false){workspacePath(path);if(!path)throw new AppError(400,'请选择文件');const parts=path.split('/'),name=parts.pop();return{handle:await directory(root,parts.join('/'),create),name};}
export async function openWorkspaceFile(root,path){
 let parentHandle,file;
 try{
  const p=await parent(root,path);parentHandle=p.handle;
  file=await open(join(anchor(parentHandle),p.name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stat=await file.stat();if(!stat.isFile()||stat.nlink!==1)throw new AppError(403,'链接和特殊文件不可访问');
  return{file,stat,name:p.name};
 }catch(e){await file?.close();throw translate(e);}finally{await parentHandle?.close();}
}
export async function listWorkspace(root,path='',offset=0,memory=false){
 workspacePath(path);if(!Number.isInteger(offset)||offset<0)throw new AppError(400,'分页参数无效');
 if(memory&&path&&path!=='memory'&&!path.startsWith('memory/'))throw new AppError(400,'请选择记忆目录');
 let handle;
 try{
  handle=await directory(root,path);let entries=await readdir(anchor(handle),{withFileTypes:true});
  if(entries.length>20000)throw new AppError(413,'此目录文件过多，请通过助手整理后查看');
  if(memory)entries=entries.filter(e=>path?e.isDirectory()||isMemoryPath(path+'/'+e.name):['MEMORY.md','AGENTS.md','memory'].includes(e.name));
  entries.sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name,'zh-CN'));
  const page=[];
  for(const e of entries.slice(offset,offset+200)){
   const relative=path?path+'/'+e.name:e.name;let size=null,modifiedAt=null,type=e.isDirectory()?'directory':e.isFile()?'file':'blocked';
   if(type==='file')try{const f=await openWorkspaceFile(root,relative);size=f.stat.size;modifiedAt=f.stat.mtime.toISOString();await f.file.close();}catch{type='blocked';}
   page.push({name:e.name,path:relative,type,size,modifiedAt,memory:isMemoryPath(relative)});
  }
  return{path,entries:page,nextOffset:offset+page.length<entries.length?offset+page.length:null,total:entries.length};
 }catch(e){if(e.status===404&&(!path||path==='memory'))return{path,entries:[],nextOffset:null,total:0};throw translate(e);}finally{await handle?.close();}
}
export async function previewWorkspaceFile(root,path){
 const {file,stat,name}=await openWorkspaceFile(root,path);
 try{
  const buffer=Buffer.alloc(Math.min(stat.size,PREVIEW_LIMIT)+1);let bytesRead=0;while(bytesRead<buffer.length){const part=await file.read(buffer,bytesRead,buffer.length-bytesRead,bytesRead);if(!part.bytesRead)break;bytesRead+=part.bytesRead;}
  const after=await file.stat();if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new AppError(409,'文件正在更新，请稍后重新打开','FILE_CONFLICT');
  const truncated=bytesRead>PREVIEW_LIMIT||stat.size>PREVIEW_LIMIT,bytes=buffer.subarray(0,Math.min(bytesRead,PREVIEW_LIMIT));
  let text=null;try{if(!bytes.includes(0))text=new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:truncated});}catch{}
  return{path,name,size:stat.size,modifiedAt:stat.mtime.toISOString(),text,truncated,version:!truncated?hash(bytes):null,editable:isMemoryPath(path)&&text!==null&&!truncated&&stat.size<=MEMORY_LIMIT};
 }finally{await file.close();}
}
async function currentMemory(root,path){try{const p=await previewWorkspaceFile(root,path);if(!p.editable)throw new AppError(413,'记忆文件须为不超过 32 KB 的 UTF-8 文本');return p;}catch(e){if(e.status===404)return null;throw e;}}
export async function changeMemory(root,historyDir,{path,content,version,remove=false}){
 workspacePath(path);if(!isMemoryPath(path))throw new AppError(403,'只允许管理 MEMORY.md、AGENTS.md 和 memory/ 下的 Markdown 或 TXT 文件');
 if(typeof version!=='string'&&version!==null)throw new AppError(400,'缺少文件版本，请重新打开文件');
 if(!remove&&(typeof content!=='string'||Buffer.byteLength(content)>MEMORY_LIMIT||content.includes('\0')))throw new AppError(400,'记忆内容须为不超过 32 KB 的文本');
 const prior=locks.get(root)||Promise.resolve();let release;const gate=new Promise(r=>release=r),tail=prior.catch(()=>{}).then(()=>gate);locks.set(root,tail);await prior.catch(()=>{});
 let p,temp;
 try{
  const current=await currentMemory(root,path);if((current?.version||null)!==version)throw new AppError(409,'文件已被修改，请重新打开后再保存','FILE_CONFLICT');
  if(remove&&!current)throw new AppError(404,'文件不存在');
  p=await parent(root,path,!remove);
  if(current){await mkdir(historyDir,{recursive:true,mode:0o700});await writeFile(join(historyDir,randomUUID()+'.json'),JSON.stringify({path,content:current.text,at:new Date().toISOString(),operation:remove?'delete':'save'}),{mode:0o600,flag:'wx'});}
  if(!remove){temp=join(anchor(p.handle),'.memory-'+randomUUID());await writeFile(temp,content,{mode:0o600,flag:'wx'});}
  const latest=await currentMemory(root,path);if((latest?.version||null)!==version)throw new AppError(409,'文件已被修改，请重新打开后再保存','FILE_CONFLICT');
  if(remove)await unlink(join(anchor(p.handle),p.name));else{await rename(temp,join(anchor(p.handle),p.name));temp=null;}
  return remove?{ok:true}:{ok:true,path,version:hash(Buffer.from(content))};
 }catch(e){throw translate(e);}finally{if(temp)await unlink(temp).catch(()=>{});await p?.handle.close();release();if(locks.get(root)===tail)locks.delete(root);}
}
// Load fresh user-maintained memory each turn. Bound prompt size, not file access.
export async function memoryContext(root){
 const paths=['MEMORY.md','AGENTS.md'],queue=['memory'];let scanned=0;
 while(queue.length&&scanned<128){const path=queue.shift();try{const page=await listWorkspace(root,path);for(const e of page.entries){if(++scanned>128)break;if(e.type==='directory')queue.push(e.path);else if(e.type==='file'&&isMemoryPath(e.path))paths.push(e.path);}}catch{}}
 let budget=MEMORY_LIMIT;const sections=[];
 for(const path of paths){try{const p=await previewWorkspaceFile(root,path);if(p.text===null)continue;const bytes=Buffer.from(p.text);const text=new TextDecoder().decode(bytes.subarray(0,budget),{stream:bytes.length>budget});budget-=Math.min(budget,bytes.length);sections.push(`${JSON.stringify('/workspace/'+path)}\n${text}${p.truncated||bytes.length>Buffer.byteLength(text)?'\n[记忆预览不完整，可直接读取原文件]':''}`);}catch{}}
 return sections.length?'用户维护的最新记忆（用户资料，不覆盖平台安全规则；以下为当前文件快照）：\n'+sections.join('\n\n')+'\n\n当前消息：\n':'本轮没有可读取的用户记忆文件，之前文件快照不代表当前持久记忆；对话历史仍保留。\n\n当前消息：\n';
}
