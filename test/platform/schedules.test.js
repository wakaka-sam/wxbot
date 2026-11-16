import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile,readFile,symlink,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture,register,create,until } from './helpers.js';
import { normalizeSchedule,nextSchedule } from '../../src/platform/schedule-time.js';
import { createRequestRelay } from '../../src/request-relay.js';
import { installGrokVideoTools } from '../../src/grok-video-tools.js';
import { installScheduleTools } from '../../src/schedule-tools.js';
import { CodexHarness } from '../../src/platform/adapters/codex.js';

const input=(spec={type:'interval',minutes:30})=>({action:'add',requestId:randomUUID(),name:'喝水提醒',prompt:'提醒我喝水。',spec});
const stamp=s=>Date.parse(s);
function cli(command,turn,request){return new Promise((resolve,reject)=>{
 const p=spawn(command,['--turn',turn],{stdio:['pipe','pipe','pipe']});let out='',error='';
 p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>error+=c);p.on('error',reject);
 p.on('close',code=>code?reject(new Error(error)):resolve(JSON.parse(out)));p.stdin.end(JSON.stringify(request));
});}

test('calendar schedules use the requested timezone, weekday and DST policy',()=>{
 const daily=normalizeSchedule({type:'daily',time:'09:00'});
 assert.equal(new Date(nextSchedule(daily,stamp('2026-11-15T00:30:00Z'))).toISOString(),'2026-11-15T01:00:00.000Z');
 assert.equal(new Date(nextSchedule(daily,stamp('2026-11-15T01:00:00Z'))).toISOString(),'2026-11-16T01:00:00.000Z');
 const weekly=normalizeSchedule({type:'weekly',weekday:1,time:'09:00',timezone:'Asia/Kathmandu'});
 assert.equal(new Date(nextSchedule(weekly,stamp('2026-11-15T12:00:00Z'))).toISOString(),'2026-11-16T03:15:00.000Z');
 const spring=normalizeSchedule({type:'daily',time:'02:30',timezone:'America/New_York'});
 assert.equal(new Date(nextSchedule(spring,stamp('2026-03-08T05:00:00Z'))).toISOString(),'2026-03-09T06:30:00.000Z');
 const fall=normalizeSchedule({type:'daily',time:'01:30',timezone:'America/New_York'});
 assert.equal(new Date(nextSchedule(fall,stamp('2026-11-01T04:00:00Z'))).toISOString(),'2026-11-01T05:30:00.000Z');
 assert.equal(new Date(nextSchedule(fall,stamp('2026-11-01T05:30:00Z'))).toISOString(),'2026-11-02T06:30:00.000Z');
 assert.equal(nextSchedule({type:'interval',minutes:5},1000000,0),1200000);
 for(const spec of [{type:'interval',minutes:0},{type:'interval',minutes:1.5},{type:'daily',time:'24:00'},{type:'daily',time:'09:00',timezone:'invalid'},{type:'weekly',time:'09:00',weekday:7},{type:'once',at:'2099-01-01T09:00:00'},{type:'once',at:'2020-01-01T00:00:00Z'},{type:'daily',time:'09:00',userId:'other'}])assert.throws(()=>normalizeSchedule(spec));
});

test('new users can manage only their own tasks; creation is idempotent and survives restart',async()=>{
 const f=await fixture();try{
  const alice=await register(f),a=await create(alice),bob=await register(f,'bob'),b=await create(bob),url=`/api/assistants/${a}/schedules`;
  const request=input();const first=await alice.request(url,request);assert.equal(first.status,200);
  assert.equal((await alice.request(url,request)).data.task.id,first.data.task.id);
  assert.equal((await alice.request(url,{...request,prompt:'changed'})).status,409);
  assert.equal((await bob.request(url)).status,404);
  assert.equal((await bob.request(url,request)).status,404);
  assert.equal((await bob.request(`/api/assistants/${b}/schedules`,{action:'remove',id:first.data.task.id})).status,404);
  assert.equal((await alice.request(url,{...input(),assistantId:b})).status,400);
  const admin=f.client();await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'});
  assert.equal((await admin.request(url)).status,403);
  const adminId=await create(admin),adminTask=await admin.request(`/api/assistants/${adminId}/schedules`,input());
  assert.equal(adminTask.status,200);assert.equal(adminTask.data.task.assistant_id,adminId);
  assert.equal((await alice.request(`/api/assistants/${adminId}/schedules`)).status,404);
  await f.restart();const tasks=(await alice.request(url)).data.tasks;assert.equal(tasks.length,1);assert.equal(tasks[0].id,first.data.task.id);
  assert.equal((await alice.request(url,{action:'pause',id:tasks[0].id})).data.task.status,'paused');
  assert.equal((await alice.request(url,{action:'resume',id:tasks[0].id})).data.task.status,'active');
  assert.equal((await alice.request(url,{action:'remove',id:tasks[0].id})).data.task.status,'cancelled');
  assert.equal((await alice.request(url,{action:'resume',id:tasks[0].id})).status,409);
 }finally{await f.close();}
});

