// Opt-in real model check with synthetic memory; no production conversations or sends.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CodexHarness} from '../src/platform/adapters/codex.js';
import {changeMemory,memoryContext} from '../src/platform/workspace-files.js';
if(process.env.PLATFORM_AGENT_TEST!=='1')throw new Error('Set PLATFORM_AGENT_TEST=1');
const dir=await mkdtemp(join(tmpdir(),'wxbot-memory-probe-')),workspace=join(dir,'workspace'),history=join(dir,'memory-history');
const h=new CodexHarness({dir});let thread;
try{
 const initial=await changeMemory(workspace,history,{path:'MEMORY.md',version:null,content:'用户的记忆标记是 CEDAR-462。'});
 await h.prepare({onThread:id=>thread=id});
 const first=await h.run({text:'我在记忆文件里保存的记忆标记是什么？仅回答标记。',onEvent:()=>{}});assert.match(first.text,/CEDAR-462/);
 const updated=await changeMemory(workspace,history,{path:'MEMORY.md',version:initial.version,content:'用户的记忆标记现已改成 MAPLE-917，以此为准。'});
 const second=await h.run({text:'现在记忆文件里的记忆标记是什么？仅回答当前标记。',onEvent:()=>{}});assert.match(second.text,/MAPLE-917/);assert.doesNotMatch(second.text,/CEDAR-462/);assert.equal(h.threadId,thread);
 await changeMemory(workspace,history,{path:'MEMORY.md',version:updated.version,remove:true});assert.doesNotMatch(await memoryContext(workspace),/MAPLE-917/);
 console.log(JSON.stringify({create:'passed',editInSameThread:'passed',deleteSnapshot:'passed',wechatMessagesSent:0}));
}finally{await h.close();await rm(dir,{recursive:true,force:true});}
