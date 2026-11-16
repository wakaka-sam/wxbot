import { scheduleHelp } from './schedule-protocol.js';
import { writeFile,rename,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readRegular,UUID } from './grok-video-client.js';

// JSON on stdin keeps task prompts out of shell interpolation and process args.
try{
 const args=process.argv.slice(2);
 if(args.length===1&&['--help','-h'].includes(args[0])){console.log(scheduleHelp());process.exit(0);}
 if(args.length!==2||args[0]!=='--turn'||!UUID.test(args[1]))throw new Error('用法：wxbot-schedule --turn 本轮UUID < request.json');
 const turn=args[1],chunks=[];let size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>60000)throw new Error('请求过大');chunks.push(chunk);}
 const request=JSON.parse(Buffer.concat(chunks).toString());
 const dir=join(process.env.WXBOT_SCHEDULE_RELAY,turn),id=randomUUID(),tmp=join(dir,id+'.tmp'),req=join(dir,id+'.req.json'),res=join(dir,id+'.res.json');
 try{
  await writeFile(tmp,JSON.stringify({turn,request}),{mode:0o600,flag:'wx'});await rename(tmp,req);
  const end=Date.now()+15000;let done=false;
  while(Date.now()<end){
   try{const r=JSON.parse((await readRegular(res,2*1024*1024)).toString());if(r.error)throw new Error(r.error);console.log(JSON.stringify(r));done=true;break;}
   catch(e){if(e.code!=='ENOENT')throw e;}await delay(100);
  }
  if(!done)throw new Error('请求结果未确认：先 list 核实，重试 add 必须复用原 requestId');
 }finally{await rm(tmp,{force:true});await rm(res,{force:true});}
}catch(e){console.error(e.message+'\n参数格式和完整示例：运行 wxbot-schedule --help。不要猜测字段，也不要更换 requestId 盲目重试。');process.exitCode=1;}
