import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,register,create,until} from './helpers.js';

async function bound(f){
 const c=await register(f),id=await create(c);

 const r=f.app.engine.runtimes.get(id);
 await r.channel.pair();
 await until(()=>!r.delivering);
 f.fake.sent.length=0;
 return{id,r};
}

for(const phase of ['commentary','final_answer'])test(`${phase} 保留空行，完整消息仅投递一次，网页仍实时更新`,async()=>{
 const f=await fixture();let finish;
 try{
  const {id,r}=await bound(f);let emit;
  r.harness.run=({onEvent})=>{emit=onEvent;return new Promise(resolve=>{finish=resolve;});};
  r.channel.input('测试空行');await until(()=>emit);
  const first='第一段\n\n',text=first+'第二段\r\n\r\n第三段🙂';
  emit({type:'delta',itemId:'reply',phase,delta:first});
  assert.equal(f.app.store.messages(id).at(-1).text,first);
  assert.equal(f.app.store.messages(id).at(-1).state,'streaming');
  assert.equal(f.app.store.deliveries(id).length,0);
  assert.equal(f.fake.sent.length,0);
  emit({type:'delta',itemId:'reply',phase,delta:text.slice(first.length)});
  emit({type:'message',itemId:'reply',phase,text});
  await until(()=>!r.delivering);
  assert.deepEqual(f.fake.sent.map(s=>s.text),[text]);
  // Completion is delivered before the turn ends; duplicate completion and
  // the end-of-turn flush must not send the same message again.
  assert.ok(r.active);
  emit({type:'message',itemId:'reply',phase,text});finish();
  await until(()=>!r.draining&&!r.delivering);
  assert.deepEqual(f.fake.sent.map(s=>s.text),[text]);
 }finally{finish?.();await f.close();}
});

test('公开进度和最终回复只按 1200 字符上限分块，保留空行和 Unicode 字符',async()=>{
 const f=await fixture();try{
  const {r}=await bound(f);
  for(const phase of ['commentary','final_answer']){
   for(const text of ['🌲'.repeat(1100)+'\n\n结尾','🌲'.repeat(1199)+'\n\n'+'🙂'.repeat(1300)]){
    f.fake.sent.length=0;
    r.harness.run=async({onEvent})=>{
     onEvent({type:'delta',itemId:'reply',phase,delta:text});
     onEvent({type:'message',itemId:'reply',phase,text});
    };
    r.channel.input('长度测试');
    await until(()=>!r.draining&&!r.delivering);
    const points=Array.from(text),expected=[];
    for(let i=0;i<points.length;i+=1200)expected.push(points.slice(i,i+1200).join(''));
    assert.deepEqual(f.fake.sent.map(s=>s.text),expected);
    assert.equal(f.fake.sent.map(s=>s.text).join(''),text);
   }
  }
 }finally{await f.close();}
});

test('中断时未完成的多段消息完整投递一次',async()=>{
 const f=await fixture();try{
  const {id,r}=await bound(f);let ready=false;
  const text='已经生成的内容\n\n保留空行';
  r.harness.run=({onEvent})=>new Promise((resolve,reject)=>{
   r.harness.interrupt=async()=>reject(Object.assign(new Error('中断'),{code:'interrupted'}));
   onEvent({type:'delta',itemId:'partial',phase:'commentary',delta:text});ready=true;
  });
  r.channel.input('开始');await until(()=>ready);
  await f.app.engine.interrupt(id);
  await until(()=>!r.draining&&!r.delivering);
  assert.deepEqual(f.fake.sent.map(s=>s.text),[text]);
  assert.equal(f.app.store.messages(id).at(-1).state,'interrupted');
 }finally{await f.close();}
});
