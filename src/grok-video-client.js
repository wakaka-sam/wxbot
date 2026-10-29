import { open, writeFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const MEDIA_LIMIT=20*1024*1024,REQUEST_LIMIT=Math.ceil(MEDIA_LIMIT/3)*4+32768;
export async function readRegular(path,limit){
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=await f.stat();if(!s.isFile()||s.size>limit)throw new Error('文件须为普通文件且不能超过大小上限');
  const b=Buffer.alloc(s.size+1);let n=0;
  while(n<b.length){const r=await f.read(b,n,b.length-n,null);if(!r.bytesRead)break;n+=r.bytesRead;}
  if(n!==s.size)throw new Error('读取期间文件发生变化');return b.subarray(0,n);
 }finally{await f.close();}
}
export function validateVideoRequest(r){
 if(!r||!UUID.test(r.jobId||'')||!['generate','status','download'].includes(r.action))throw new Error('视频任务请求无效');
 const keys=r.action==='generate'?['action','jobId','prompt','duration','resolution','image']:['action','jobId'];
 if(Object.keys(r).some(k=>!keys.includes(k)))throw new Error('视频请求包含不支持的字段');
 if(r.action!=='generate')return;
 if(typeof r.prompt!=='string'||!r.prompt.trim()||r.prompt.length>8000)throw new Error('视频描述须为 1–8000 字符');
 if(![6,10].includes(r.duration)||!['480p','720p'].includes(r.resolution))throw new Error('订阅 CLI 支持 6/10 秒及 480p/720p');
 if(r.image!==undefined){
  if(typeof r.image!=='string'||r.image.length>Math.ceil(MEDIA_LIMIT/3)*4||!r.image.length||Buffer.from(r.image,'base64').toString('base64')!==r.image)throw new Error('图片数据无效或超过 20 MB');
  const b=Buffer.from(r.image,'base64');
  if(b.length>MEDIA_LIMIT||!((b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)||b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))throw new Error('参考图仅支持 PNG/JPEG');
 }
}
export async function videoRequest(root,turn,request,{timeout=30000}={}){
 if(!root||!UUID.test(turn||''))throw new Error('需要本轮 grok-video --turn 标识');validateVideoRequest(request);
 const dir=join(root,turn),stem=randomUUID(),tmp=join(dir,stem+'.tmp'),req=join(dir,stem+'.req.json'),res=join(dir,stem+'.res.json');
 try{
  await writeFile(tmp,JSON.stringify({turn,request}),{mode:0o600,flag:'wx'});await rename(tmp,req);
  const end=Date.now()+timeout;
  while(Date.now()<end){
   try{const response=JSON.parse((await readRegular(res,REQUEST_LIMIT)).toString());if(response.error&&!response.status)throw new Error(response.error);return response;}
   catch(e){if(e.code!=='ENOENT')throw e;}await delay(100);
  }
  throw new Error(`回执超时；用 status ${request.jobId} 查询，不要更换任务 ID 重复生成`);
 }finally{await rm(tmp,{force:true});await rm(res,{force:true});}
}
export async function main(args,env=process.env){
 const action=args.shift();
 if(action==='--help'||!action){console.log('grok-video generate --turn UUID --request-id UUID --prompt-file FILE [--image FILE] [--duration 6|10] [--resolution 480p|720p]\ngrok-video status JOB_ID --turn UUID\ngrok-video download JOB_ID --turn UUID --output FILE');return;}
 const opts={},jobId=action==='generate'?null:args.shift();
 const allowed=['--turn','--request-id','--prompt-file','--image','--duration','--resolution','--output'];
 while(args.length){const k=args.shift();if(!allowed.includes(k)||!args.length||opts[k]!==undefined)throw new Error('命令参数无效');opts[k]=args.shift();}
 const r={action,jobId:jobId||opts['--request-id']};
 if(action==='generate'){
  if(!opts['--prompt-file'])throw new Error('使用 --prompt-file 传入视频描述');
  r.prompt=(await readRegular(opts['--prompt-file'],32768)).toString();r.duration=Number(opts['--duration']||6);r.resolution=opts['--resolution']||'480p';
  if(opts['--image'])r.image=(await readRegular(opts['--image'],MEDIA_LIMIT)).toString('base64');
 }
 if(action==='download'&&!opts['--output'])throw new Error('下载需要 --output 路径');
 const result=await videoRequest(env.WXBOT_VIDEO_RELAY,opts['--turn'],r);
 if(action==='download'){
  const {data,...meta}=result;if(typeof data!=='string')throw new Error('视频尚未生成完成');
  await writeFile(opts['--output'],Buffer.from(data,'base64'),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({...meta,path:opts['--output']}));
 }else console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=1;});
