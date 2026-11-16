import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,register,create,until } from './helpers.js';
import { normalizeSchedule,nextSchedule } from '../../src/platform/schedule-time.js';
import { CodexClient } from '../../src/codex-client.js';
const input=(extra={})=>({action:'add',requestId:randomUUID(),name:'提醒',prompt:'该喝水了。',mode:'reminder',spec:{type:'interval',minutes:1},...extra});
const iso=n=>new Date(n).toISOString();

test('工作日、月末、截止时间和编辑后的间隔锚点',async()=>{
 const friday=Date.parse('2026-11-13T02:00:00Z');
 assert.equal(iso(nextSchedule(normalizeSchedule({type:'workdays',time:'09:00'}),friday)),'2026-11-16T01:00:00.000Z');
 assert.equal(iso(nextSchedule(normalizeSchedule({type:'monthly',day:31,time:'09:00'}),Date.parse('2026-04-01T00:00:00Z'))),'2026-05-31T01:00:00.000Z');
 const spec=normalizeSchedule({type:'daily',time:'09:00',until:'2026-11-14T02:00:00Z'},friday);
 assert.equal(nextSchedule(spec,Date.parse('2026-11-14T02:00:00Z')),null);
 assert.throws(()=>normalizeSchedule({type:'monthly',day:32,time:'09:00'}));
 assert.throws(()=>normalizeSchedule({type:'interval',minutes:60,until:iso(friday+1000)},friday),/截止/);
 const f=await fixture();try{
  const c=await register(f),id=await create(c),s=f.app.engine.schedules,t=s.request(id,input(),friday).task;
  const revised=s.request(id,{action:'update',id:t.id,version:t.version,name:'新',prompt:'新正文',mode:'reminder',spec:{type:'interval',minutes:2}},friday+30000).task;
  assert.equal(revised.next_run_at,friday+150000);s.enqueue(t.id,friday+150000);
  assert.equal(s.get(id,t.id).next_run_at,friday+270000);
 }finally{await f.close();}
});

test('编辑乐观锁、创建重试以及手动执行幂等且不改变原计划',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),s=f.app.engine.schedules,req=input(),t=s.request(id,req).task;
  const updated=s.request(id,{action:'update',id:t.id,version:t.version,name:'新提醒',prompt:'起身走走',mode:'reminder',spec:{type:'daily',time:'09:00'}}).task;
  assert.throws(()=>s.request(id,{action:'update',id:t.id,version:t.version,...req}),/字段/);
  assert.throws(()=>s.request(id,{action:'update',id:t.id,version:t.version,name:'旧',prompt:'旧',spec:t.spec}),/变化/);
  assert.equal(s.request(id,req).task.name,'新提醒');
  const run={action:'run',id:t.id,requestId:randomUUID()},first=s.request(id,run);
  assert.equal(s.request(id,run).jobId,first.jobId);assert.equal(s.get(id,t.id).next_run_at,updated.next_run_at);
  assert.throws(()=>s.request(id,{...run,requestId:randomUUID()}),/等待/);
  assert.throws(()=>s.request(id,{action:'update',id:t.id,version:updated.version,name:'更改',prompt:'更改',spec:t.spec}),/排队/);
  const bob=await register(f,'bob');assert.equal((await bob.request(`/api/assistants/${id}/schedules/${t.id}/runs`)).status,404);
 }finally{await f.close();}
});

test('轻量提醒完全绕过执行器，记录生成结果与等待额度到送达，重启不重复',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  r.harness.prepare=()=>{throw new Error('轻量提醒不应准备模型');};
  r.channel.send=async()=>({status:'blocked',budgetEpoch:0,error:'回复额度不足'});
  const t=f.app.engine.schedules.request(id,input()).task;
  const req={action:'run',id:t.id,requestId:randomUUID()};const result=await c.request(`/api/assistants/${id}/schedules`,req);assert.equal(result.status,200);
  await until(()=>!r.draining&&!r.delivering&&f.app.engine.schedules.list(id)[0].last_job_state==='done');
  let history=(await c.request(`/api/assistants/${id}/schedules/${t.id}/runs`)).data;
  assert.equal(history.runs.length,1);assert.equal(history.runs[0].execution_mode,'reminder');assert.equal(history.runs[0].messages[0].text,'该喝水了。');assert(history.runs[0].started_at&&history.runs[0].finished_at);
  assert.equal(history.runs[0].deliveries[0].state,'pending');assert.match(history.runs[0].deliveries[0].error,/额度/);assert(!JSON.stringify(history).includes('binding'));
  r.channel.send=async()=>({status:'sent'});r.blockedQuotaEpoch=null;f.app.engine.deliver(id);await until(()=>!r.delivering);
  history=f.app.engine.schedules.history(id,t.id);assert.equal(history.runs[0].deliveries[0].state,'sent');
  await f.restart();assert.equal(f.app.engine.schedules.history(id,t.id).runs.length,1);assert.equal(f.fake.runs.length,0);
  assert.equal((await c.request(`/api/assistants/${id}/schedules`,req)).data.duplicate,true);
 }finally{await f.close();}
});

