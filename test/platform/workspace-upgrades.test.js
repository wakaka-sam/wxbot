import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readFile,readdir} from 'node:fs/promises';
import {fixture,register,create,until} from './helpers.js';
import {isQuiet,notificationPreferences} from '../../src/platform/notification-preferences.js';
import {memoryContext,changeMemory,previewWorkspaceFile} from '../../src/platform/workspace-files.js';
const post=(c,id,text,requestId=randomUUID())=>c.request(`/api/assistants/${id}/messages`,{text,requestId});

test('搜索按本人、原文与游标定位，中文和通配符按字面匹配，不搜自身命令回执',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),b=await register(f,'bob'),bid=await create(b),s=f.app.store;
  for(let i=0;i<12;i++)s.addMessage(id,{role:'user',text:'项目苹果 100% '+i});
  s.addMessage(bid,{role:'assistant',text:'项目苹果 100% 他人秘密'});
  s.addMessage(id,{role:'system',kind:'command',text:'项目苹果 100% 命令回显'});
  const page=(await c.request(`/api/assistants/${id}/history/search?q=${encodeURIComponent('苹果 100%')}`)).data;
  assert.equal(page.results.length,10);assert(page.nextBefore);assert(!JSON.stringify(page).includes('秘密'));assert(!JSON.stringify(page).includes('回显'));
  const next=(await c.request(`/api/assistants/${id}/history/search?q=${encodeURIComponent('苹果 100%')}&before=${page.nextBefore}`)).data;assert.equal(next.results.length,2);
  const seq=page.results[0].seq;assert.equal((await c.request(`/api/assistants/${id}/history/context?seq=${seq}`)).data.seq,seq);
  assert.equal((await b.request(`/api/assistants/${bid}/history/context?seq=${seq}`)).status,404);
  const admin=f.client();await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'});
  assert.equal((await admin.request(`/api/assistants/${id}/history/search?q=苹果`)).status,403);
  assert.match((await post(c,id,'/search 苹果')).data.reply.text,/原文：\/message/);
  assert.match((await post(c,id,`/message ${seq}`)).data.reply.text,/100%/);
  assert.equal((await c.request(`/api/assistants/${id}/history/search?q=&before=-1`)).status,400);
 }finally{await f.close();}
});

test('免打扰跨午夜边界明确，参数无效时不修改设置；隔离并跨重启保存',async()=>{
 const p={quiet:{start:'23:00',end:'08:00'}};
 for(const [at,expected] of [['2027-01-01T22:59:00+08:00',false],['2027-01-01T23:00:00+08:00',true],['2027-01-02T07:59:00+08:00',true],['2027-01-02T08:00:00+08:00',false]])assert.equal(isQuiet(p,Date.parse(at)),expected);
 const f=await fixture();try{
  const c=await register(f),id=await create(c),b=await register(f,'bob'),bid=await create(b);
  assert.equal((await c.request(`/api/assistants/${id}/notifications`,{...p,finalOnly:true,digestMinutes:30})).status,200);
  assert.equal((await c.request(`/api/assistants/${id}/notifications`,{quiet:{start:'08:00',end:'08:00'}})).status,400);
  assert.equal((await b.request(`/api/assistants/${id}/notifications`,{finalOnly:false})).status,404);
  assert.equal(notificationPreferences(f.app.store,bid).finalOnly,false);await f.restart();assert.equal(notificationPreferences(f.app.store,id).digestMinutes,30);
  assert.match((await post(c,id,'/notify')).data.reply.text,/23:00–08:00/);
 }finally{await f.close();}
});

test('最终回复偏好保留网页进度，免打扰不阻塞命令，取消免打扰续发待发结果',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  await post(c,id,'/notify final on');
  const minutes=(Math.floor(Date.now()/60000)+480)%1440,hhmm=n=>`${Math.floor(((n+1440)%1440)/60)}`.padStart(2,'0')+':'+`${(n+1440)%60}`.padStart(2,'0');
  await c.request(`/api/assistants/${id}/notifications`,{quiet:{start:hhmm(minutes-60),end:hhmm(minutes+60)}});
  r.channel.input('测试延后通知');await until(()=>!r.draining&&f.fake.runs.length===1);await until(()=>!r.delivering);
  assert.equal(f.fake.sent.length,0);assert(f.app.store.messages(id).some(m=>m.kind==='progress'));
  assert(f.app.store.deliveries(id).length);r.channel.input('/status','quiet-status');await until(()=>f.fake.sent.length===1);assert.match(f.fake.sent[0].text,/微信：/);
  await c.request(`/api/assistants/${id}/notifications`,{quiet:null});await until(()=>!r.delivering&&!f.app.store.deliveries(id).length);
  assert.equal(f.fake.sent.filter(x=>x.text.includes('回答：测试延后通知')).length,1);assert(!f.fake.sent.some(x=>x.text.includes('先确认')));
 }finally{await f.close();}
});

