import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,register,create,until} from './helpers.js';
const guest=async f=>{const c=f.client(),r=await c.request('/api/guest',{});assert.equal(r.status,200);assert.equal(r.data.user.role,'guest');return {c,user:r.data.user,id:await create(c)};};

test('游客显式创建且刷新复用，凭证持久化；未持有会话不能读私有接口，不能提权',async()=>{
 const f=await fixture();try{
  const empty=f.client();assert.equal((await empty.request('/api/auth')).data.user,null);assert.equal(f.app.store.users().length,1);
  assert.equal((await empty.request('/api/assistants')).status,401);assert.equal((await empty.request('/api/register',{username:'lostguest',password:'Test-password-731',bindGuest:true})).status,401);assert.equal(f.app.store.users().length,1);
  for(const headers of [{Origin:'https://evil.test'},{'Sec-Fetch-Site':'cross-site'},{'X-Wxbot-Platform':'0'}])assert.equal((await empty.request('/api/guest',{role:'admin'},headers)).status,403);
  const {c,user,id}=await guest(f);assert(c.cookie.includes('wxplatform_guest='));assert.equal((await c.request('/api/guest',{})).data.user.id,user.id);assert.equal(f.app.store.users().length,2);
  assert.equal((await c.request('/api/admin/users')).status,403);assert.equal((await c.request('/api/password',{oldPassword:'',newPassword:'New-password-739'})).status,400);
  assert.equal((await c.request('/api/login',{username:user.username,password:'unknown-password'})).status,401);
  await f.restart();assert.equal((await c.request('/api/auth')).data.user.id,user.id);assert.equal((await c.request('/api/assistants')).data.assistants[0].id,id);
  const other=await guest(f);assert.notEqual(other.id,id);assert.equal((await other.c.request(`/api/assistants/${id}/messages`)).status,404);
 }finally{await f.close();}
});

test('游客绑定微信可聊天及管理任务，绑定新账号原地保留全部资料和微信会话',async()=>{
 const f=await fixture();try{
  const {c,user,id}=await guest(f),r=f.app.engine.runtimes.get(id),beforeCookie=c.cookie;
  assert.equal((await c.request(`/api/assistants/${id}/channel/login`,{})).status,200);await r.channel.pair({id:'guest-bot',userId:'guest-owner'});r.channel.input('游客微信第一条','guest-first');await until(()=>f.fake.runs.length===1&&!r.draining&&!r.delivering);
  const thread=f.app.store.assistant(id).thread_id,home=join(f.dir,'assistants',id,'harness','workspace');await mkdir(home,{recursive:true});await writeFile(join(home,'MEMORY.md'),'游客期间的记忆');
  for(const text of ['/todo add 1h high 游客待办','/save link https://example.com 游客资料','/remind 1h 游客提醒','/notify quiet 23:00 08:00'])assert.equal((await c.request(`/api/assistants/${id}/messages`,{text,requestId:randomUUID()})).status,202);
  const messages=f.app.store.messages(id).map(m=>m.id),u=await c.request('/api/register',{username:'boundguest',password:'Guest-password-739',role:'admin'});assert.equal(u.status,201);assert.equal(u.data.user.id,user.id);assert.equal(u.data.user.role,'user');assert(!c.cookie.includes('wxplatform_guest='));assert.notEqual(c.cookie,beforeCookie);
  assert.equal((await fetch(f.base+'/api/assistants',{headers:{Cookie:beforeCookie}})).status,401);
  assert.equal(f.app.store.assistants(user.id)[0].id,id);assert.equal(f.app.store.assistant(id).thread_id,thread);assert.equal(f.app.engine.runtimes.get(id),r);assert.equal(r.channel.snapshot().account.id,'guest-bot');assert.deepEqual(f.app.store.messages(id).map(m=>m.id),messages);assert.equal(await readFile(join(home,'MEMORY.md'),'utf8'),'游客期间的记忆');assert.equal(f.app.engine.organizer.request(id,{kind:'todo',action:'list'}).total,1);assert.equal(f.app.engine.organizer.request(id,{kind:'collection',action:'list'}).total,1);assert.equal(f.app.engine.schedules.list(id).length,1);
  const login=f.client();assert.equal((await login.request('/api/login',{username:'boundguest',password:'Guest-password-739'})).data.user.id,user.id);assert.equal((await login.request('/api/assistants')).data.assistants[0].id,id);
  await f.restart();assert.equal((await c.request('/api/auth')).data.user.username,'boundguest');assert.equal(f.app.engine.runtimes.get(id).channel.snapshot().account.id,'guest-bot');
 }finally{await f.close();}
});

