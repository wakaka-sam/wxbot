import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,register,create,until} from './helpers.js';

async function bound(f,client,name='助手',account={id:'mirror-bot',userId:'mirror-user'}){
 const id=await create(client,name);
 await client.request(`/api/assistants/${id}/activate`,{});
 const channel=f.app.engine.runtimes.get(id).channel;
 await channel.pair(account);
 await until(()=>!f.app.engine.runtimes.get(id).delivering);
 return{id,channel};
}

test('网页输入带 [User]: 同步到对应微信，先于本轮回复且重试不重复；模型仍接收原文',async()=>{
 const f=await fixture();try{
  const c=await register(f),{id,channel}=await bound(f,c);
  const bob=await register(f,'bob');await bound(f,bob,'另一个用户',{id:'bob-bot',userId:'bob-user'});
  const body={text:'帮我整理计划\n\n保留空行。\r\n\r\n第三段。',requestId:randomUUID()};
  const result=await c.request(`/api/assistants/${id}/messages`,body);assert.equal(result.status,202);
  await until(()=>f.fake.runs.length===1&&!f.app.engine.runtimes.get(id).active&&!f.app.engine.runtimes.get(id).delivering);
  assert.equal(f.fake.runs[0].text,body.text);
  const sent=f.fake.sent.filter(s=>s.dir===channel.options.dir);
  assert.equal(sent[1].text,'[User]: '+body.text);assert.match(sent[2].text,/先确认/);
  assert.deepEqual(sent.slice(3).map(s=>s.text),['回答：'+body.text]);
  assert.ok(sent.slice(1).every(s=>s.binding.accountId==='mirror-bot'&&s.binding.userId==='mirror-user'));
  assert.ok(!f.fake.sent.some(s=>s.binding.accountId==='bob-bot'&&s.text.includes(body.text)));
  const retry=await c.request(`/api/assistants/${id}/messages`,body);assert.equal(retry.data.duplicate,true);
  assert.equal(f.fake.sent.filter(s=>s.text==='[User]: '+body.text).length,1);
  assert.equal(f.app.store.messages(id).filter(m=>m.role==='user').length,1);
  channel.input('微信里的输入','wechat-only');
  await until(()=>f.fake.runs.length===2&&!f.app.engine.runtimes.get(id).active);
  assert.ok(!f.fake.sent.some(s=>s.text==='[User]: 微信里的输入'));
  assert.equal(f.app.store.messages(id).filter(m=>m.role==='user').length,2);
 }finally{await f.close();}
});

test('断线后的长消息按段保留前缀，重启重连后按序投递，首次配对前不追溯同步',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);
  await c.request(`/api/assistants/${id}/activate`,{});
  await c.request(`/api/assistants/${id}/messages`,{text:'配对前的历史',requestId:randomUUID()});
  await until(()=>!f.app.engine.runtimes.get(id).active);
  assert.equal(f.app.store.deliveries(id).length,0);
  const channel=f.app.engine.runtimes.get(id).channel;
  await channel.pair({id:'long-bot',userId:'long-user'});
  await until(()=>!f.app.engine.runtimes.get(id).active&&!f.app.engine.runtimes.get(id).delivering);
  await channel.disconnect();
  const body={text:'长消息🙂\n'+'🌲'.repeat(2600),requestId:randomUUID()};
  await c.request(`/api/assistants/${id}/messages`,body);
  await until(()=>!f.app.engine.runtimes.get(id).active);
  const queued=f.app.store.deliveries(id).map(d=>JSON.parse(d.payload));
  assert.equal(queued.filter(d=>d.text.startsWith('[User]: ')).length,3);
  await f.restart();
  assert.equal(f.fake.sent.filter(s=>s.text.startsWith('[User]: ')).length,0);
  const resumed=f.app.engine.runtimes.get(id).channel;
  await resumed.pair({id:'long-bot',userId:'long-user'});
  await until(()=>!f.app.engine.runtimes.get(id).delivering&&!f.app.engine.runtimes.get(id).active);
  const copies=f.fake.sent.filter(s=>s.text.startsWith('[User]: '));
  assert.equal(copies.length,3);assert.ok(copies.every(s=>Array.from(s.text).length<=1200));
  assert.equal(copies.map(s=>s.text.slice('[User]: '.length)).join(''),body.text);
  assert.equal(new Set(copies.map(s=>s.id)).size,3);
  await c.request(`/api/assistants/${id}/messages`,body);
  assert.equal(f.fake.sent.filter(s=>s.text.startsWith('[User]: ')).length,3);
 }finally{await f.close();}
});

test('同步投递与用户输入原子落库；微信投递失败不阻塞模型并保留错误状态',async()=>{
 const f=await fixture();try{
  const c=await register(f),{id,channel}=await bound(f,c);
  const originalQueue=f.app.store.queueDelivery;
  f.app.store.queueDelivery=()=>{throw new Error('模拟落库失败');};
  const body={text:'需要事务保护的输入',requestId:randomUUID()};
  const failed=await c.request(`/api/assistants/${id}/messages`,body);assert.notEqual(failed.status,202);
  assert.equal(f.app.store.messages(id).filter(m=>m.role==='user').length,0);
  assert.equal(f.app.store.pending(id).length,0);
  f.app.store.queueDelivery=originalQueue;
  const originalSend=channel.send.bind(channel);
  channel.send=async(text,...args)=>text.startsWith('[User]: ')?{status:'failed',error:'模拟微信拒绝发送'}:originalSend(text,...args);
  assert.equal((await c.request(`/api/assistants/${id}/messages`,body)).status,202);
  await until(()=>f.fake.runs.length===1&&!f.app.engine.runtimes.get(id).active&&!f.app.engine.runtimes.get(id).delivering);
  assert.equal(f.app.engine.snapshot(id).deliveryErrors.length,1);
  assert.ok(f.fake.sent.some(s=>s.text==='回答：'+body.text));
  assert.equal(f.app.store.messages(id).filter(m=>m.role==='user').length,1);
 }finally{await f.close();}
});

test('生成途中网页补充输入仍中断续聊，两条用户消息各同步一次且保留同一线程',async()=>{
 const f=await fixture();try{
  const c=await register(f),{id}=await bound(f,c);
  await c.request(`/api/assistants/${id}/messages`,{text:'WAIT 正在生成的任务',requestId:randomUUID()});
  await until(()=>f.fake.runs.length===1);
  const thread=f.app.store.assistant(id).thread_id;
  await c.request(`/api/assistants/${id}/messages`,{text:'按这个补充继续',requestId:randomUUID()});
  await until(()=>f.fake.runs.length===2&&!f.app.engine.runtimes.get(id).active&&!f.app.engine.runtimes.get(id).delivering);
  assert.deepEqual(f.fake.sent.filter(s=>s.text.startsWith('[User]: ')).map(s=>s.text),['[User]: WAIT 正在生成的任务','[User]: 按这个补充继续']);
  assert.equal(f.fake.runs[1].threadId,thread);assert.equal(f.fake.runs[1].text,'按这个补充继续');
  assert.ok(f.fake.interrupts.includes(thread));
  assert.ok(f.fake.sent.findIndex(s=>s.text==='[User]: 按这个补充继续')<f.fake.sent.findIndex(s=>s.text==='回答：按这个补充继续'));
 }finally{await f.close();}
});
