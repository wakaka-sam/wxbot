import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,register,create} from './helpers.js';

test('admin directory reports safe live WeChat status and user-message activity',async()=>{
 const f=await fixture();
 try{
  const anon=f.client(),alice=await register(f),id=await create(alice),admin=f.client();
  assert.equal((await anon.request('/api/admin/users')).status,401);
  assert.equal((await alice.request('/api/admin/users')).status,403);
  assert.equal((await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'})).status,200);
  const get=async()=>{const result=await admin.request('/api/admin/users');assert.equal(result.status,200);return result.data.users.find(u=>u.username==='alice');};
  let u=await get();assert.equal(u.assistantId,id);assert.ok(u.created_at);assert.equal(u.lastUsedAt,null);assert.equal(u.messageCount,0);assert.equal(u.wechat.connected,false);
  const channel=f.app.engine.runtimes.get(id).channel;
  await channel.pair({id:'private-bot',userId:'private-owner',token:'private-token'});
  u=await get();assert.equal(u.wechat.connected,true);assert.equal(u.wechat.linked,true);
  assert.doesNotMatch(JSON.stringify(u),/private-|password|token|qr/);
  for(const phase of ['reconnecting','expired','paused','error']){channel.state.phase=phase;channel.emitState();u=await get();assert.equal(u.wechat.connected,false);assert.equal(u.wechat.phase,phase);}
  const message=f.app.store.addMessage(id,{role:'user',text:'web input',source:'web'});
  f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-01-01T01:00:00.000Z',message.id);
  f.app.store.addMessage(id,{role:'assistant',text:'newer reply'});
  await admin.request(`/api/assistants/${id}/messages`);
  u=await get();assert.equal(u.lastUsedAt,'2026-01-01T01:00:00.000Z');assert.equal(u.messageCount,2);
  const wechat=f.app.store.addMessage(id,{role:'user',source:'wechat',attachments:[{id:'image'}]});
  u=await get();assert.equal(u.lastUsedAt,wechat.created_at);assert.equal(u.messageCount,3);
  await channel.disconnect();u=await get();assert.equal(u.wechat.linked,false);assert.equal(u.wechat.phase,'offline');
 }finally{await f.close();}
});
