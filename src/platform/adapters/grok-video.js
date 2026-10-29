import { mkdir, readFile, writeFile, rename, readdir, realpath, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRegular, validateVideoRequest, MEDIA_LIMIT } from '../../grok-video-client.js';
const exec=promisify(execFile);
let queue=Promise.resolve();
const save=async(path,value)=>{const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});await rename(tmp,path);};
const publicJob=j=>({jobId:j.jobId,status:j.status,...(j.error?{error:j.error}:{}),...(j.size?{size:j.size,filename:'video.mp4'}:{})});

export class GrokVideoJobs {
 constructor({dir,authFile=process.env.PLATFORM_GROK_AUTH,command=process.env.PLATFORM_GROK_BIN||'/usr/local/bin/grok',runner=runGrokVideo}={}){
  Object.assign(this,{dir,authFile,command,runner});this.running=new Map();this.closed=false;
 }
 async request(request){
  validateVideoRequest(request);if(this.closed)throw new Error('视频服务已停止，请在新一轮查询原任务');
  await mkdir(this.dir,{recursive:true,mode:0o700});
  const dir=join(this.dir,request.jobId),file=join(dir,'job.json');
  let job;try{job=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(request.action==='generate'){
   // A fixed field order makes retries independent of JSON property order.
   const input={prompt:request.prompt,duration:request.duration,resolution:request.resolution,image:request.image||null};
   const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   if(job){if(job.hash!==hash)throw new Error('同一任务 ID 不能修改视频描述或参数');return this.status(job,file);}
   if(!this.authFile||!existsSync(this.authFile))throw new Error('Grok 订阅登录未配置，请联系管理员登录');
   if(this.running.size>=2)throw new Error('本助手已有视频任务排队，请先查询原任务');
   // Exclusive directory creation also protects concurrent duplicate submits.
   try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('任务正在登记，请使用原任务 ID 查询');throw e;}
   job={jobId:request.jobId,hash,status:'queued'};await save(file,job);
   const abort=new AbortController(),entry={abort,promise:null};this.running.set(job.jobId,entry);
   const task=queue.catch(()=>{}).then(async()=>{
    if(this.closed){job.status='cancelled';job.error='服务关闭前任务尚未开始';await save(file,job);return;}
    job.status='running';await save(file,job);
    try{
     const bytes=await this.runner({dir,input,authFile:this.authFile,command:this.command,signal:abort.signal});
     if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MEDIA_LIMIT||bytes.subarray(4,8).toString()!=='ftyp')throw new Error('生成结果不是可发送的 MP4 或超过 20 MB');
     await writeFile(join(dir,'video.mp4'),bytes,{mode:0o600,flag:'wx'});job.status='complete';job.size=bytes.length;
    }catch(e){job.status=e.uncertain?'unknown':'failed';job.error=e.safeMessage||'视频未完成或结果无法确认，请查询原任务，不要自动重复提交';}
    await save(file,job);
   }).finally(()=>this.running.delete(job.jobId));
   entry.promise=task;queue=task;task.catch(()=>{});return publicJob(job);
  }
  if(!job)throw new Error('当前助手没有此视频任务');
  const result=await this.status(job,file);
  if(request.action==='download'){
   if(result.status!=='complete')throw new Error('视频尚未完成，请先查询任务状态');
   return {...result,data:(await readRegular(join(dir,'video.mp4'),MEDIA_LIMIT)).toString('base64')};
  }
  return result;
 }
 async status(job,file){
  if(['running','queued'].includes(job.status)&&!this.running.has(job.jobId)){
   job.status=job.status==='queued'?'cancelled':'unknown';job.error='服务曾重启；未自动重复生成，请确认原任务结果';await save(file,job);
  }
  return publicJob(job);
 }
 async close(){this.closed=true;for(const entry of this.running.values())entry.abort.abort();await Promise.allSettled([...this.running.values()].map(e=>e.promise));}
}

