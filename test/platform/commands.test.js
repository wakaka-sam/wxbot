import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,register,create,until} from './helpers.js';
import {parseCommand,COMMANDS} from '../../src/platform/command-catalog.js';
const post=(c,id,text,requestId=randomUUID())=>c.request(`/api/assistants/${id}/messages`,{text,requestId});

test('命令边界明确，支持大小写和别名，不把普通文字、文件路径和双斜杠当命令',()=>{
 assert.equal(parseCommand(' /STATUS ').name,'status');assert.equal(parseCommand('/config').name,'settings');assert.equal(parseCommand('/?').name,'help');
 for(const text of ['请解释 /status','/workspace/a.txt','//status','https://x.test/a','```\n/stop\n```'])assert.equal(parseCommand(text),null);
 assert.equal(parseCommand('/task abcdefgh pause').args,'abcdefgh pause');assert.equal(COMMANDS.length,14);
});

test('未绑定微信也可查帮助参数、账号和任务；无模型调用，不泄露部署凭据',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);f.app.engine.runtimes.get(id).harness.model='test-model';
  for(const text of ['/help','/help task','/status','/settings','/whoami','/tasks','/config']){const r=await post(c,id,text);assert.equal(r.status,202);assert(r.data.reply.text);}
  const settings=(await post(c,id,'/settings')).data.reply.text;assert.match(settings,/test-model/);assert.match(settings,/只读/);assert.doesNotMatch(settings,/token|\.codex|\/root|password/i);
  const unknown=await post(c,id,'/unknown');assert.match(unknown.data.reply.text,/未知命令/);assert.equal(f.fake.runs.length,0);assert.equal(f.app.store.pending(id).length,0);assert.equal(f.app.store.deliveries(id).length,0);
  assert.equal((await post(c,id,'普通聊天')).status,409);assert.match((await post(c,id,'/settings set model')).data.reply.text,/只读/);
  assert.match((await post(c,id,'/whoami')).data.reply.text,/alice/);
 }finally{await f.close();}
});

test('微信命令直出且输入重放不重复，查询不打断进行中的模型任务',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  r.channel.input('WAIT 正在处理');await until(()=>r.harness.pending);const interruptions=f.fake.interrupts.length;
  r.channel.input('/status','command-status');await until(()=>f.fake.sent.some(s=>s.text.includes('等待作业')));
  assert.equal(f.fake.interrupts.length,interruptions);assert.equal(f.fake.runs.length,1);assert.match(f.app.store.messages(id).at(-1).text,/正在回复/);
  const n=f.app.store.messages(id).length,sent=f.fake.sent.length;
  r.channel.input('/status','command-status');assert.equal(f.app.store.messages(id).length,n);await until(()=>!r.delivering);assert.equal(f.fake.sent.length,sent);
  r.harness.pending.resolve();await until(()=>!r.draining&&!r.delivering);
  await f.restart();f.app.engine.reconcile(id,f.app.engine.runtimes.get(id));assert.equal(f.fake.runs.length,1);
 }finally{await f.close();}
});

test('提醒命令真实创建且重试跨重启幂等；原样正文不执行 shell',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),key=randomUUID(),text='/remind 30m 喝水 $(touch /tmp/never-command)';
  const first=await post(c,id,text,key);assert.equal(first.status,202);assert.match(first.data.reply.text,/已创建轻量提醒/);
  let tasks=f.app.engine.schedules.list(id);assert.equal(tasks.length,1);assert.equal(tasks[0].mode,'reminder');assert.match(tasks[0].prompt,/\$\(touch/);assert(tasks[0].next_run_at>Date.now()+29*60000);
  const retry=await post(c,id,text,key);assert(retry.data.duplicate);assert.equal(retry.data.reply.id,first.data.reply.id);
  await f.restart();assert((await post(c,id,text,key)).data.duplicate);assert.equal(f.app.engine.schedules.list(id).length,1);
  for(const text of ['/remind daily 09:00 吃早餐','/remind workdays 10:00 休息','/remind every 2h 活动一下'])assert.match((await post(c,id,text)).data.reply.text,/已创建/);
  for(const text of ['/remind 0m invalid','/remind 999999999d invalid','/remind daily 25:00 invalid','/remind at 2020-01-01T00:00:00Z invalid'])assert.match((await post(c,id,text)).data.reply.text,/命令未执行/);
  assert.equal(f.app.engine.schedules.list(id).length,4);assert.equal(f.fake.runs.length,0);
 }finally{await f.close();}
});

