// Real model + sandbox + scheduler, with a synthetic user and fake WeChat.
// Never registers a production user or sends a real WeChat message.
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PlatformStore } from '../src/platform/store.js';
import { Engine } from '../src/platform/engine.js';
import { CodexHarness } from '../src/platform/adapters/codex.js';
import { mocks,until } from '../test/platform/helpers.js';

if(process.env.PLATFORM_AGENT_TEST!=='1')throw new Error('Set PLATFORM_AGENT_TEST=1 for the isolated real-model test');
const dir=await mkdtemp(join(tmpdir(),'wxbot-schedule-e2e-')),store=new PlatformStore(dir),fake=mocks();
const user=store.addUser('schedule-test','not-a-login-hash'),id=store.assistants(user.id)[0].id;
const engine=new Engine(store,dir,{channelFactory:fake.options.channelFactory,harnessFactory:o=>new CodexHarness(o)});
let timeout,legacy;
try{
 if(process.env.PLATFORM_LEGACY_HARNESS){
  const {CodexHarness:Legacy}=await import(pathToFileURL(process.env.PLATFORM_LEGACY_HARNESS));
  legacy=new Legacy({dir:join(dir,'assistants',id,'harness')});
  await legacy.prepare({onThread:thread=>store.thread(id,thread)});
  timeout=setTimeout(()=>void legacy.close(),180000);
  await legacy.run({text:'记住测试标记 LEGACY-SCHEDULE-739，只回复已记住。',onEvent:()=>{}});
  clearTimeout(timeout);await legacy.close();
  console.log(JSON.stringify({legacyThreadSeeded:true}));
 }
 const previousThread=store.assistant(id).thread_id;
 await engine.init();clearInterval(engine.scheduleTimer);
 const r=engine.runtimes.get(id);await r.channel.pair({id:'synthetic-bot',userId:'synthetic-owner'});
 // Test exact natural language, the actual sandbox command and host callback.
 r.channel.input('请设置一个自动任务：30 分钟后提醒我休息，提醒内容包含 SCHEDULE-E2E-739。现在就创建，不需要确认。');
 timeout=setTimeout(()=>void engine.close(),180000);
 await until(()=>engine.schedules.list(id).length===1&&!r.draining,170000);
 clearTimeout(timeout);
 let task=engine.schedules.list(id)[0];assert.equal(task.spec.type,'once');assert.match(task.prompt,/SCHEDULE-E2E-739/);
 assert(task.next_run_at>Date.now()+20*60000&&task.next_run_at<Date.now()+40*60000);
 assert(fake.sent.length>0);if(previousThread)assert.equal(store.assistant(id).thread_id,previousThread);console.log(JSON.stringify({legacyResume:Boolean(previousThread),naturalLanguageCreation:'passed',sandboxTool:'passed',spec:task.spec}));
 assert.equal(task.mode,'reminder');
 r.channel.input('把刚才的 SCHEDULE-E2E-739 提醒改成每个工作日（周一到周五，不判断法定节假日）北京时间上午9点，保持轻量提醒模式和提醒内容。现在修改。');
 timeout=setTimeout(()=>void engine.close(),180000);
 await until(()=>engine.schedules.list(id)[0]?.spec.type==='workdays'&&!r.draining,170000);clearTimeout(timeout);
 task=engine.schedules.list(id)[0];assert.equal(task.spec.time,'09:00');assert.equal(task.mode,'reminder');
 console.log(JSON.stringify({naturalLanguageEdit:'passed',workdays:'passed'}));
 const sentBefore=fake.sent.length;
 // Advance only the scheduler clock. Do not wait or mutate a production task.
 engine.tickSchedules(task.next_run_at+1);engine.tickSchedules(task.next_run_at+1);
 timeout=setTimeout(()=>void engine.close(),180000);
 await until(()=>engine.schedules.list(id)[0].last_job_state==='done'&&!r.draining&&!r.delivering,170000);
 clearTimeout(timeout);
 assert(fake.sent.slice(sentBefore).some(s=>s.text.includes('SCHEDULE-E2E-739')));
 assert(fake.sent.every(s=>s.binding.userId==='synthetic-owner'));
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs WHERE schedule_id=?').get(task.id).n,1);
 assert.equal(engine.schedules.history(id,task.id).runs[0].deliveries.every(d=>d.state==='sent'),true);
 console.log(JSON.stringify({scheduledExecution:'passed',deduplication:'passed',ownerOnlyDelivery:'passed',realWechatMessages:0}));
}finally{clearTimeout(timeout);await legacy?.close();await engine.close();store.close();await rm(dir,{recursive:true,force:true});}