test('任务摘要持久化、恢复后不重发，原任务回执关联摘要；摘要关闭可续发等待任务',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();await post(c,id,'/notify digest 30');
  for(const word of ['喝水','走路']){await post(c,id,'/remind 1h '+word);const task=f.app.engine.schedules.list(id).find(t=>t.prompt===word);await post(c,id,`/task ${task.id} run`);await until(()=>!r.draining);}
  await until(()=>!r.delivering);assert.equal(f.fake.sent.length,0);
  f.app.store.db.prepare("UPDATE outbox SET created_at=? WHERE assistant_id=? AND state='pending'").run(new Date(Date.now()-31*60000).toISOString(),id);
  const addMessage=f.app.store.addMessage.bind(f.app.store);let failures=0;f.app.store.addMessage=(...args)=>{if(args[1]?.source==='notification-digest'){failures++;throw new Error('digest storage failure');}return addMessage(...args);};
  f.app.engine.deliver(id);await until(()=>!r.delivering);await new Promise(r=>setTimeout(r,30));assert.equal(failures,1);assert.equal(f.fake.sent.length,0);assert.equal(f.app.store.deliveries(id).length,2);f.app.store.addMessage=addMessage;
  f.app.engine.deliver(id);await until(()=>!r.delivering&&f.fake.sent.length===1);assert.match(f.fake.sent[0].text,/喝水/);assert.match(f.fake.sent[0].text,/走路/);
  assert.equal(f.app.store.db.prepare("SELECT COUNT(*) n FROM outbox WHERE assistant_id=? AND state='skipped'").get(id).n,2);
  await f.restart();await new Promise(r=>setTimeout(r,50));assert.equal(f.fake.sent.length,1);
  await post(c,id,'/remind 1h 新提醒');const task=f.app.engine.schedules.list(id).find(t=>t.prompt==='新提醒');await post(c,id,`/task ${task.id} run`);await until(()=>!f.app.engine.runtimes.get(id).draining);await post(c,id,'/notify digest off');await until(()=>f.fake.sent.length===2);assert.equal(f.fake.sent[1].text,'新提醒');
 }finally{await f.close();}
});

test('快捷记忆复用文件与每轮记忆，重试并发不重复，删除保留备份，不影响其他文件',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),root=join(f.dir,'assistants',id,'harness','workspace'),history=join(f.dir,'assistants',id,'harness','memory-history'),key=randomUUID();
  const results=await Promise.all([post(c,id,'/memory add 回复简短',key),post(c,id,'/memory add 回复简短',key)]);assert(results.every(r=>r.status===202));assert.equal((await readdir(join(root,'memory'))).length,1);
  assert.match(await memoryContext(root),/回复简短/);const list=(await post(c,id,'/memory')).data.reply.text;assert.match(list,/回复简短/);
  const file=(await readdir(join(root,'memory')))[0],path='memory/'+file,original=await previewWorkspaceFile(root,path);await changeMemory(root,history,{path,version:original.version,content:'网页修改后的偏好'});
  await f.restart();await post(c,id,'/memory add 回复简短',key);assert.equal(await readFile(join(root,path),'utf8'),'网页修改后的偏好');
  await changeMemory(root,history,{path:'MEMORY.md',version:null,content:'保留原始记忆'});
  const ref=file.slice(6,18),delKey=randomUUID();assert.match((await post(c,id,'/memory delete '+ref,delKey)).data.reply.text,/已删除/);await post(c,id,'/memory delete '+ref,delKey);
  assert.equal(await readFile(join(root,'MEMORY.md'),'utf8'),'保留原始记忆');assert((await readdir(history)).length>=2);
  assert.match((await post(c,id,'/memory show ../../other')).data.reply.text,/命令未执行/);assert.match((await post(c,id,'/memory delete MEMORY.md')).data.reply.text,/命令未执行/);
 }finally{await f.close();}
});

test('记忆文件写入后回执存储失败可恢复，不重复新增，跨账号 ID 不可删除',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();const s=f.app.store,original=s.queueDelivery.bind(s);let once=true;
  s.queueDelivery=(...args)=>{if(once){once=false;throw new Error('injected receipt failure');}return original(...args);};
  await assert.rejects(f.app.engine.submit(id,'/memory add 保存一次','wechat','crash-key'),/injected/);
  const result=await f.app.engine.submit(id,'/memory add 保存一次','wechat','crash-key');assert.match(result.reply.text,/已保存/);
  const files=await readdir(join(f.dir,'assistants',id,'harness','workspace','memory'));assert.equal(files.length,1);
  const b=await register(f,'bob'),bid=await create(b);assert.match((await post(b,bid,'/memory delete '+files[0].slice(6,18))).data.reply.text,/找不到/);
 }finally{await f.close();}
});

test('模板预览不创建、创建请求幂等、规则与时间预览共用调度器，其他用户不能预览',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),b=await register(f,'bob'),key=randomUUID();
  assert.match((await post(c,id,'/templates')).data.reply.text,/晨间简报/);
  assert.match((await post(c,id,'/template weekly preview 18:00 工作进展')).data.reply.text,/尚未创建/);assert.equal(f.app.engine.schedules.list(id).length,0);
  await post(c,id,'/template weekly create 18:00 工作进展',key);await post(c,id,'/template weekly create 18:00 工作进展',key);
  const list=f.app.engine.schedules.list(id);assert.equal(list.length,1);assert.equal(list[0].spec.weekday,5);assert.match(list[0].prompt,/不虚构/);
  const data=await c.request(`/api/assistants/${id}/schedules/preview`,{spec:{type:'interval',minutes:30}});assert.equal(data.data.times.length,3);assert.equal(data.data.times[1]-data.data.times[0],1800000);
  assert.equal((await b.request(`/api/assistants/${id}/schedules/preview`,{spec:{type:'daily',time:'09:00'}})).status,404);
  assert.match((await post(c,id,'/template morning create 25:00 错误')).data.reply.text,/命令未执行/);assert.equal(f.app.engine.schedules.list(id).length,1);
 }finally{await f.close();}
});
