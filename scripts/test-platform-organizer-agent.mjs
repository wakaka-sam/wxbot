// Isolated real-model smoke test. Uses only synthetic data and a fake WeChat channel.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PlatformStore} from '../src/platform/store.js';
import {Engine} from '../src/platform/engine.js';
import {CodexHarness} from '../src/platform/adapters/codex.js';
import {mocks,until} from '../test/platform/helpers.js';
if(process.env.PLATFORM_AGENT_TEST!=='1')throw new Error('Set PLATFORM_AGENT_TEST=1 for isolated model test');
const dir=await mkdtemp(join(tmpdir(),'wxbot-organizer-agent-')),store=new PlatformStore(dir),fake=mocks(),user=store.addUser('organizer-test','not-a-login-hash'),id=store.assistants(user.id)[0].id;
const engine=new Engine(store,dir,{channelFactory:fake.options.channelFactory,harnessFactory:o=>new CodexHarness(o)});let legacy,timer;
try{
 if(process.env.PLATFORM_LEGACY_HARNESS){const {CodexHarness:Legacy}=await import(pathToFileURL(process.env.PLATFORM_LEGACY_HARNESS));legacy=new Legacy({dir:join(dir,'assistants',id,'harness')});await legacy.prepare({onThread:thread=>store.thread(id,thread)});timer=setTimeout(()=>void legacy.close(),180000);await legacy.run({text:'测试开始，只回复已准备。',onEvent:()=>{}});clearTimeout(timer);await legacy.close();}
 const thread=store.assistant(id).thread_id;await engine.init();clearInterval(engine.scheduleTimer);const r=engine.runtimes.get(id);await r.channel.pair({id:'synthetic-organizer',userId:'synthetic-owner'});
 async function turn(text){timer=setTimeout(()=>void engine.close(),180000);r.channel.input(text);await until(()=>!r.draining&&store.pending(id).length===0,170000);clearTimeout(timer);const failed=store.db.prepare("SELECT count(*) n FROM jobs WHERE state='failed'").get().n;assert.equal(failed,0);}
 await turn('请记一条待办：两小时后截止，标题 ORGANIZER-E2E-739 提交方案，优先级高。同时收藏 https://example.com/organizer-test ，标题测试资料，标签测试。现在执行，不需要再次确认。');
 let todos=engine.organizer.request(id,{kind:'todo',action:'list'}).items,collections=engine.organizer.request(id,{kind:'collection',action:'list'}).items;assert.equal(todos.length,1);assert.match(todos[0].title,/ORGANIZER-E2E-739/);assert.equal(todos[0].priority,'high');assert(Date.parse(todos[0].due_at)>Date.now()+100*60000);assert.equal(collections.length,1);assert.equal(collections[0].content,'https://example.com/organizer-test');assert(collections[0].tags.includes('测试'));assert.equal(engine.schedules.list(id).length,0);if(thread)assert.equal(store.assistant(id).thread_id,thread);
 console.log(JSON.stringify({legacyThreadResume:Boolean(thread),naturalLanguageTodoAndCollection:'passed',noDuplicateSchedule:true}));
 await turn('把刚才 ORGANIZER-E2E-739 的待办标记完成，并把刚才那条测试资料收藏标为已读。现在执行。');
 assert.equal(engine.organizer.get('todo',id,todos[0].id).status,'done');assert.equal(engine.organizer.get('collection',id,collections[0].id).status,'read');assert(fake.sent.every(m=>m.binding.userId==='synthetic-owner'));console.log(JSON.stringify({naturalLanguageCompleteAndRead:'passed',realWechatMessages:0}));
}finally{clearTimeout(timer);await legacy?.close();await engine.close();store.close();await rm(dir,{recursive:true,force:true});}
