import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { fixture, until, register } from './helpers.js';
import { mailNotification, startMailNotifications } from '../../src/platform/mail-notifications.js';

test('mail notifications target only configured admin, deduplicate and retain unknown receipts',async()=>{
 const f=await fixture();
 try{
  const store=f.app.store,engine=f.app.engine,owner=store.userByName('admin'),a=store.assistants(owner.id)[0];
  await register(f,'someone');const other=store.userByName('someone');
  const env={PLATFORM_MAIL_USER_ID:owner.id};
  const ch=engine.runtimes.get(a.id).channel;await ch.pair({id:'admin-bot',userId:'admin-wechat'});
  const request={key:'important:abc',text:'重要邮件测试'};
  assert.throws(()=>mailNotification(engine,request,{env:{PLATFORM_MAIL_USER_ID:other.id}}),/admin/);
  assert.throws(()=>mailNotification(engine,{...request,userId:other.id},{env}),/Invalid/);
  assert.throws(()=>mailNotification(engine,{...request,assistantId:a.id},{env}),/Invalid/);
  assert.equal(mailNotification(engine,request,{env}).status,'pending');
  mailNotification(engine,request,{env});
  await until(()=>f.fake.sent.length===1&&!engine.runtimes.get(a.id).delivering);
  assert.equal(mailNotification(engine,request,{env}).status,'sent');
  assert.equal(f.fake.sent.length,1);assert.equal(f.fake.sent[0].binding.userId,'admin-wechat');
  assert.equal(store.messages(a.id).length,1);assert.equal(f.fake.runs.length,0);
  assert.throws(()=>mailNotification(engine,{...request,text:'changed'},{env}),/不能更改/);
  const receipt=store.get('mail-notify:important:abc');store.deliveryState(receipt.deliveryIds[0],'unknown');
  assert.equal(mailNotification(engine,request,{env}).status,'unknown');assert.equal(f.fake.sent.length,1);
  const socket=join(f.dir,'mail-notify.sock'),listener=await startMailNotifications(engine,socket,{env});
  try{
   assert.equal((await stat(socket)).mode&0o777,0o600);
   const result=await new Promise((resolve,reject)=>{
    const r=http.request({socketPath:socket,path:'/status',method:'POST'},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve(JSON.parse(b)));});r.on('error',reject);r.end(JSON.stringify({key:request.key}));
   });assert.equal(result.status,'unknown');
  }finally{await listener.close();}
 }finally{await f.close();}
});

test('another admin cannot read mail-owner history or files',async()=>{
 const f=await fixture(),old=process.env.PLATFORM_MAIL_USER_ID;
 try{
  const owner=f.app.store.userByName('admin'),a=f.app.store.assistants(owner.id)[0];
  process.env.PLATFORM_MAIL_USER_ID=owner.id;
  const other=await register(f,'otheradmin');
  f.app.store.db.prepare("UPDATE users SET role='admin' WHERE username='otheradmin'").run();
  f.app.store.addMessage(a.id,{role:'assistant',text:'private mail notification'});
  for(const path of ['messages','files','events',''])assert.equal((await other.request(`/api/assistants/${a.id}/${path}`)).status,404);
  const c=f.client();await c.request('/api/login',{username:'admin',password:'Admin-test-password-731'});
  assert.equal((await c.request(`/api/assistants/${a.id}/messages`)).status,200);
 }finally{if(old===undefined)delete process.env.PLATFORM_MAIL_USER_ID;else process.env.PLATFORM_MAIL_USER_ID=old;await f.close();}
});