test('登录已有账号不覆盖双方空间，退出后恢复本浏览器游客；绑定后旧游客凭证不能恢复账号',async()=>{
 const f=await fixture();try{
  const member=await register(f,'member'),memberId=await create(member),{c,user,id}=await guest(f),guestCookie=c.cookie;
  f.app.store.addMessage(id,{role:'user',text:'游客私有'});f.app.store.addMessage(memberId,{role:'user',text:'账号私有'});
  const collision=await c.request('/api/register',{username:'member',password:'Test-password-731'});assert.equal(collision.status,409);assert.equal((await c.request('/api/auth')).data.user.role,'guest');assert.equal(c.cookie,guestCookie);
  assert.equal((await c.request('/api/login',{username:'member',password:'Test-password-731'})).status,200);assert.equal((await c.request('/api/assistants')).data.assistants[0].id,memberId);assert.equal((await c.request(`/api/assistants/${id}/messages`)).status,404);assert.equal((await c.request('/api/guest',{})).data.user.username,'member');
  await c.request('/api/logout',{});assert.equal((await c.request('/api/auth')).data.user,null);assert.equal((await c.request('/api/guest',{})).data.user.id,user.id);assert.equal((await c.request(`/api/assistants/${id}/messages`)).data.messages[0].text,'游客私有');
  await c.request('/api/register',{username:'newmember',password:'Test-password-731'});await c.request('/api/logout',{});const restored=await c.request('/api/guest',{}, {Cookie:guestCookie});assert.notEqual(restored.data.user.id,user.id);assert.equal(restored.data.user.role,'guest');
 }finally{await f.close();}
});

test('绑定并发只升级一次；事务故障不撤销游客访问；过期和伪造凭证不能认领原空间',async()=>{
 const f=await fixture();try{
  const {c,user,id}=await guest(f),cookie=c.cookie;
  const requests=await Promise.all(['boundone','boundtwo'].map(username=>fetch(f.base+'/api/register',{method:'POST',headers:{Cookie:cookie,'X-Wxbot-Platform':'1','Content-Type':'application/json'},body:JSON.stringify({username,password:'Bound-password-739'})})));assert.deepEqual(requests.map(r=>r.status).sort(),[201,409]);assert.equal(f.app.store.assistants(user.id)[0].id,id);
  const g=await guest(f),oldAudit=f.app.store.audit.bind(f.app.store);f.app.store.audit=()=>{throw new Error('simulate DB failure');};const result=await g.c.request('/api/register',{username:'failedbind',password:'Test-password-731'});assert.equal(result.status,400);assert.match(result.data.error,/simulate DB failure/);assert.equal(result.headers.get('set-cookie'),null);assert.equal((await g.c.request('/api/auth')).data.user.role,'guest');f.app.store.audit=oldAudit;
  f.app.store.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(g.user.id);assert.equal((await g.c.request('/api/auth')).data.user,null);assert.notEqual((await g.c.request('/api/guest',{})).data.user.id,g.user.id);
  const spoof=f.client(),r=await spoof.request('/api/guest',{userId:user.id,role:'admin'},{Cookie:'wxplatform_guest='+'f'.repeat(64)});assert.equal(r.data.user.role,'guest');assert.notEqual(r.data.user.id,user.id);
 }finally{await f.close();}
});
