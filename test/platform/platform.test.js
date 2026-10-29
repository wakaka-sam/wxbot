import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,register,create,until } from './helpers.js';

test('账号权限：注册不能提权，跨用户助手/历史/SSE不可访问，admin 仅额外读取',async()=>{
 const f=await fixture();try{
  const alice=await register(f),bob=await register(f,'bob'),admin=f.client();
  assert.equal((await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'})).status,200);
  const a=await create(alice);
  for(const suffix of ['', '/messages','/events'])assert.equal((await bob.request(`/api/assistants/${a}${suffix}`)).status,404);
  assert.equal((await bob.request(`/api/assistants/${a}/messages`,{text:'attack',requestId:randomUUID()})).status,404);
  assert.equal((await bob.request('/api/admin/users')).status,403);
  const bad=f.client();const registered=await bad.request('/api/register',{username:'mallory',password:'Test-password-731',role:'admin'});assert.equal(registered.data.user.role,'user');
  const users=await admin.request('/api/admin/users');assert.equal(users.data.users.length,4);assert.ok(!JSON.stringify(users.data).includes('password'));
  const inspected=await admin.request(`/api/assistants/${a}`);assert.equal(inspected.status,200);assert.equal(inspected.data.readOnly,true);
  assert.equal((await admin.request(`/api/assistants/${a}/deactivate`,{})).status,404);
  assert.equal((await alice.request('/api/login',{username:'alice',password:'wrong'})).status,401);
  assert.equal((await alice.request('/api/assistants',{name:'CSRF'},{Origin:'https://evil.example'})).status,403);
  const response=await fetch(f.base+'/api/assistants',{method:'POST',headers:{Cookie:alice.cookie},body:'{}'});assert.equal(response.status,403);
 }finally{await f.close();}
});

test('注册自动创建唯一助手，并发获取与旧新增接口不能创建第二个',async()=>{
 const f=await fixture();try{
  const c=await register(f),u=f.app.store.userByName('alice');assert.equal(f.app.store.assistants(u.id).length,1);
  const results=await Promise.all(Array.from({length:5},()=>c.request('/api/assistants')));
  const id=results[0].data.assistants[0].id;assert.ok(results.every(r=>r.data.assistants.length===1&&r.data.assistants[0].id===id));
  assert.equal((await c.request('/api/assistants',{name:'第二个'})).data.code,'SINGLE_ASSISTANT');
  assert.throws(()=>f.app.store.createAssistant(u.id,'第二个'),/只有一个/);
  assert.equal((await c.request(`/api/assistants/${id}/deactivate`,{})).status,410);
  await f.restart();assert.equal(f.app.store.assistants(u.id)[0].id,id);
 }finally{await f.close();}
});

test('生成时新输入实际中断原轮次，保留线程；输出逐段持久化，重启后续聊',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);
  await f.app.engine.runtimes.get(id).channel.pair();
  const requestId=randomUUID();await c.request(`/api/assistants/${id}/messages`,{text:'WAIT 第一轮',requestId});
  await until(()=>f.fake.runs.length===1);
  const partial=f.app.store.messages(id);assert.ok(partial.some(m=>m.role==='assistant'&&m.text.includes('先确认')));
  const thread=f.app.store.assistant(id).thread_id;
  await c.request(`/api/assistants/${id}/messages`,{text:'改成第二个方向',requestId:randomUUID()});
  await until(()=>f.fake.runs.length===2&&!f.app.engine.runtimes.get(id).active);
  assert.ok(f.fake.interrupts.includes(thread));assert.equal(f.fake.runs[1].threadId,thread);assert.equal(f.fake.runs[1].text,'改成第二个方向');
  const repeated=await c.request(`/api/assistants/${id}/messages`,{text:'WAIT 第一轮',requestId});assert.equal(repeated.data.duplicate,true);
  assert.equal(f.app.store.messages(id).filter(m=>m.role==='user').length,2);
  await f.restart();assert.equal(f.app.store.assistant(id).thread_id,thread);
  const logged=await c.request('/api/auth');assert.equal(logged.data.user.username,'alice');
  await c.request(`/api/assistants/${id}/messages`,{text:'继续',requestId:randomUUID()});
  await until(()=>f.fake.runs.length===3&&!f.app.engine.runtimes.get(id).active);assert.equal(f.fake.runs[2].threadId,thread);
 }finally{await f.close();}
});

