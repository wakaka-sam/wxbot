import { open, mkdir, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readRegular, REQUEST_LIMIT } from './grok-video-client.js';

// Anchor every directory through an fd and reject symlinks. The assistant can
// modify its home; no host-side request may follow its symlink out of that home.
export async function createVideoRelay(home,onRequest){
 const handles=[];let turn,path,closed=false,running,closing;
 try{
  let d=await open(home,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(d);
  turn=randomUUID();
  for(const part of ['.local','share','wxbot-video',turn]){
   const next=`/proc/self/fd/${d.fd}/${part}`;await mkdir(next,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   d=await open(next,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(d);
  }
  path=`/proc/self/fd/${d.fd}`;
 }catch(e){for(const h of handles.reverse())await h.close();throw e;}
 async function drain(){
  for(const name of (await readdir(path)).filter(n=>/^[a-f0-9-]{36}\.req\.json$/.test(n)).slice(0,8)){
   if(closed)break;let response;
   try{
    const body=JSON.parse((await readRegular(`${path}/${name}`,REQUEST_LIMIT)).toString());
    if(body.turn!==turn||Object.keys(body).some(k=>!['turn','request'].includes(k)))throw new Error('视频调用轮次无效');
    response=await onRequest(body.request);
   }catch(e){response={error:e.code?'视频请求读取失败':e.message};}
   const tmp=`${path}/${randomUUID()}.tmp`;
   await writeFile(tmp,JSON.stringify(response),{mode:0o600,flag:'wx'});
   await rename(tmp,`${path}/${name.replace('.req.json','.res.json')}`);await rm(`${path}/${name}`,{force:true});
  }
 }
 const timer=setInterval(()=>{if(!closed&&!running)running=drain().catch(()=>{}).finally(()=>{running=null;});},100);timer.unref();
 return{turn,close(){return closing??=(async()=>{closed=true;clearInterval(timer);await running;
  // Remove through the retained parent fd, never through a mutable home path.
  await rm(`/proc/self/fd/${handles.at(-2).fd}/${turn}`,{recursive:true,force:true});
  for(const h of handles.reverse())await h.close();
 })();}};
}
