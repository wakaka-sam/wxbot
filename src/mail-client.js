import { writeFile,rename,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readRegular,UUID } from './grok-video-client.js';
const args=process.argv.slice(2),request={action:args.shift()},opts={};
try{
 while(args.length){const k=args.shift();if(!['--turn','--accountId','--id','--search','--since','--unread','--offset'].includes(k)||!args.length||opts[k]!==undefined)throw new Error('Invalid mail argument');opts[k]=args.shift();}
 const turn=opts['--turn'];delete opts['--turn'];if(!UUID.test(turn||''))throw new Error('需要本轮 --turn 标识');
 for(const [k,v] of Object.entries(opts))request[k.slice(2)]=v;
 const dir=join(process.env.WXBOT_MAIL_RELAY,turn),id=randomUUID(),tmp=join(dir,id+'.tmp'),req=join(dir,id+'.req.json'),res=join(dir,id+'.res.json');
 try{
  await writeFile(tmp,JSON.stringify({turn,request}),{mode:0o600,flag:'wx'});await rename(tmp,req);
  const end=Date.now()+70000;let done=false;
  while(Date.now()<end){try{const r=JSON.parse((await readRegular(res,2*1024*1024)).toString());if(r.error)throw new Error(r.error);console.log(JSON.stringify(r));done=true;break;}catch(e){if(e.code!=='ENOENT')throw e;}await delay(100);}
  if(!done)throw new Error('邮件读取超时，请稍后重试');
 }finally{await rm(tmp,{force:true});await rm(res,{force:true});}
}catch(e){console.error(e.message);process.exitCode=1;}