test('任务短 ID 管理、历史和立即运行幂等；其他用户及管理员不能跨用户操作',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);await post(c,id,'/remind 1h 任务内容');const s=f.app.engine.schedules,t=s.list(id)[0],ref=t.id.slice(0,8);
  assert.match((await post(c,id,`/task ${ref}`)).data.reply.text,/任务内容/);
  await post(c,id,`/task ${ref} pause`);assert.equal(s.get(id,t.id).status,'paused');
  await post(c,id,`/task ${ref} resume`);assert.equal(s.get(id,t.id).status,'active');
  const b=await register(f,'bob'),bid=await create(b);assert.match((await post(b,bid,`/task ${ref} cancel`)).data.reply.text,/找不到自己的/);
  const admin=f.client();await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'});assert.equal((await post(admin,id,`/task ${ref} cancel`)).status,404);
  const r=f.app.engine.runtimes.get(id);await r.channel.pair();const key=randomUUID(),next=s.get(id,t.id).next_run_at;
  await post(c,id,`/task ${ref} run`,key);await until(()=>s.list(id)[0].last_job_state==='done'&&!r.draining&&!r.delivering);
  await post(c,id,`/task ${ref} run`,key);assert.equal(s.history(id,t.id).runs.length,1);assert.equal(s.get(id,t.id).next_run_at,next);assert.equal(f.fake.runs.length,0);
  assert.match((await post(c,id,`/task ${ref} history`)).data.reply.text,/微信已接收/);
  await post(c,id,`/task ${ref} cancel`);assert.equal(s.get(id,t.id).status,'cancelled');
 }finally{await f.close();}
});

test('停止当前与排队作业、保留周期；重放旧停止命令不会停止新一轮',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  await post(c,id,'/remind every 1h 周期');const s=f.app.engine.schedules,t=s.list(id)[0];
  r.channel.input('WAIT first');await until(()=>r.harness.pending);s.request(id,{action:'run',id:t.id,requestId:randomUUID()});
  const key=randomUUID();assert.match((await post(c,id,'/stop',key)).data.reply.text,/取消 1 个/);await until(()=>!r.draining);assert.equal(s.get(id,t.id).status,'active');
  const oldPending=r.harness.pending;r.channel.input('WAIT second');await until(()=>r.harness.pending&&r.harness.pending!==oldPending);const run=r.active;
  assert((await post(c,id,'/stop',key)).data.duplicate);assert.equal(r.active,run);assert.equal(run.interrupted,false);r.harness.pending.resolve();await until(()=>!r.draining);
 }finally{await f.close();}
});

test('命令事务失败完整回滚；升级不执行已摄入的旧斜杠消息',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  const original=f.app.store.queueDelivery.bind(f.app.store);f.app.store.queueDelivery=()=>{throw new Error('模拟 outbox 故障');};
  assert.throws(()=>f.app.engine.submit(id,'/remind 30m rollback','wechat','rollback-key'),/outbox/);
  assert.equal(f.app.engine.schedules.list(id).length,0);assert.equal(f.app.store.messages(id).length,0);assert.equal(f.app.store.transactionDepth,0);
  f.app.store.queueDelivery=original;f.app.engine.submit(id,'/remind 30m retry','wechat','rollback-key');assert.equal(f.app.engine.schedules.list(id).length,1);
  f.app.store.addMessage(id,{role:'user',text:'/remind 30m old',source:'wechat',sourceKey:'wechat:old-key'});
  assert(f.app.engine.submit(id,'/remind 30m old','wechat','old-key').duplicate);assert.equal(f.app.engine.schedules.list(id).length,1);
 }finally{await f.close();}
});

test('普通文本转义与附件命令不误执行，任务页码校验',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  await post(c,id,'//status');await until(()=>f.fake.runs.length===1&&!r.draining);assert.equal(f.fake.runs[0].text,'/status');
  r.channel.input('/stop','with-file',[{id:randomUUID(),name:'a.txt',size:1,kind:'file'}]);assert.match(f.app.store.messages(id).at(-1).text,/不要携带附件/);
  for(let i=0;i<6;i++)await post(c,id,`/remind 1h item ${i}`);
  assert.match((await post(c,id,'/tasks 2')).data.reply.text,/第 2\/2 页/);assert.match((await post(c,id,'/tasks 999')).data.reply.text,/仅有 2 页/);
 }finally{await f.close();}
});
