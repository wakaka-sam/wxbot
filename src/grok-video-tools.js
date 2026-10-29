import { mkdir, readFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

// Installation runs on the host, while an assistant can edit its home.
// Keep every write anchored to directory fds and reject symlink targets.
async function installFile(home,parts,content,mode){
 const handles=[];
 try{
  let d=await open(home,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(d);
  for(const part of parts.slice(0,-1)){
   const path=`/proc/self/fd/${d.fd}/${part}`;
   await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
   d=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(d);
  }
  const file=await open(`/proc/self/fd/${d.fd}/${parts.at(-1)}`,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,mode);handles.push(file);
  if(!(await file.stat()).isFile())throw new Error('工具安装目标须为普通文件');
  await file.truncate(0);await file.writeFile(content);await file.chmod(mode);
 }finally{for(const h of handles.reverse())await h.close();}
}
export async function installGrokVideoTools(home,{node=process.execPath,visibleHome='/home/assistant'}={}){
 await installFile(home,['.local','share','wxbot-tools','grok-video-client.js'],await readFile(new URL('./grok-video-client.js',import.meta.url)),0o600);
 await installFile(home,['.local','share','wxbot-tools','package.json'],'{"type":"module"}\n',0o600);
 await installFile(home,['.agents','skills','grok-video','SKILL.md'],await readFile(new URL('../skills/grok-video/SKILL.md',import.meta.url)),0o600);
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 await installFile(home,['.local','bin','grok-video'],`#!/bin/sh\nexport WXBOT_VIDEO_RELAY=${quote(join(visibleHome,'.local/share/wxbot-video'))}\nexec ${quote(node)} ${quote(join(visibleHome,'.local/share/wxbot-tools/grok-video-client.js'))} "$@"\n`,0o700);
}
