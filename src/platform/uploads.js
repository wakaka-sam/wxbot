import { mkdir,open,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_MEDIA_SIZE,describeMedia } from '../media.js';
import { AppError } from './store.js';
import { normalizeAttachments,readChannelAttachment,MEDIA_ID } from './attachments.js';
// Originals live outside the writable assistant sandbox. Only server-generated IDs
// cross the API boundary; metadata is always looked up under the current owner.
export class Uploads {
 constructor(store,dir){
  this.store=store;this.db=store.db;this.dir=dir;
  this.db.exec(`CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL REFERENCES assistants(id),metadata TEXT,state TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(assistant_id,state,created_at);`);
 }
 root(id){return join(this.dir,'assistants',id,'uploads');}
 has(id,fileId){return Boolean(this.db.prepare("SELECT 1 FROM uploads WHERE assistant_id=? AND id=? AND state IN ('ready','claimed')").get(id,fileId));}
 async receive(id,name,stream){
  const fileId=randomUUID(),created=Date.now(),max=MAX_MEDIA_SIZE;
  this.store.tx(()=>{
   const pending=this.db.prepare("SELECT COALESCE(SUM(size),0) bytes,COUNT(*) count FROM uploads WHERE assistant_id=? AND state IN ('uploading','ready')").get(id);
   if(pending.bytes+max>100*1024*1024||pending.count>=20)throw new AppError(429,'未发送的附件过多，请先发送现有附件或稍后再试');
   this.db.prepare("INSERT INTO uploads VALUES(?,?,NULL,'uploading',?,?)").run(fileId,id,max,created);
  });
  const media=join(this.root(id),'media'),path=join(media,fileId);let file,size=0,head=Buffer.alloc(0);
  try{
   await mkdir(media,{recursive:true,mode:0o700});file=await open(path,'wx',0o600);
   for await(const chunk of stream){size+=chunk.length;if(size>max)throw new AppError(413,'每个文件最多 20 MB');if(head.length<512)head=Buffer.concat([head,chunk.subarray(0,512-head.length)]);await file.writeFile(chunk);}
   if(!size)throw new AppError(400,'不能上传空文件');
   await file.close();file=null;
   const safeName=normalizeAttachments([{id:fileId,name}])[0].name;
   const description=describeMedia(head,safeName),metadata=normalizeAttachments([{id:fileId,name:safeName,size,...description}])[0];
   this.db.prepare("UPDATE uploads SET metadata=?,size=?,state='ready' WHERE id=?").run(JSON.stringify(metadata),size,fileId);
   return metadata;
  }catch(error){await file?.close();await unlink(path).catch(()=>{});this.db.prepare('DELETE FROM uploads WHERE id=?').run(fileId);throw error;}
 }
 resolve(id,ids=[]){
  if(!Array.isArray(ids)||ids.length>10)throw new AppError(400,'每条消息最多 10 个附件');
  const result=ids.map(fileId=>{
   if(typeof fileId!=='string'||!MEDIA_ID.test(fileId))throw new AppError(400,'附件标识无效');
   const row=this.db.prepare("SELECT * FROM uploads WHERE assistant_id=? AND id=? AND state IN ('ready','claimed')").get(id,fileId);
   if(!row)throw new AppError(404,'附件不存在或已过期，请重新上传');return JSON.parse(row.metadata);
  });
  if(new Set(ids).size!==ids.length)throw new AppError(400,'同一个附件不能重复添加');
  if(result.reduce((n,a)=>n+a.size,0)>MAX_MEDIA_SIZE)throw new AppError(413,'每条消息附件总量最多 20 MB');
  return result;
 }
 claim(id,files){for(const file of files)this.db.prepare("UPDATE uploads SET state='claimed' WHERE assistant_id=? AND id=? AND state='ready'").run(id,file.id);}
 async read(id,fileId){if(!this.has(id,fileId))throw new AppError(404,'附件不存在');return readChannelAttachment(this.root(id),fileId);}
 async cleanup({recover=false}={}){
  // Claim/delete is synchronous before filesystem awaits, so a cleanup cannot
  // delete a file which a concurrently submitted message just claimed.
  const expired=this.db.prepare("DELETE FROM uploads WHERE (state IN ('ready','uploading') AND created_at<?) OR (state='uploading' AND ?) RETURNING id,assistant_id").all(Date.now()-86400000,recover?1:0);
  for(const row of expired)await unlink(join(this.root(row.assistant_id),'media',row.id)).catch(()=>{});
 }
}
