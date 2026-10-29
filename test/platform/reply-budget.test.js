import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WechatChannel } from '../../src/platform/adapters/wechat.js';
import { PlatformStore } from '../../src/platform/store.js';
import { Engine } from '../../src/platform/engine.js';
import { until } from './helpers.js';

const account={id:'test-bot',userId:'test-user',token:'fake-token',baseUrl:'https://ilinkai.weixin.qq.com'};
const binding={accountId:account.id,userId:account.userId};
function incoming(channel,id){
  const message={id:`${account.id}:${account.userId}:${id}`,sender:account.userId,text:'继续',attachments:[]};
  return channel.store.ingest([message],'cursor',id,[[`context:${account.id}:${account.userId}`,`context-${id}`]]);
}
function setupChannel(dir,api){
  const channel=new WechatChannel({dir,api});channel.store.set('account',account);channel.bridge.state.phase='connected';return channel;
}

test('10 条额度跨重启保存：并发不超发，第十条附提醒，重试和历史重放不重置，真实新输入恢复',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'wxbot-budget-')),sent=[];
  const api={async sendText(a,text,id,context){sent.push({text,id,context});await delay(2);}};
  let channel=setupChannel(dir,api);
  try{
    incoming(channel,'first');
    const ids=Array.from({length:12},()=>randomUUID());
    const results=await Promise.all(ids.map((id,i)=>channel.send(`正文 ${i}`,id,binding)));
    assert.equal(results.filter(r=>r.status==='sent').length,10);
    assert.equal(results.filter(r=>r.status==='blocked').length,2);
    assert.equal(sent.length,10);
    assert(sent[9].text.startsWith('正文 9\n\n'));
    assert.match(sent[9].text,/第 10 条消息/);assert.match(sent[9].text,/微信里再发一条消息/);
    assert(!sent.slice(0,9).some(m=>m.text.includes('【回复提醒】')));
    await channel.send('正文 9',ids[9],binding);assert.equal(sent.length,10);
    await channel.close();channel=setupChannel(dir,api);
    assert.equal(channel.snapshot().replyBudget.remaining,0);
    incoming(channel,'first'); // replay does not create a new input epoch
    assert.equal((await channel.send('正文 10',ids[10],binding)).status,'blocked');
    incoming(channel,'second');
    assert.equal((await channel.send('正文 10',ids[10],binding)).status,'sent');
    assert.equal(sent.length,11);assert.equal(sent[10].context,'context-second');
    assert.equal(channel.snapshot().replyBudget.remaining,9);
    assert.equal(channel.history().length,2);
  }finally{await channel.close();await rm(dir,{recursive:true,force:true});}
});

test('升级从既有回执恢复额度；网络结果不明仍占额度，其他绑定独立计数',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'wxbot-budget-upgrade-'));
  const api={async sendText(){throw new Error('transport timeout');}};
  const channel=setupChannel(dir,api);
  try{
    incoming(channel,'old');
    for(let i=0;i<9;i++){
      const id=`out:${account.id}:${randomUUID()}`;
      channel.store.beginSend({id,recipient:account.userId,direction:'outbound',text:'old'},'hash');
      channel.store.finishSend(id,'sent');
    }
    assert.equal(channel.snapshot().replyBudget.remaining,1);
    assert.equal((await channel.send('unknown',randomUUID(),binding)).status,'unknown');
    assert.equal((await channel.send('blocked',randomUUID(),binding)).status,'blocked');
    assert.equal(channel.store.replyBudget({...account,id:'other-bot'},10).remaining,10);
  }finally{await channel.close();await rm(dir,{recursive:true,force:true});}
});

test('平台保留超额 outbox 且不忙循环；网页输入不重置，CLI 返回等待，微信新输入后自动续发',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'wxbot-budget-engine-')),sent=[];
  const store=new PlatformStore(dir);
  const user=store.addUser('quota-user','unused'),assistant=store.assistants(user.id)[0];
  store.activate(assistant.id,user);
  const api={async sendText(a,text){sent.push(text);}};
  const engine=new Engine(store,dir,{channelFactory:({dir})=>setupChannel(dir,api),harnessFactory:()=>({async close(){}})});
  const r=await engine.runtime(assistant);
  engine.wake=()=>{}; // isolate delivery from model execution
  try{
    incoming(r.channel,'first');
    for(let i=0;i<12;i++)engine.enqueueText(assistant.id,`reply ${i}`,`reply:${i}`);
    await until(()=>sent.length===10&&!r.delivering);
    assert.equal(store.deliveries(assistant.id).length,2);
    for(let i=0;i<10;i++)r.channel.emit('state',r.channel.snapshot());
    await delay(30);assert.equal(sent.length,10);assert.equal(r.delivering,null);
    engine.submit(assistant.id,'web input','web','web-key');
    await delay(20);assert.equal(sent.length,10);
    r.active={jobId:'tool-job',interrupted:false,explicitTexts:new Set()};
    const receipt=await engine.sendFromTool(assistant.id,r.active,account,{requestId:randomUUID(),text:'tool reply'});
    assert.equal(receipt.status,'unknown');assert.match(receipt.error,/额度/);
    assert.equal(store.deliveries(assistant.id).length,4);
    r.active=null;
    incoming(r.channel,'second');r.channel.emit('state',r.channel.snapshot());
    await until(()=>sent.length===14&&!r.delivering);
    assert.deepEqual(sent.slice(10),['reply 10','reply 11','[User]: web input','tool reply']);
    assert.equal(store.deliveries(assistant.id).length,0);
    assert.equal(r.channel.snapshot().replyBudget.remaining,6);
    // Pending progress from before deployment is suppressed too.
    engine.enqueueText(assistant.id,'正在执行命令…','old-progress');
    await until(()=>!r.delivering);assert.equal(sent.length,14);
  }finally{await engine.close();store.close();await rm(dir,{recursive:true,force:true});}
});