test('智能任务错误、工具显式发送和分段回复都关联执行记录；历史分页',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  const s=f.app.engine.schedules,t=s.request(id,input({mode:'agent'})).task;
  r.harness.run=async()=>{throw new Error('模拟工具故障');};
  f.app.engine.requestSchedule(id,{action:'run',id:t.id,requestId:randomUUID()});await until(()=>s.list(id)[0].last_job_state==='failed'&&!r.draining&&!r.delivering);
  const failed=s.history(id,t.id).runs[0];assert.match(failed.error,/模拟工具故障/);assert.match(failed.messages[0].text,/执行失败/);assert.equal(failed.deliveries[0].state,'sent');
  r.harness.run=async({onSend,onEvent})=>{await onSend({requestId:randomUUID(),text:'工具发送'});onEvent({type:'message',itemId:'result',text:'长'.repeat(3000),phase:'final_answer'});};
  f.app.engine.requestSchedule(id,{action:'run',id:t.id,requestId:randomUUID()});await until(()=>s.list(id)[0].last_job_state==='done'&&!r.draining&&!r.delivering);
  const page=s.history(id,t.id,{limit:1});assert.equal(page.runs[0].deliveries.length,4);assert(page.nextBefore);assert.equal(s.history(id,t.id,{before:page.nextBefore,limit:1}).runs[0].id,failed.id);
 }finally{await f.close();}
});

test('超过截止时间不补跑，最后一次执行后完成；暂停取消保留记录',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),s=f.app.engine.schedules,now=Date.now();
  const t=s.request(id,input({spec:{type:'interval',minutes:1,until:iso(now+90000)}}),now).task;
  assert.equal(s.enqueue(t.id,now+100000),null);assert.equal(s.get(id,t.id).status,'completed');
  const t2=s.request(id,input({spec:{type:'interval',minutes:1,until:iso(now+90000)}}),now).task;
  const job=s.enqueue(t2.id,now+60000);assert.equal(s.get(id,t2.id).status,'queued');
  s.request(id,{action:'remove',id:t2.id});assert.equal(s.history(id,t2.id).runs[0].state,'cancelled');assert(s.history(id,t2.id).runs[0].finished_at);assert(job.jobId);
 }finally{await f.close();}
});

async function upload(f,c,id,bytes,name='test.txt',extra={}){
 const response=await fetch(`${f.base}/api/assistants/${id}/uploads?name=${encodeURIComponent(name)}`,{method:'POST',headers:{Cookie:c.cookie,'X-Wxbot-Platform':'1',...extra},body:bytes});return {status:response.status,data:await response.json()};
}
test('网页文字与图片上传到模型、持久化下载、附件单独发送、重试去重和用户隔离',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  const b=await register(f,'bob'),bid=await create(b);await f.app.engine.runtimes.get(bid).channel.pair();
  const bytes=Buffer.from('web-upload-marker 中文'),u=await upload(f,c,id,bytes,'../../测试.txt');assert.equal(u.status,201);assert.equal(u.data.attachment.name,'测试.txt');
  const img=await upload(f,c,id,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfoAAAAASUVORK5CYII=','base64'),'picture.png');assert.equal(img.data.attachment.kind,'image');
  const req={text:'',requestId:randomUUID(),attachments:[u.data.attachment.id,img.data.attachment.id]};
  assert.equal((await b.request(`/api/assistants/${bid}/messages`,req)).status,404);
  assert.equal((await upload(f,b,id,bytes)).status,404);
  assert.equal((await c.request(`/api/assistants/${id}/messages`,req)).status,202);
  await until(()=>f.fake.runs.length===1&&!r.draining);assert.match(f.fake.runs[0].text,/web-upload-marker/);assert.equal(f.fake.runs[0].images.length,1);
  assert.equal((await c.request(`/api/assistants/${id}/messages`,req)).data.duplicate,true);assert.equal(f.fake.runs.length,1);
  await f.restart();const url=`${f.base}/api/assistants/${id}/attachments/${u.data.attachment.id}`;
  const download=await fetch(url,{headers:{Cookie:c.cookie}});assert.equal(download.status,200);assert.equal(await download.text(),bytes.toString());
  assert.equal((await fetch(url,{headers:{Cookie:b.cookie}})).status,404);
 }finally{await f.close();}
});

