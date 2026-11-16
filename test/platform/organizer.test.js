import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,symlink,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {fixture,register,create,until} from './helpers.js';
import {updateNotifications} from '../../src/platform/notification-preferences.js';
import {dueTime} from '../../src/platform/organizer.js';
import {installOrganizerTools} from '../../src/organizer-tools.js';
import {createRequestRelay} from '../../src/request-relay.js';
const post=(c,id,text,requestId=randomUUID())=>c.request(`/api/assistants/${id}/messages`,{text,requestId});
const request=(c,id,r)=>c.request(`/api/assistants/${id}/organizer`,{requestId:randomUUID(),...r});
const write=(o,id,r,now)=>o.request(id,{requestId:randomUUID(),...r},now);

test('待办持久化、日期校验、今日含逾期、优先级、分页和幂等',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),o=f.app.engine.organizer,now=Date.parse('2026-11-16T10:00:00+08:00');
  const r={kind:'todo',action:'add',requestId:randomUUID(),title:'方案',dueAt:'1h',priority:'high'},first=o.request(id,r,now).item;
  assert.equal(o.request(id,r,now+2000).item.id,first.id);assert.throws(()=>o.request(id,{...r,title:'冲突'},now),/requestId/);
  write(o,id,{kind:'todo',action:'add',title:'未来',dueAt:'2d'},now);write(o,id,{kind:'todo',action:'add',title:'无截止'},now);
  assert.equal(o.request(id,{kind:'todo',action:'list',filter:'today'},now+86400000).items.length,1);
  assert.equal(o.request(id,{kind:'todo',action:'list'},now).items[0].title,'方案');
  for(const due of ['0m','36600d','2020-01-01T00:00:00Z','2026-11-31T10:00:00+08:00','2026-11-17 10:00','bad'])assert.throws(()=>dueTime(due,now));
  write(o,id,{kind:'todo',action:'done',id:first.id});assert.equal(o.request(id,{kind:'todo',action:'list',filter:'today'},now).items.length,0);
  await f.restart();assert.equal(f.app.engine.organizer.request(id,r,now).item.id,first.id);assert.equal(f.app.engine.organizer.get('todo',id,first.id).status,'done');
  assert.match((await post(c,id,'/todo done-list')).data.reply.text,/方案/);assert.equal(f.fake.runs.length,0);
 }finally{await f.close();}
});

test('截止提醒一次入队、免打扰延后、完成或删除取消积压、修改更新正文且重启不重发',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id),o=f.app.engine.organizer;await r.channel.pair();await until(()=>!r.delivering);clearInterval(f.app.engine.scheduleTimer);
  // Quiet until the next minute, including a midnight wrap.
  const mins=(Math.floor(Date.now()/60000)+480)%1440,hhmm=n=>String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
  updateNotifications(f.app.store,id,{quiet:{start:hhmm((mins+1439)%1440),end:hhmm((mins+2)%1440)},digestMinutes:30});
  const a=write(o,id,{kind:'todo',action:'add',title:'不会发送',dueAt:'1m'}).item;
  f.app.engine.tickSchedules(Date.now()+61000);f.app.engine.tickSchedules(Date.now()+61000);await until(()=>!r.delivering);
  assert.equal(f.app.store.deliveries(id).length,1);assert.equal(f.fake.sent.length,0);
  write(o,id,{kind:'todo',action:'done',id:a.id});updateNotifications(f.app.store,id,{quiet:null});f.app.engine.deliver(id);await until(()=>!r.delivering);assert.equal(f.fake.sent.length,0);
  const b=write(o,id,{kind:'todo',action:'add',title:'旧正文',dueAt:'1m'}).item;
  // Block channel quota, then edit while pending; stale text must not be sent.
  const send=r.channel.send.bind(r.channel);r.channel.send=async()=>({status:'blocked',budgetEpoch:0});f.app.engine.tickSchedules(Date.now()+61000);await until(()=>!r.delivering);
  write(o,id,{kind:'todo',action:'update',id:b.id,title:'新正文'});r.channel.send=send;r.blockedQuotaEpoch=null;f.app.engine.tickSchedules(Date.now()+61000);await until(()=>!r.delivering);
  assert.equal(f.fake.sent.length,1);assert.match(f.fake.sent[0].text,/新正文/);assert.doesNotMatch(f.fake.sent[0].text,/旧正文/);
  await f.restart();f.app.engine.tickSchedules(Date.now()+61000);await until(()=>!f.app.engine.runtimes.get(id).delivering);assert.equal(f.fake.sent.length,1);
  assert.equal(f.fake.runs.length,0);
 }finally{await f.close();}
});

