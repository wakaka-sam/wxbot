import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlatformStore } from '../../src/platform/store.js';
import { Store } from '../../src/store.js';
import { migrateSingleAssistant } from '../../src/platform/single-assistant.js';
import { fixture,register,create,until } from './helpers.js';

test('迁移保留有微信登录的助手及历史，删除多余数据目录，补默认助手并可重复启动',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-single-'));const store=new PlatformStore(dir);
 try{
  const user=store.addUser('existing','hash'),old=store.assistants(user.id)[0],keep=randomUUID();
  store.db.prepare('INSERT INTO assistants(id,user_id,name,active,thread_id,created_at,updated_at) VALUES(?,?,?,1,?,?,?)').run(keep,user.id,'已连接','preserved-thread','2020-01-01','2020-01-01');
  store.addMessage(keep,{role:'user',text:'保留历史'});store.addMessage(old.id,{role:'user',text:'删除历史'});store.submit(old.id,'旧任务','web','key');store.queueDelivery('old-delivery',old.id,{text:'旧发送'});
  store.set('binding:old',old.id);store.set(`assistant-binding:${old.id}`,{id:'old'});store.set('binding:keep',keep);
  const channel=new Store(join(dir,'assistants',keep,'channel'));channel.set('account',{id:'keep',userId:'owner',token:'synthetic'});channel.close();
  await mkdir(join(dir,'assistants',old.id),{recursive:true});await writeFile(join(dir,'assistants',old.id,'old.txt'),'synthetic');
  const empty=store.addUser('empty','hash');store.db.prepare('DELETE FROM assistants WHERE user_id=?').run(empty.id);
  await migrateSingleAssistant(store,dir);
  assert.equal(store.assistants(user.id).length,1);assert.equal(store.assistants(user.id)[0].id,keep);assert.equal(store.assistant(keep).thread_id,'preserved-thread');
  assert.equal(store.messages(keep)[0].text,'保留历史');assert.equal(store.messages(old.id).length,0);assert.equal(store.pending(old.id).length,0);assert.equal(store.delivery('old-delivery'),undefined);
  assert.equal(store.get('binding:old'),null);assert.equal(store.get(`assistant-binding:${old.id}`),null);assert.equal(store.get('binding:keep'),keep);
  await assert.rejects(access(join(dir,'assistants',old.id)));await access(join(dir,'assistants',keep,'channel','clawbot.sqlite'));
  const defaultId=store.assistants(empty.id)[0].id;await migrateSingleAssistant(store,dir);assert.equal(store.assistants(empty.id)[0].id,defaultId);
  assert.throws(()=>store.db.prepare('INSERT INTO assistants(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(randomUUID(),user.id,'duplicate','',''),/UNIQUE/);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('无微信登录时保留最近使用助手；清理中断后重新启动继续删除目录',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-single-retry-'));const store=new PlatformStore(dir);
 try{
  const u=store.addUser('test','hash'),old=store.assistants(u.id)[0],latest=randomUUID();
  store.db.prepare('INSERT INTO assistants(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(latest,u.id,'最近','','9999');
  await migrateSingleAssistant(store,dir);assert.equal(store.assistants(u.id)[0].id,latest);
  await mkdir(join(dir,'assistants',old.id),{recursive:true});store.set('single-assistant:cleanup',[old.id]);await migrateSingleAssistant(store,dir);
  await assert.rejects(access(join(dir,'assistants',old.id)));assert.deepEqual(store.get('single-assistant:cleanup'),[]);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('未连接与失效状态拒绝网页使用；断开中断执行，重连保持原会话',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);
  const send=text=>c.request(`/api/assistants/${id}/messages`,{text,requestId:randomUUID()});
  for(const phase of ['offline','connecting','reconnecting','expired','paused']){
   r.channel.state={phase,account:phase==='offline'?null:{id:'gate',userId:'owner'}};r.channel.emitState();
   assert.equal((await send('blocked')).data.code,'WECHAT_REQUIRED');
  }
  assert.equal(f.fake.runs.length,0);assert.equal(f.app.store.pending(id).length,0);
  await r.channel.pair({id:'gate',userId:'owner'});assert.equal((await send('WAIT active')).status,202);await until(()=>f.fake.runs.length===1);
  const thread=f.app.store.assistant(id).thread_id;
  assert.equal((await c.request(`/api/assistants/${id}/channel/disconnect`,{})).status,200);
  assert.equal(r.active,null);assert.ok(f.fake.interrupts.includes(thread));assert.equal((await send('blocked after disconnect')).data.code,'WECHAT_REQUIRED');
  await r.channel.pair({id:'gate',userId:'owner'});await until(()=>!r.draining);
  assert.equal((await send('继续')).status,202);await until(()=>!r.draining);assert.equal(f.app.store.assistant(id).thread_id,thread);
 }finally{await f.close();}
});

test('微信在 turn 启动前失效，迟到的 started 仍触发中断并关闭执行器',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();
  let start,finish,started=false,interrupts=0,closed=false;
  r.harness.run=({onEvent})=>new Promise(resolve=>{finish=resolve;start=()=>{started=true;onEvent({type:'started'});onEvent({type:'message',itemId:'late',text:'不应展示',phase:'final_answer'});};});
  r.harness.interrupt=async()=>{interrupts++;if(started)finish();};r.harness.close=async()=>{closed=true;};
  await c.request(`/api/assistants/${id}/messages`,{text:'开始',requestId:randomUUID()});await until(()=>start);
  r.channel.state={phase:'expired',account:null};r.channel.emitState();await until(()=>interrupts===1);
  start();await until(()=>closed&&!r.draining);assert.ok(interrupts>=2);assert.ok(!f.app.store.messages(id).some(m=>m.text==='不应展示'));
  assert.equal((await c.request(`/api/assistants/${id}/messages`,{text:'拒绝',requestId:randomUUID()})).data.code,'WECHAT_REQUIRED');
 }finally{await f.close();}
});

test('旧频道数据库损坏时迁移失败，保留所有助手与历史',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-single-corrupt-'));const store=new PlatformStore(dir);
 try{
  const user=store.addUser('test','hash'),keep=store.assistants(user.id)[0],other=randomUUID();
  store.db.prepare('INSERT INTO assistants(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(other,user.id,'其他','','');
  await mkdir(join(dir,'assistants',other,'channel'),{recursive:true});await writeFile(join(dir,'assistants',other,'channel','clawbot.sqlite'),'not sqlite');
  store.addMessage(keep.id,{role:'user',text:'保留'});await assert.rejects(migrateSingleAssistant(store,dir));
  assert.equal(store.assistants(user.id).length,2);assert.equal(store.messages(keep.id)[0].text,'保留');assert.equal(store.get('single-assistant:v1'),null);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