test('上传拒绝跨站、空文件、伪造元数据、超限和过期附件，已发送原件不被清理',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);await f.app.engine.runtimes.get(id).channel.pair();
  assert.equal((await upload(f,c,id,'x','x.txt',{Origin:'https://evil.example'})).status,403);
  assert.equal((await upload(f,c,id,Buffer.alloc(0))).status,400);
  assert.equal((await upload(f,c,id,Buffer.alloc(20*1024*1024+1))).status,413);
  assert.equal((await c.request(`/api/assistants/${id}/messages`,{text:'x',attachments:[{id:randomUUID(),path:'/etc/passwd'}]})).status,400);
  const u=(await upload(f,c,id,'keep')).data.attachment;f.app.engine.uploads.claim(id,[u]);
  const expired=(await upload(f,c,id,'old')).data.attachment;
  f.app.store.db.prepare('UPDATE uploads SET created_at=0').run();await f.app.engine.uploads.cleanup();
  assert(f.app.engine.uploads.has(id,u.id));assert(!f.app.engine.uploads.has(id,expired.id));
 }finally{await f.close();}
});

function client(options={}){const c=Object.create(CodexClient.prototype);Object.assign(c,{active:null,turnTimeout:1000,stallTimeout:0,maxToolFailures:3,request:async()=>({turn:{id:'turn'}}),interrupt:async()=>{},...options});return c;}
test('执行器无响应超时与整体时限都能退出，而不会自动重跑',async()=>{
 for(const options of [{stallTimeout:25},{turnTimeout:25}]){const c=client(options);await assert.rejects(c.run({threadId:'thread',input:[]}),/没有响应|执行时限/);assert.equal(c.active,null);}
});
test('连续工具失败停止，成功工具会重置错误次数；内部输出不作为用户消息',async()=>{
 const c=client(),events=[],running=c.run({threadId:'thread',input:[],onEvent:e=>events.push(e)});running.catch(()=>{});
 const event=exitCode=>c.handle({method:'item/completed',params:{threadId:'thread',turnId:'turn',item:{type:'commandExecution',exitCode,aggregatedOutput:'SECRET_TOOL_OUTPUT'}}});
 event(1);event(1);event(0);assert.equal(c.active.toolFailures,0);event(1);event(1);event(1);await assert.rejects(running,/连续 3 次/);assert(!JSON.stringify(events).includes('SECRET'));
});

test('未提交附件的认领与消息事务一致，过载拒绝不丢原件',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),u=f.app.engine.uploads;
  await f.app.engine.runtimes.get(id).channel.pair();
  const a=(await upload(f,c,id,'atomic')).data.attachment;
  const original=u.claim.bind(u);u.claim=()=>{throw new Error('模拟事务故障');};
  assert.throws(()=>f.app.engine.submit(id,'atomic','web','atomic-key',[a.id]),/事务故障/);
  assert.equal(f.app.store.messages(id).length,0);assert.equal(f.app.store.pending(id).length,0);
  assert.equal(f.app.store.db.prepare('SELECT state FROM uploads WHERE id=?').get(a.id).state,'ready');
  u.claim=original;f.app.engine.submit(id,'atomic','web','atomic-key',[a.id]);
  assert.equal(f.app.store.db.prepare('SELECT state FROM uploads WHERE id=?').get(a.id).state,'claimed');
 }finally{await f.close();}
});
