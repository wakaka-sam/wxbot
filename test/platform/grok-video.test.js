import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GrokVideoJobs } from '../../src/platform/adapters/grok-video.js';
import { createVideoRelay } from '../../src/grok-video-relay.js';
import { installGrokVideoTools } from '../../src/grok-video-tools.js';
import { videoRequest, validateVideoRequest, readRegular } from '../../src/grok-video-client.js';
import { until } from './helpers.js';
const exec=promisify(execFile),MP4=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(12)]);
const input=()=>({action:'generate',jobId:randomUUID(),prompt:'纸船在水面漂浮',duration:6,resolution:'480p'});

test('视频任务幂等、串行执行、跨助手隔离与重启后下载',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-video-test-'));let jobs,other,resumed,finish;let calls=0;
 try{
  const authFile=join(dir,'auth.json');await writeFile(authFile,'{}');
  jobs=new GrokVideoJobs({dir:join(dir,'jobs'),authFile,runner:async()=>{calls++;await new Promise(r=>finish=r);return MP4;}});
  other=new GrokVideoJobs({dir:join(dir,'other'),authFile,runner:async()=>{calls++;return MP4;}});
  const request=input(),first=await jobs.request(request);assert.equal(first.jobId,request.jobId);
  await until(()=>finish);
  assert.equal((await jobs.request(request)).status,'running');assert.equal(calls,1);
  await assert.rejects(jobs.request({...request,prompt:'changed'}),/不能修改/);
  await assert.rejects(other.request({action:'download',jobId:request.jobId}),/当前助手/);
  const second=input();assert.equal((await other.request(second)).status,'queued');assert.equal(calls,1);
  finish();await until(()=>!jobs.running.size&&!other.running.size);assert.equal(calls,2);
  assert.equal((await jobs.request(request)).status,'complete');assert.equal(calls,2);
  await jobs.close();resumed=new GrokVideoJobs({dir:join(dir,'jobs'),authFile});
  assert.deepEqual(Buffer.from((await resumed.request({action:'download',jobId:request.jobId})).data,'base64'),MP4);
  const lost=input();await mkdir(join(dir,'jobs',lost.jobId));await writeFile(join(dir,'jobs',lost.jobId,'job.json'),JSON.stringify({jobId:lost.jobId,status:'running'}));
  assert.equal((await resumed.request({action:'status',jobId:lost.jobId})).status,'unknown');
 }finally{finish?.();await jobs?.close();await other?.close();await resumed?.close();await rm(dir,{recursive:true,force:true});}
});

test('视频命令经过当前轮次 relay，能跨轮查询下载且不覆盖文件',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-video-cli-'));let jobs,relay;
 try{
  const home=join(dir,'home');await mkdir(home);await installGrokVideoTools(home,{visibleHome:home});
  const authFile=join(dir,'auth.json');await writeFile(authFile,'{}');let calls=0;
  jobs=new GrokVideoJobs({dir:join(dir,'jobs'),authFile,runner:async()=>{calls++;return MP4;}});
  relay=await createVideoRelay(home,r=>jobs.request(r));
  const cli=join(home,'.local/bin/grok-video'),request=input(),prompt=join(dir,'prompt.txt');await writeFile(prompt,request.prompt);
  const generate=['generate','--turn',relay.turn,'--request-id',request.jobId,'--prompt-file',prompt];
  const r=JSON.parse((await exec(cli,generate)).stdout);assert.equal(r.jobId,request.jobId);
  await until(()=>!jobs.running.size);await relay.close();
  await assert.rejects(exec(cli,generate));
  relay=await createVideoRelay(home,r=>jobs.request(r));
  assert.equal(JSON.parse((await exec(cli,['status',request.jobId,'--turn',relay.turn])).stdout).status,'complete');
  const dest=join(dir,'video.mp4'),download=['download',request.jobId,'--turn',relay.turn,'--output',dest];
  await exec(cli,download);assert.deepEqual(await readFile(dest),MP4);await assert.rejects(exec(cli,download));assert.equal(calls,1);
  await Promise.all([relay.close(),relay.close()]);
 }finally{await relay?.close();await jobs?.close();await rm(dir,{recursive:true,force:true});}
});

test('视频 relay 拒绝越界参数、符号链接与伪造轮次，输入不解释为 shell',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-video-boundary-'));let relay;
 try{
  const home=join(dir,'home');await mkdir(home);
  await symlink(dir,join(home,'.local'));
  await assert.rejects(installGrokVideoTools(home));
  await assert.rejects(createVideoRelay(home,()=>{}));await rm(join(home,'.local'));
  let calls=0;relay=await createVideoRelay(home,async r=>{validateVideoRequest(r);calls++;return {status:'queued',jobId:r.jobId};});
  const root=join(home,'.local/share/wxbot-video'),request=input();
  await assert.rejects(videoRequest(root,relay.turn,{...request,command:'touch /tmp/escape'}),/字段/);
  await assert.rejects(videoRequest(root,relay.turn,{...request,jobId:'../../other'}),/无效/);
  await assert.rejects(videoRequest(root,relay.turn,{...request,image:Buffer.from('not an image').toString('base64')}),/PNG/);
  const reqId=randomUUID();await writeFile(join(root,relay.turn,reqId+'.req.json'),JSON.stringify({turn:randomUUID(),request}));
  await until(async()=>{try{return JSON.parse(await readFile(join(root,relay.turn,reqId+'.res.json'),'utf8')).error.includes('轮次');}catch{return false;}});assert.equal(calls,0);
  const secret=join(dir,'secret');await writeFile(secret,'SENSITIVE');const link=join(dir,'link');await symlink(secret,link);await assert.rejects(readRegular(link,100));
  await installGrokVideoTools(home,{visibleHome:home});
  const script=join(home,'.local/share/wxbot-tools/grok-video-client.js');await rm(script);await symlink(secret,script);
  await assert.rejects(installGrokVideoTools(home));assert.equal(await readFile(secret,'utf8'),'SENSITIVE');
  const response=await videoRequest(root,relay.turn,{...request,prompt:'$(touch /tmp/not-executed)\n`echo literal`'});assert.equal(response.status,'queued');assert.equal(calls,1);
 }finally{await relay?.close();await rm(dir,{recursive:true,force:true});}
});

test('生成取消或失败不会自动重试，不向助手泄漏内部异常',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-video-failure-'));let jobs;
 try{
  const authFile=join(dir,'auth.json');await writeFile(authFile,'{}');let called=false;
  jobs=new GrokVideoJobs({dir:join(dir,'jobs'),authFile,runner:({signal})=>new Promise((resolve,reject)=>{called=true;signal.addEventListener('abort',()=>reject(Object.assign(new Error('SECRET'),{uncertain:true})));})});
  const request=input();await jobs.request(request);await until(()=>called);await jobs.close();
  jobs=new GrokVideoJobs({dir:join(dir,'jobs'),authFile,runner:()=>{assert.fail('must not retry');}});
  const response=await jobs.request(request);assert.equal(response.status,'unknown');assert.ok(!JSON.stringify(response).includes('SECRET'));
 }finally{await jobs?.close();await rm(dir,{recursive:true,force:true});}
});