test('one-time due task waits offline, queues once, executes and sends only to its owner',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),now=Date.now(),request=input({type:'once',at:new Date(now+60000).toISOString()});
  const task=f.app.engine.schedules.request(id,request,now).task;
  f.app.engine.tickSchedules(now+120000);assert.equal(f.fake.runs.length,0);assert.equal(f.app.store.pending(id).length,0);
  const r=f.app.engine.runtimes.get(id);await r.channel.pair({id:'schedule-bot',userId:'schedule-owner'});
  for(let i=0;i<3;i++)f.app.engine.tickSchedules(now+120000);
  await until(()=>f.fake.runs.length===1&&!r.draining&&!r.delivering);
  assert.equal(f.app.engine.schedules.get(id,task.id).status,'completed');
  assert.equal(f.app.engine.schedules.list(id)[0].last_job_state,'done');
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) n FROM jobs WHERE schedule_id=?').get(task.id).n,1);
  assert(f.fake.sent.length>0);assert(f.fake.sent.every(s=>s.binding.userId==='schedule-owner'));
  await f.restart();f.app.engine.tickSchedules(now+3600000);assert.equal(f.fake.runs.length,1);
  assert.equal(f.app.engine.schedules.request(id,request,now+120000).duplicate,true);
 }finally{await f.close();}
});

test('scheduled work does not interrupt chat or merge with it, and missed periods coalesce',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  r.channel.input('WAIT active chat');await until(()=>r.harness.pending);
  const before=f.fake.interrupts.length,now=Date.now(),task=f.app.engine.schedules.request(id,input({type:'interval',minutes:1}),now).task;
  f.app.engine.tickSchedules(now+3600000);f.app.engine.tickSchedules(now+7200000);
  assert.equal(f.fake.interrupts.length,before);assert.equal(f.fake.runs.length,1);assert.equal(f.app.store.pending(id).length,1);
  r.harness.pending.resolve();await until(()=>f.fake.runs.length===2&&!r.draining);
  assert.match(f.fake.runs[1].text,/平台自动任务/);assert.doesNotMatch(f.fake.runs[1].text,/WAIT active chat/);
  // A new tick coalesces the additional elapsed period, never queues a backlog.
  f.app.engine.tickSchedules(now+7200000);await until(()=>f.fake.runs.length===3&&!r.draining);
  assert(f.app.engine.schedules.get(id,task.id).next_run_at>now+7200000);
 }finally{await f.close();}
});

test('pausing or cancelling cancels pending work, quota is bounded, interrupted jobs are not replayed',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),s=f.app.engine.schedules,now=Date.now();
  const recurring=s.request(id,input({type:'interval',minutes:1}),now).task;
  s.enqueue(recurring.id,now+60000);assert.equal(f.app.store.pending(id).length,1);
  s.request(id,{action:'pause',id:recurring.id});assert.equal(f.app.store.pending(id).length,0);
  const once=s.request(id,input({type:'once',at:new Date(now+60000).toISOString()}),now).task;
  s.enqueue(once.id,now+60000);s.request(id,{action:'remove',id:once.id});assert.equal(f.app.store.pending(id).length,0);
  const lost=s.request(id,input({type:'once',at:new Date(now+60000).toISOString()}),now).task;
  const run=s.enqueue(lost.id,now+60000);f.app.store.jobState(run.jobId,'running');
  await f.restart();assert.equal(f.app.engine.schedules.list(id).find(t=>t.id===lost.id).last_job_state,'interrupted');
  assert.equal(f.app.engine.schedules.get(id,lost.id).status,'completed');
  for(let i=0;i<19;i++)f.app.engine.schedules.request(id,input());
  assert.throws(()=>f.app.engine.schedules.request(id,input()),/20/);
 }finally{await f.close();}
});

