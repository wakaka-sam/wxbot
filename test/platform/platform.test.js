import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,register,create,until } from './helpers.js';

test('账号权限：注册不能提权，跨用户助手/历史/SSE不可访问，admin 仅额外读取',async()=>{
 const f=await fixture();try{
  const alice=await register(f),bob=await register(f,'bob'),admin=f.client();
  assert.equal((await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'})).status,200);
  const a=await create(alice);await alice.request(`/api/assistants/${a}/activate`,{});
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

test('激活上限事务：并发激活最多三个，明确替换后旧助手停止且会话保留',async()=>{
 const f=await fixture();try{
  const a=await register(f),ids=await Promise.all([1,2,3,4].map(i=>create(a,'助手'+i)));
  const results=await Promise.all(ids.map(id=>a.request(`/api/assistants/${id}/activate`,{})));
  assert.equal(results.filter(r=>r.status===200).length,3);const blocked=results.findIndex(r=>r.status===409);assert.equal(results[blocked].data.code,'ACTIVE_LIMIT');
  const active=(await a.request('/api/assistants')).data.assistants.filter(x=>x.active);assert.equal(active.length,3);
  const old=active[0].id;await a.request(`/api/assistants/${old}/messages`,{text:'保留会话',requestId:randomUUID()});
  await until(()=>f.app.store.assistant(old).thread_id&&!f.app.engine.runtimes.get(old).active);
  const thread=f.app.store.assistant(old).thread_id;
  const replacement=await a.request(`/api/assistants/${ids[blocked]}/activate`,{stopAssistantId:old});assert.equal(replacement.status,200);
  assert.equal(f.app.store.assistant(old).active,0);assert.equal(f.app.store.assistant(old).thread_id,thread);
  assert.equal(f.app.store.assistants().filter(x=>x.active).length,3);
  const bob=await register(f,'bob');const b=await create(bob);await bob.request(`/api/assistants/${b}/activate`,{});
  assert.equal((await a.request(`/api/assistants/${old}/activate`,{stopAssistantId:b})).status,404);
 }finally{await f.close();}
});

test('生成时新输入实际中断原轮次，保留线程；输出逐段持久化，重启后续聊',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);await c.request(`/api/assistants/${id}/activate`,{});
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

test('微信与网页共用线程；首次扫码问候，再次扫码总结最近十条且按段推送',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);await c.request(`/api/assistants/${id}/activate`,{});const channel=f.app.engine.runtimes.get(id).channel;
  await channel.pair({id:'bot-a',userId:'owner-a'});await until(()=>f.fake.sent.length===1);assert.match(f.fake.sent[0].text,/你好/);assert.equal(f.fake.runs.length,0);
  channel.input('从微信开始','wx-1');await until(()=>f.fake.runs.length===1&&!f.app.engine.runtimes.get(id).active);
  const thread=f.app.store.assistant(id).thread_id;
  await c.request(`/api/assistants/${id}/messages`,{text:'从网页继续',requestId:randomUUID()});await until(()=>f.fake.runs.length===2&&!f.app.engine.runtimes.get(id).active);
  assert.equal(f.fake.runs[1].threadId,thread);await until(()=>f.fake.sent.some(s=>s.text.includes('从网页继续')));
  for(let i=0;i<12;i++)f.app.store.addMessage(id,{role:i%2?'assistant':'user',text:'历史'+i});
  await channel.pair({id:'bot-a',userId:'owner-a'});await until(()=>f.fake.runs.length===3&&!f.app.engine.runtimes.get(id).active);
  const prompt=f.fake.runs[2].text;assert.ok(prompt.includes('历史2'));assert.ok(prompt.includes('历史11'));assert.ok(!prompt.includes('历史0'));assert.match(prompt,/最近 10 条/);
  await until(()=>f.fake.sent.some(s=>s.text.includes('欢迎回来')));assert.ok(f.fake.sent.some(s=>s.text.includes('先确认你的问题')));
  assert.ok(f.fake.sent.every(s=>s.binding.accountId==='bot-a'));
  const other=await create(c,'其他');await c.request(`/api/assistants/${other}/activate`,{});
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
