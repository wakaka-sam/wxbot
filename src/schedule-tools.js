import { constants } from 'node:fs';
import { readFile,open } from 'node:fs/promises';
import { join } from 'node:path';
import { installFile } from './grok-video-tools.js';
export { SCHEDULE_INSTRUCTIONS, scheduleTurnHint } from './schedule-protocol.js';
async function verifyFile(home,parts,expected){
 const handles=[];
 try{
  let dir=await open(home,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(dir);
  for(const part of parts.slice(0,-1)){dir=await open(`/proc/self/fd/${dir.fd}/${part}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);handles.push(dir);}
  const file=await open(`/proc/self/fd/${dir.fd}/${parts.at(-1)}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);handles.push(file);
  const stat=await file.stat();if(!stat.isFile()||stat.size!==Buffer.byteLength(expected)||!(await file.readFile()).equals(Buffer.from(expected)))throw new Error('工具文件与当前版本不一致');
 }finally{for(const file of handles.reverse())await file.close();}
}
export async function installScheduleTools(home,{node=process.execPath,visibleHome='/home/assistant'}={}){
 for(const name of ['schedule-protocol.js','schedule-client.js','grok-video-client.js']){const content=await readFile(new URL('./'+name,import.meta.url)),parts=['.local','share','wxbot-tools',name];await installFile(home,parts,content,0o600);await verifyFile(home,parts,content);}
 await installFile(home,['.local','share','wxbot-tools','package.json'],'{"type":"module"}',0o600);
 const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
 await installFile(home,['.local','bin','wxbot-schedule'],`#!/bin/sh\nexport WXBOT_SCHEDULE_RELAY=${quote(join(visibleHome,'.local/share/wxbot-schedules'))}\nexec ${quote(node)} ${quote(join(visibleHome,'.local/share/wxbot-tools/schedule-client.js'))} "$@"\n`,0o700);
}