test('完成发生在一次批量投递中途，也跳过已取得的旧待办队列快照',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();await until(()=>!r.delivering);const o=f.app.engine.organizer;
  let release;const gate=new Promise(r=>release=r),oldSend=r.channel.send.bind(r.channel);r.channel.send=async(...a)=>{await gate;return oldSend(...a);};
  const todo=write(o,id,{kind:'todo',action:'add',title:'取消目标',dueAt:'1m'}).item;f.app.engine.enqueueText(id,'先发送','first');f.app.engine.tickSchedules(Date.now()+61000);await until(()=>f.app.store.db.prepare("SELECT 1 FROM outbox WHERE state='sending'").get());write(o,id,{kind:'todo',action:'done',id:todo.id});release();await until(()=>!r.delivering);assert.equal(f.fake.sent.length,1);assert.equal(f.fake.sent[0].text,'先发送');
 }finally{await f.close();}
});

test('收藏保存消息快照和附件引用、标签搜索分页导出，拒绝跨用户和危险链接',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),b=await register(f,'bob'),bid=await create(b),o=f.app.engine.organizer;
  const attachment={id:randomUUID(),kind:'file',name:'计划.txt',size:20};const m=f.app.store.addMessage(id,{role:'assistant',text:'关键资料',attachments:[attachment]});
  const item=write(o,id,{kind:'collection',action:'add',type:'message',messageSeq:m.seq,tags:['项目']}).item;
  f.app.store.updateMessage(m.id,'修改后的原文','complete');assert.equal(o.get('collection',id,item.id).content,'关键资料');
  assert.equal(write(o,id,{kind:'collection',action:'add',type:'file',attachmentId:attachment.id}).item.attachments[0].id,attachment.id);
  assert.throws(()=>write(o,bid,{kind:'collection',action:'add',type:'message',messageSeq:m.seq}),/找不到/);assert.throws(()=>write(o,bid,{kind:'collection',action:'add',type:'file',attachmentId:attachment.id}),/找不到/);
  for(const address of ['javascript:alert(1)','file:///etc/passwd','https://user:password@example.com'])assert.throws(()=>write(o,id,{kind:'collection',action:'add',type:'link',url:address}));
  for(let i=0;i<11;i++)write(o,id,{kind:'collection',action:'add',type:'link',url:'https://example.com/'+i,title:'资料 '+i,tags:['项目']});
  assert.equal(o.request(id,{kind:'collection',action:'list',tag:'项目',q:'资料',page:2}).items.length,2);
  write(o,id,{kind:'collection',action:'read',id:item.id});assert.equal(o.request(id,{kind:'collection',action:'list',filter:'read'}).total,1);
  assert.equal(o.request(id,{kind:'collection',action:'export'}).items.length,13);
  assert.equal((await b.request(`/api/assistants/${id}/organizer?kind=todo`)).status,404);
  const admin=f.client();await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'});assert.equal((await admin.request(`/api/assistants/${id}/organizer?kind=collection`)).status,403);assert.equal((await request(admin,id,{kind:'todo',action:'done',id:item.id})).status,404);
  assert.match((await post(c,id,`/collection tags ${item.id} 学习,参考`)).data.reply.text,/学习/);await f.restart();assert.equal(f.app.engine.organizer.get('collection',id,item.id).tags[0],'学习');
 }finally{await f.close();}
});

test('向导逐步预览不写入、确认幂等、取消、跨渠道隔离、超时及普通聊天不接管',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),o=f.app.engine.organizer;
  const guide=async value=>(await post(c,id,'/guide'+(value?' '+value:''))).data.reply.text;
  await guide('');await guide('1');await guide('写方案');assert.match(await guide('bad'),/命令未执行/);await guide('1h');const preview=await guide('1'),token=preview.match(/confirm ([a-f0-9]{6})/)[1];
  assert.equal(o.request(id,{kind:'todo',action:'list'}).total,0);assert.match(await guide('confirm wrong'),/命令未执行/);
  const wechat=f.app.engine.submit(id,'/guide confirm '+token,'wechat','wrong-channel');assert.match(wechat.reply.text,/向导未开始/);
  await f.restart();const key=randomUUID(),confirmed=await post(c,id,'/guide confirm '+token,key);assert.match(confirmed.data.reply.text,/已创建/);assert((await post(c,id,'/guide confirm '+token,key)).data.duplicate);assert.equal(f.app.engine.organizer.request(id,{kind:'todo',action:'list'}).total,1);
  await guide('');await guide('3');await guide('https://example.com');await guide('资料');await guide('工作');await guide('cancel');assert.equal(f.app.engine.organizer.request(id,{kind:'collection',action:'list'}).total,0);
  await guide('');const row=f.app.store.db.prepare('SELECT state FROM guide_sessions WHERE assistant_id=?').get(id),state=JSON.parse(row.state);state.expires=0;f.app.store.db.prepare('UPDATE guide_sessions SET state=? WHERE assistant_id=?').run(JSON.stringify(state),id);assert.match(await guide('1'),/超过 30 分钟/);
  const r=f.app.engine.runtimes.get(id);await r.channel.pair();await guide('');await post(c,id,'普通聊天照常');await until(()=>!r.draining);assert.equal(f.fake.runs.length,1);
 }finally{await f.close();}
});

