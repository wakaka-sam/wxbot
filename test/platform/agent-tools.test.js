import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexClient } from '../../src/codex-client.js';
import { fixture,register,create,until } from './helpers.js';

test('工具进度只转发当前线程的公开活动，不包含命令或原始工具输出',()=>{
 const events=[],client=Object.create(CodexClient.prototype);
 client.active={threadId:'mine',items:new Map(),onEvent:e=>events.push(e)};
 const event=threadId=>({method:'item/started',params:{threadId,item:{id:'cmd-1',type:'commandExecution',command:'echo PRIVATE_VALUE'}}});
 client.handle(event('other'));assert.equal(events.length,0);
 client.handle(event('mine'));assert.equal(events.length,1);assert.equal(events[0].type,'activity');
 client.handle({method:'item/commandExecution/outputDelta',params:{threadId:'mine',itemId:'cmd-1',delta:'PRIVATE_STDOUT'}});
 assert(!JSON.stringify(events).includes('PRIVATE'));assert.equal(events.length,1);
});

test('工具活动持久化并同步微信，相同活动事件不重复发送',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);
  const r=f.app.engine.runtimes.get(id);await r.channel.pair();
  r.harness.run=async({onEvent})=>{
   onEvent({type:'activity',itemId:'search-1',text:'正在查询网页…'});
   onEvent({type:'activity',itemId:'command-1',activityType:'commandExecution',text:'正在执行命令…'});
   onEvent({type:'activity',itemId:'search-1',text:'正在查询网页…'});
   onEvent({type:'message',itemId:'answer-1',text:'查询完成',phase:'final_answer'});
   return{text:'查询完成'};
  };
  r.channel.input('查一下网页');await until(()=>!r.active&&f.app.store.messages(id).some(m=>m.text==='查询完成'));
  assert.equal(f.app.store.messages(id).filter(m=>m.text==='正在查询网页…').length,1);
  await until(()=>f.fake.sent.some(m=>m.text==='查询完成'));
  assert.equal(f.fake.sent.filter(m=>m.text==='正在查询网页…').length,1);
  assert.equal(f.app.store.messages(id).filter(m=>m.text==='正在执行命令…').length,1);
  assert.equal(f.fake.sent.filter(m=>m.text==='正在执行命令…').length,0);
 }finally{await f.close();}
});