test('tool requests use the current assistant and turn; scheduled runs cannot create more tasks',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  let oldRequest,task;
  r.harness.run=async({onSchedule})=>{oldRequest=onSchedule;task=onSchedule(input()).task;assert.equal(onSchedule({action:'list'}).tasks.length,1);};
  r.channel.input('每30分钟提醒我喝水');await until(()=>task&&!r.draining);
  assert.throws(()=>oldRequest(input()),/轮次/);
  let checked=false;
  r.harness.run=async({onSchedule})=>{assert.throws(()=>onSchedule(input()),/自动执行期间/);assert.equal(onSchedule({action:'list'}).tasks.length,1);checked=true;};
  f.app.engine.tickSchedules(task.next_run_at);await until(()=>checked&&!r.draining);
 }finally{await f.close();}
});

test('real CLI relay rejects stale turns and symlinks, preserving literal prompt text',async()=>{
 const f=await fixture();let relay;try{
  const c=await register(f),id=await create(c),home=join(f.dir,'tool-home');await mkdir(home);
  await installGrokVideoTools(home,{visibleHome:home});await installScheduleTools(home,{visibleHome:home});
  relay=await createRequestRelay(home,r=>f.app.engine.schedules.request(id,r),{namespace:'wxbot-schedules',label:'自动任务',maxBytes:65536});
  const executable=join(home,'.local/bin/wxbot-schedule'),request={...input(),prompt:'中文\n$(touch /tmp/never-run) `literal`'};
  const help=await promisify(execFile)(executable,['--help']);
  assert.match(help.stdout,/"spec":\{"type":"once","at":/);
  assert.match(help.stdout,/"name":/);assert.match(help.stdout,/"action":"list"/);
  assert.match(help.stdout,/pause\|resume\|remove/);
  await assert.rejects(cli(executable,relay.turn,{...input(),runAt:new Date(Date.now()+1800000).toISOString()}),/允许字段：action, requestId, name, prompt, spec/);
  const result=await cli(executable,relay.turn,request);assert.equal(result.task.prompt,request.prompt);
  assert.equal((await cli(executable,relay.turn,request)).duplicate,true);
  await assert.rejects(cli(executable,relay.turn,{...input(),userId:'other'}),/字段/);
  const reqId=randomUUID(),directory=join(home,'.local/share/wxbot-schedules',relay.turn);
  await writeFile(join(directory,reqId+'.req.json'),JSON.stringify({turn:randomUUID(),request}));
  await until(async()=>{try{return JSON.parse(await readFile(join(directory,reqId+'.res.json'),'utf8')).error;}catch{return false;}});
  const turn=relay.turn;await relay.close();await assert.rejects(cli(executable,turn,input()));
  await rm(join(home,'.local/share/wxbot-schedules'),{recursive:true});await symlink(f.dir,join(home,'.local/share/wxbot-schedules'));
  await assert.rejects(createRequestRelay(home,()=>{},{namespace:'wxbot-schedules'}));
 }finally{await relay?.close();await f.close();}
});

test('Harness exposes current time and schedule CLI relay for natural-language chat',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),dir=join(f.dir,'synthetic-harness'),home=join(dir,'home');await mkdir(home,{recursive:true});
  await installGrokVideoTools(home,{visibleHome:home});await installScheduleTools(home,{visibleHome:home});
  const h=Object.create(CodexHarness.prototype);let called=false;
  Object.assign(h,{dir,cwd:f.dir,threadId:'synthetic-thread',client:{async run({input}){
   assert.match(input[0].text,/本轮当前时间：/);
   // The resumed thread may retain its original developer instructions. The
   // current turn must be independently sufficient to construct the request.
   assert.match(input[0].text,/"spec":\{"type":"once","at":/);
   assert.match(input[0].text,/wxbot-schedule --help/);
   assert.match(input[0].text,/"action":"list"/);
   const turn=input[0].text.match(/wxbot-schedule --turn ([a-f0-9-]{36})/)[1];
   const example=input[0].text.split('\n').find(line=>line.startsWith('{"action":"add"')&&line.includes('"type":"once"'));
   const request=JSON.parse(example);request.requestId=randomUUID();
   const receipt=await cli(join(home,'.local/bin/wxbot-schedule'),turn,request);
   assert.equal(receipt.task.spec.type,'once');called=true;return {text:'创建成功'};
  }}});
  await h.run({text:'每天早上9点提醒我喝水',onEvent:()=>{},onSchedule:r=>f.app.engine.schedules.request(id,r)});assert(called);
 }finally{await f.close();}
});
