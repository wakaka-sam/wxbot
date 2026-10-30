import {mkdir,open,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MAX_MEDIA_SIZE} from '../media.js';

const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const imageExtensions={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp'};

// Workspace writers are host-side. Anchor writes to opened directories so a
// sandbox-created symlink cannot redirect them into host files. Linux platform only.
export async function stageWorkspaceAttachment(workspace,{id,name='',mime,bytes},{signal}={}){
 signal?.throwIfAborted();
 if(!ID.test(id)||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_MEDIA_SIZE)throw new Error('附件标识或大小无效');
 const suffix=extname(name).toLowerCase(),extension=imageExtensions[mime]||(/^\.[a-z0-9]{1,12}$/.test(suffix)?suffix:'');
 const filename=id+extension;
 let root,dir,file,temp;
 try{
  await mkdir(workspace,{recursive:true,mode:0o700});
  const flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
  root=await open(workspace,flags);
  const incoming=`/proc/self/fd/${root.fd}/incoming`;
  try{await mkdir(incoming,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  dir=await open(incoming,flags);
  const anchor=`/proc/self/fd/${dir.fd}`;
  temp=anchor+'/.upload-'+randomUUID();
  file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await file.writeFile(bytes,{signal});await file.close();file=null;
  signal?.throwIfAborted();
  // Atomic replacement replaces a destination symlink itself, never its target.
  await rename(temp,join(anchor,filename));temp=null;
  return {relativePath:join('incoming',filename)};
 }catch(error){
  signal?.throwIfAborted();
  throw new Error('附件无法保存到助手工作区，请检查 incoming 目录或存储空间');
 }finally{
  await file?.close();if(temp)await unlink(temp).catch(()=>{});await dir?.close();await root?.close();
 }
}
