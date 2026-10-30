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

test('工具状态不进入历史、网页事件或微信，助手正文和有意义的进度仍正常发送',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);
  const r=f.app.engine.runtimes.get(id);await r.channel.pair();
  const published=[];f.app.engine.on('event',e=>{if(e.assistantId===id&&e.type==='message')published.push(e.data.text);});
  const activities={webSearch:'正在查询网页…',commandExecution:'正在执行命令…',fileChange:'正在修改工作文件…',subAgentActivity:'正在与子代理协作…',mcpToolCall:'正在调用工具…',futureTool:'未来工具状态'};
  r.harness.run=async({onEvent})=>{
   for(const [activityType,text] of Object.entries(activities)){
    onEvent({type:'activity',itemId:activityType,activityType,text});
    onEvent({type:'activity',itemId:activityType,activityType,text});
   }
   onEvent({type:'message',itemId:'progress-1',text:'已找到两份相关资料，正在核对日期。',phase:'commentary'});
   onEvent({type:'delta',itemId:'answer-1',delta:'查询',phase:'final_answer'});
   onEvent({type:'message',itemId:'answer-1',text:'查询完成',phase:'final_answer'});
   return{text:'查询完成'};
  };
  r.channel.input('查一下网页');await until(()=>!r.active&&f.app.store.messages(id).some(m=>m.text==='查询完成'));
  await until(()=>f.fake.sent.some(m=>m.text==='查询完成'));
  const history=f.app.store.messages(id).map(m=>m.text),sent=f.fake.sent.map(m=>m.text);
  for(const text of Object.values(activities)){
   assert(!history.includes(text));assert(!published.includes(text));assert(!sent.includes(text));
  }
  for(const text of ['已找到两份相关资料，正在核对日期。','查询完成']){
   assert(history.includes(text));assert(published.includes(text));assert.equal(sent.filter(t=>t===text).length,1);
  }
 }finally{await f.close();}
});