test('向导提醒和通知确认才生效，返回修改使旧确认码失效',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),g=async v=>(await post(c,id,'/guide '+v)).data.reply.text;
  await g('start');await g('2');await g('休息');let preview=await g('daily 09:00'),old=preview.match(/confirm ([a-f0-9]{6})/)[1];assert.equal(f.app.engine.schedules.list(id).length,0);await g('back');preview=await g('daily 10:00');assert.match(await g('confirm '+old),/命令未执行/);await g('confirm '+preview.match(/confirm ([a-f0-9]{6})/)[1]);assert.equal(f.app.engine.schedules.list(id)[0].spec.time,'10:00');
  await g('start');await g('4');await g('23:00 08:00');await g('1');preview=await g('30');assert.equal(f.app.store.get('notifications:'+id),null);await g('confirm '+preview.match(/confirm ([a-f0-9]{6})/)[1]);assert.equal(f.app.store.get('notifications:'+id).digestMinutes,30);
 }finally{await f.close();}
});

test('命令事务回滚不遗留待办，已结束或自动执行轮次不能写个人资料',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id);await r.channel.pair();const save=f.app.store.queueDelivery;f.app.store.queueDelivery=()=>{throw new Error('outbox failed');};
  assert.throws(()=>f.app.engine.submit(id,'/todo add 1h high 测试','wechat','rollback'),/outbox/);assert.equal(f.app.engine.organizer.request(id,{kind:'todo',action:'list'}).total,0);f.app.store.queueDelivery=save;
  const request={kind:'todo',action:'add',requestId:randomUUID(),title:'不应创建'};assert.throws(()=>f.app.engine.organizeFromTool(id,{},request),/轮次已结束/);
  const run={scheduled:true};r.active=run;assert.throws(()=>f.app.engine.organizeFromTool(id,run,request),/自动执行期间/);assert.equal(f.app.engine.organizeFromTool(id,run,{kind:'todo',action:'list'}).total,0);r.active=null;
 }finally{await f.close();}
});

test('沙箱工具安装、帮助和实际JSON中继，可重复安装并拒绝符号链接目录',async()=>{
 const home=await mkdtemp(join(tmpdir(),'organizer-tool-'));let relay;
 try{
  await installOrganizerTools(home,{visibleHome:home});await installOrganizerTools(home,{visibleHome:home});
  relay=await createRequestRelay(home,r=>({echo:r}),{namespace:'wxbot-organizer',label:'待办收藏',maxBytes:65536});
  const run=(args,body='')=>new Promise((resolve,reject)=>{const child=execFile(join(home,'.local/bin/wxbot-organize'),args,(error,out,err)=>error?reject(new Error(err)):resolve(out));child.stdin.end(body);});
  assert.match(await run(['--help']),/messageSeq/);const result=JSON.parse(await run(['--turn',relay.turn],JSON.stringify({kind:'todo',action:'list'})));assert.equal(result.echo.kind,'todo');
  await relay.close();relay=null;await rm(join(home,'.local/share/wxbot-tools'),{recursive:true});await mkdir(join(home,'outside'));await symlink(join(home,'outside'),join(home,'.local/share/wxbot-tools'));await assert.rejects(()=>installOrganizerTools(home,{visibleHome:home}));
 }finally{await relay?.close();await rm(home,{recursive:true,force:true});}
});

test('提醒落库故障回滚后可重试，不影响其他待办；删除等待提醒后不再投递',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c),r=f.app.engine.runtimes.get(id),o=f.app.engine.organizer;await r.channel.pair();await until(()=>!r.delivering);
  const a=write(o,id,{kind:'todo',action:'add',title:'存储恢复',dueAt:'1m'}).item,old=f.app.store.queueDelivery.bind(f.app.store);let errors=0;f.app.engine.on('event',e=>{if(e.type==='error')errors++;});f.app.store.queueDelivery=()=>{throw new Error('模拟磁盘写入失败');};
  f.app.engine.tickSchedules(Date.now()+61000);assert.equal(errors,1);assert.equal(o.get('todo',id,a.id).reminded_revision,null);assert.equal(f.app.store.messages(id).length,0);
  f.app.store.queueDelivery=old;r.channel.send=async()=>({status:'blocked',budgetEpoch:0});f.app.engine.tickSchedules(Date.now()+61000);await until(()=>!r.delivering);assert.equal(f.app.store.deliveries(id).length,1);write(o,id,{kind:'todo',action:'remove',id:a.id});assert.equal(f.app.store.deliveries(id).length,0);f.app.engine.tickSchedules(Date.now()+120000);assert.equal(f.app.store.messages(id).length,1);
 }finally{await f.close();}
});