test('扫码不主动问候或总结，收到微信输入后回复且与网页共用线程',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);const channel=f.app.engine.runtimes.get(id).channel;
  await channel.pair({id:'bot-a',userId:'owner-a'});await until(()=>!f.app.engine.runtimes.get(id).delivering);assert.equal(f.fake.sent.length,0);assert.equal(f.fake.runs.length,0);assert.equal(f.app.engine.snapshot(id).lastWechatMessageSeq,0);
  channel.input('从微信开始','wx-1');await until(()=>f.fake.runs.length===1&&!f.app.engine.runtimes.get(id).active);
  const thread=f.app.store.assistant(id).thread_id;
  await c.request(`/api/assistants/${id}/messages`,{text:'从网页继续',requestId:randomUUID()});await until(()=>f.fake.runs.length===2&&!f.app.engine.runtimes.get(id).active);
  assert.equal(f.fake.runs[1].threadId,thread);await until(()=>f.fake.sent.some(s=>s.text.includes('从网页继续')));
  for(let i=0;i<12;i++)f.app.store.addMessage(id,{role:i%2?'assistant':'user',text:'历史'+i});
  await until(()=>!f.app.engine.runtimes.get(id).delivering);
  const sentBefore=f.fake.sent.length,seq=f.app.engine.snapshot(id).lastWechatMessageSeq;
  assert.ok(seq>0);
  await channel.pair({id:'bot-a',userId:'owner-a'});
  await until(()=>!f.app.engine.runtimes.get(id).delivering);
  assert.equal(f.fake.runs.length,2);assert.equal(f.fake.sent.length,sentBefore);
  assert.equal(f.app.store.pending(id).length,0);assert.equal(f.app.engine.snapshot(id).lastWechatMessageSeq,seq);
  channel.input('从微信开始','wx-1');assert.equal(f.app.engine.snapshot(id).lastWechatMessageSeq,seq);
  channel.input('重新连接后的新消息','wx-2');await until(()=>f.fake.runs.length===3&&!f.app.engine.runtimes.get(id).active);
  assert.ok(f.app.engine.snapshot(id).lastWechatMessageSeq>seq);assert.equal(f.fake.runs[2].threadId,thread);
  assert.ok(!f.app.store.messages(id).some(m=>['greeting','summary'].includes(m.kind)));
  assert.ok(f.fake.sent.every(s=>s.binding.accountId==='bot-a'));
  const other=await create(await register(f,'bob'),'其他');
  await assert.rejects(f.app.engine.runtimes.get(other).channel.pair({id:'bot-a',userId:'owner-a'}),/其他助手/);
 }finally{await f.close();}
});

test('退出、改密使旧会话失效；历史分页和停止状态拒绝新消息',async()=>{
 const f=await fixture();try{
  const c=await register(f),other=f.client();await other.request('/api/login',{username:'alice',password:'Test-password-731'});const id=await create(c);
  assert.equal((await c.request(`/api/assistants/${id}/messages`,{text:'inactive',requestId:randomUUID()})).status,409);
  for(let i=0;i<12;i++)f.app.store.addMessage(id,{role:'user',text:'消息'+i});
  const page=await c.request(`/api/assistants/${id}/messages?limit=5`);assert.equal(page.data.messages.length,5);assert.equal(page.data.messages[0].text,'消息7');
  const older=await c.request(`/api/assistants/${id}/messages?before=${page.data.messages[0].seq}&limit=5`);assert.equal(older.data.messages.at(-1).text,'消息6');
  const changed=await c.request('/api/password',{oldPassword:'Test-password-731',newPassword:'New-password-456'});assert.equal(changed.status,200);
  assert.equal((await other.request('/api/assistants')).status,401);assert.equal((await c.request('/api/assistants')).status,200);
  await c.request('/api/logout',{});assert.equal((await c.request('/api/assistants')).status,401);
 }finally{await f.close();}
});
