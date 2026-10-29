import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,register,create,until } from './helpers.js';

test('同一微信用户更换机器人 ID 可重连，保留 thread，只迁移未发送的原账号投递',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);
  await r.channel.pair({id:'old-bot',userId:'same-owner'});await until(()=>!r.delivering);
  f.app.store.thread(id,'original-thread');await r.channel.disconnect();await r.connectionStop;
  const queue=(key,state='pending',userId='same-owner')=>{f.app.store.queueDelivery(key,id,{text:key,binding:{accountId:'old-bot',userId}});f.app.store.deliveryState(key,state);};
  queue('unsent');queue('sent','sent');queue('unknown','unknown');queue('failed','failed');queue('other-owner','pending','other-owner');
  // Exercise the actual binding callback without emitting channel state changes.
  r.channel.options.validateBinding({id:'new-bot',userId:'same-owner'});
  assert.equal(f.app.store.assistant(id).thread_id,'original-thread');
  assert.equal(f.app.store.get('binding:old-bot'),null);assert.equal(f.app.store.get('binding:new-bot'),id);
  assert.deepEqual(f.app.store.get(`assistant-binding:${id}`),{id:'new-bot',userId:'same-owner'});
  assert.equal(JSON.parse(f.app.store.delivery('unsent').payload).binding.accountId,'new-bot');
  for(const key of ['sent','unknown','failed','other-owner'])assert.equal(JSON.parse(f.app.store.delivery(key).payload).binding.accountId,'old-bot');
  await r.channel.pair({id:'new-bot',userId:'same-owner'});await until(()=>!r.delivering);
  assert.equal(f.fake.sent.filter(m=>m.id==='unsent').length,1);
  assert.ok(!f.fake.sent.some(m=>['sent','unknown','failed'].includes(m.id)));
 }finally{await f.close();}
});

test('更换微信用户、缺少身份或抢占其他助手机器人时拒绝且不改变原绑定',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);
  await r.channel.pair({id:'own-bot',userId:'owner'});await until(()=>!r.delivering);
  f.app.store.set('binding:occupied','another-assistant');
  assert.throws(()=>r.channel.options.validateBinding({id:'fresh',userId:'someone-else'}),/微信账号与原绑定账号不一致/);
  assert.throws(()=>r.channel.options.validateBinding({id:'own-bot'}),/完整账号身份/);
  assert.throws(()=>r.channel.options.validateBinding({id:'occupied',userId:'owner'}),/其他助手/);
  assert.deepEqual(f.app.store.get(`assistant-binding:${id}`),{id:'own-bot',userId:'owner'});
  assert.equal(f.app.store.get('binding:own-bot'),id);assert.equal(f.app.store.get('binding:fresh'),null);
 }finally{await f.close();}
});
