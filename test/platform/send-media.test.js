import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WechatChannel } from '../../src/platform/adapters/wechat.js';
import { createSendRelay } from '../../src/send-relay.js';
import { fixture,register,create,until } from './helpers.js';
const exec=promisify(execFile),cli=new URL('../../src/cli.js',import.meta.url).pathname;

test('附件经 CLI、宿主、真实适配器落库：额度提醒后排队，原文件/relay 消失和重启后仍可发送，下载隔离',async()=>{
 const f=await fixture(),textSent=[],mediaSent=[],uploads=[];
 const account={id:'media-bot',userId:'media-user',token:'fake'};
 const api={async updates(a,c,s){await delay(50,undefined,{signal:s});return{msgs:[],get_updates_buf:c};},async sendText(a,text){textSent.push(text);},
  async uploadMedia(a,bytes,description){uploads.push({bytes,description});return{type:description.kind==='image'?2:4};},async sendItem(a,item){mediaSent.push(item);}};
 const factory=options=>{const c=new WechatChannel({...options,api});if(!c.store.get('account'))c.store.set('account',account);return c;};
 f.fake.options.channelFactory=factory;f.app.engine.channelFactory=factory;
 let relay;
 try{
  const user=await register(f),id=await create(user);
  let r=f.app.engine.runtimes.get(id);await until(()=>r.channel.snapshot().phase==='connected');
  for(let i=0;i<9;i++)f.app.engine.enqueueText(id,`before ${i}`,`before:${i}`);
  await until(()=>textSent.length===9&&!r.delivering);
  const run=r.active={jobId:'media-test-job',interrupted:false,explicitTexts:new Set()};
  relay=await createSendRelay(join(f.dir,'relay'),request=>f.app.engine.sendFromTool(id,run,account,request));
  const path=join(f.dir,'report.txt');await writeFile(path,'PERSISTED-ATTACHMENT');
  const requestId=randomUUID();
  const args=[cli,'send','--relay-dir',relay.root,'--turn',relay.turn,'--request-id',requestId,'--file',path];
  let receipt;try{await exec(process.execPath,args);}catch(e){receipt=JSON.parse(e.stdout);}
  assert.equal(receipt.status,'unknown');assert.equal(textSent.length,10);assert.match(textSent[9],/第 10 条/);
  assert.equal(uploads.length,0);assert.equal(mediaSent.length,0);
  const message=f.app.store.message(receipt.id);assert.equal(message.text,'');assert.equal(message.attachments[0].name,'report.txt');
  assert.equal(f.app.store.delivery(receipt.id).state,'pending');
  const aid=message.attachments[0].id;
  const url=`/api/assistants/${id}/attachments/${aid}?download=1`;
  const download=await fetch(f.base+url,{headers:{Cookie:user.cookie}});assert.equal(download.status,200);assert.equal(await download.text(),'PERSISTED-ATTACHMENT');
  const other=await register(f,'other');assert.equal((await other.request(url)).status,404);
  await relay.close();relay=null;await rm(path);r.active=null;
  await f.restart();r=f.app.engine.runtimes.get(id);
  await until(()=>!r.delivering);assert.equal(f.app.store.delivery(receipt.id).state,'pending');
  assert.equal(uploads.length,0);
  r.channel.store.ingest([{id:`${account.id}:${account.userId}:new`,sender:account.userId,text:'继续',attachments:[]}],'cursor','new',[[`context:${account.id}:${account.userId}`,'fresh']]);
  r.channel.emit('state',r.channel.snapshot());
  await until(()=>f.app.store.delivery(receipt.id).state==='sent');
  assert.equal(uploads.length,1);assert.equal(uploads[0].bytes.toString(),'PERSISTED-ATTACHMENT');assert.equal(mediaSent[0].type,4);
  assert.equal(r.channel.snapshot().replyBudget.remaining,9);
 }finally{await relay?.close();for(const r of f.app.engine.runtimes.values())r.active=null;await f.close();}
});

test('上传失败链接持久排队并遵守微信额度，重启后发送一次且网页历史可查',async()=>{
 const f=await fixture(),sent=[];
 const account={id:'fallback-bot',userId:'fallback-user',token:'fake'};
 const api={async updates(a,c,s){await delay(50,undefined,{signal:s});return{msgs:[],get_updates_buf:c};},
  async sendText(a,text){sent.push(text);},async uploadMedia(){throw new Error('HTTP 500');}};
 const factory=options=>{const c=new WechatChannel({...options,api});if(!c.store.get('account'))c.store.set('account',account);return c;};
 f.fake.options.channelFactory=factory;f.app.engine.channelFactory=factory;f.app.downloads.publicUrl='https://download.test';
 try {
  const user=await register(f),id=await create(user);
  let r=f.app.engine.runtimes.get(id);await until(()=>r.channel.snapshot().phase==='connected');
  for(let i=0;i<8;i++)f.app.engine.enqueueText(id,`before ${i}`,`before:${i}`);
  await until(()=>sent.length===8&&!r.delivering);
  // The failed upload uses slot nine; another concurrent send consumes slot ten.
  const publish=r.channel.bridge.publishDownload;
  r.channel.bridge.publishDownload=async(...args)=>{
    await r.channel.send('concurrent',randomUUID(),{});
    return publish(...args);
  };
  const attachment=await r.channel.stageAttachment({kind:'file',name:'report.txt',data:Buffer.from('fallback data').toString('base64')});
  const deliveryId=randomUUID();
  f.app.store.queueDelivery(deliveryId,id,{attachment,binding:{accountId:account.id,userId:account.userId}});
  f.app.engine.deliver(id);
  await until(()=>f.app.store.delivery(deliveryId).state==='failed'&&!r.delivering);
  assert.equal(sent.length,9);assert.match(sent.at(-1),/第 10 条/);
  const pending=f.app.store.deliveries(id);assert.equal(pending.length,1);const noticeId=pending[0].id;
  const notice=f.app.store.message(noticeId);assert.match(notice.text,/https:\/\/download.test\/downloads\//);
  assert.equal(notice.source,'download-fallback');
  await f.restart();r=f.app.engine.runtimes.get(id);await until(()=>!r.delivering);
  assert.equal(sent.length,9);
  r.channel.store.ingest([{id:`${account.id}:${account.userId}:fresh-fallback`,sender:account.userId,text:'继续',attachments:[]}],'cursor','fresh',[[`context:${account.id}:${account.userId}`,'new']]);
  r.channel.emit('state',r.channel.snapshot());
  await until(()=>f.app.store.delivery(noticeId).state==='sent');
  assert.equal(sent.filter(text=>text.includes('/downloads/')).length,1);
 } finally {await f.close();}
});