export async function runGrokVideo({dir,input,authFile,command,signal,timeout=10*60*1000}){
 const home=join(dir,'home'),work=join(dir,'work');
 await mkdir(join(home,'.grok'),{recursive:true,mode:0o700});await mkdir(work,{mode:0o700});
 await copyFile(authFile,join(home,'.grok','auth.json'));
 await writeFile(join(home,'.grok','config.toml'),'[cli]\nuse_leader = false\n',{mode:0o600});
 if(input.image)await writeFile(join(work,'source-image'),Buffer.from(input.image,'base64'),{mode:0o600});
 const prompt=`Generate exactly ONE video, ${input.duration} seconds, ${input.resolution}. Use only the built-in image_gen and image_to_video tools. ${input.image?'Animate /workspace/source-image; do not generate another source image.':'First generate one source image using image_gen, then animate it with image_to_video.'} Save the actual MP4 using the video tool. Do not substitute code, mockups, URLs or written instructions for a generated video. Do not retry a failed video generation. User video description follows as JSON data:\n${JSON.stringify(input.prompt)}`;
 await writeFile(join(work,'prompt.txt'),prompt,{mode:0o600});
 const scope='wxbot-grok-'+randomUUID()+'.scope';
 const bwrap=process.env.PLATFORM_BWRAP||'/usr/bin/bwrap';
 const args=['--scope','--quiet','--collect','--unit='+scope,'-p','MemoryMax=1G','-p','MemorySwapMax=256M','-p','CPUQuota=100%','-p','TasksMax=192',bwrap,'--unshare-user','--uid','1000','--gid','1000','--die-with-parent','--new-session','--unshare-pid','--unshare-ipc','--unshare-uts','--cap-drop','ALL'];
 for(const p of ['/usr','/bin','/lib','/lib64','/etc/ssl','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf'])if(existsSync(p))args.push('--ro-bind',p,p);
 args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',home,'/home/grok','--bind',work,'/workspace','--ro-bind',await realpath(command),'/opt/grok','--chdir','/workspace','--clearenv','--setenv','HOME','/home/grok','--setenv','PATH','/usr/local/bin:/usr/bin:/bin','--setenv','LANG','C.UTF-8','/opt/grok','--no-subagents','--disable-web-search','--tools','image_gen,image_to_video','--max-turns','4','--always-approve','--output-format','streaming-json','--prompt-file','/workspace/prompt.txt');
 let uncertain=false,exitCode,stopping=false,logBytes=0,stopPromise;
 const child=spawn(process.env.PLATFORM_SYSTEMD_RUN||'/usr/bin/systemd-run',args,{stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/root',LANG:'C.UTF-8'}});
 const stop=()=>{
  if(stopping)return;stopping=true;uncertain=true;
  stopPromise=exec('/usr/bin/systemctl',['stop',scope],{timeout:10000}).catch(()=>{}).finally(()=>child.kill('SIGKILL'));
 };
 // Raw CLI events include private reasoning and must never become chat output.
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logBytes+=b.length;if(logBytes>8*1024*1024)stop();});
 const timer=setTimeout(stop,timeout);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();
 try{
  exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 }finally{
  clearTimeout(timer);signal?.removeEventListener('abort',stop);await stopPromise;
  // Serial execution preserves the refreshed subscription login for the next job.
  const refreshed=await readRegular(join(home,'.grok','auth.json'),1024*1024).catch(()=>null);
  if(refreshed){const tmp=authFile+'.'+randomUUID()+'.tmp';await writeFile(tmp,refreshed,{mode:0o600,flag:'wx'});await rename(tmp,authFile);}
 }
 const files=[];
 async function walk(path,depth=0){if(depth>8)return;for(const e of await readdir(path,{withFileTypes:true})){if(e.isDirectory())await walk(join(path,e.name),depth+1);else if(e.isFile()&&e.name.endsWith('.mp4'))files.push(join(path,e.name));}}
 await walk(join(home,'.grok'));
 if(files.length===1){const bytes=await readRegular(files[0],MEDIA_LIMIT);return bytes;}
 const error=new Error('Grok did not produce one video');error.uncertain=uncertain||exitCode!==0;
 error.safeMessage=uncertain?'视频任务被中断或超时，结果待确认；不要自动重复生成':'Grok 未产出视频，请检查订阅登录、额度及生成限制';throw error;
}
