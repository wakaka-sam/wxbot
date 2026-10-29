// Opt-in sandbox verification; actual subscription generation requires a second flag.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexHarness } from '../src/platform/adapters/codex.js';
if(process.env.PLATFORM_AGENT_TEST!=='1')throw new Error('Set PLATFORM_AGENT_TEST=1');
const real=process.env.PLATFORM_GROK_GENERATION_TEST==='1';
if(real&&!process.env.PLATFORM_GROK_AUTH)throw new Error('Set PLATFORM_GROK_AUTH to the protected subscription login');
const dir=await mkdtemp(join(tmpdir(),'wxbot-grok-smoke-')),harness=new CodexHarness({dir});
const synthetic=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(12)]);
let resultBytes;
try{
 await harness.prepare({onThread(){}});
 const command=async argv=>{const r=await harness.client.request('command/exec',{command:argv,cwd:'/workspace',timeoutMs:45000});assert.equal(r.exitCode,0,r.stderr+r.stdout);return r.stdout;};
 const skills=await harness.client.request('skills/list',{cwds:['/workspace'],forceReload:true});assert.match(JSON.stringify(skills),/grok-video/);
 assert.match(await command(['/bin/cat','/home/assistant/.agents/skills/grok-video/SKILL.md']),/grok-video generate/);
 const denied=await harness.client.request('command/exec',{command:['/bin/cat','/root/.config/wxbot-platform/grok/auth.json'],cwd:'/workspace',timeoutMs:5000});assert.notEqual(denied.exitCode,0);
 if(!real){const auth=join(dir,'dummy-auth.json');await writeFile(auth,'{}');harness.videoJobs.authFile=auth;harness.videoJobs.runner=async()=>synthetic;}
 await writeFile(join(dir,'workspace','prompt.txt'),'A small paper boat gently drifting on calm water, soft morning light, no text. One short video.');
 const jobId=randomUUID();let firstTurn;
 harness.client.run=async({input})=>{
  const turn=input[0].text.match(/grok-video --turn ([a-f0-9-]{36})/)[1];firstTurn=turn;
  const result=JSON.parse(await command(['/home/assistant/.local/bin/grok-video','generate','--turn',turn,'--request-id',jobId,'--prompt-file','/workspace/prompt.txt']));
  assert.equal(result.jobId,jobId);return {text:'submitted'};
 };
 await harness.run({text:'synthetic submit',onEvent(){}});
 // A new turn gets a new capability token, while the same background job survives.
 harness.client.run=async({input})=>{
  const turn=input[0].text.match(/grok-video --turn ([a-f0-9-]{36})/)[1];assert.notEqual(turn,firstTurn);
  const sendTurn=input[0].text.match(/wxbot send --turn ([a-f0-9-]{36})/)[1];
  const end=Date.now()+11*60*1000;let status,last;
  do{
   status=JSON.parse(await command(['/home/assistant/.local/bin/grok-video','status',jobId,'--turn',turn]));
   if(status.status!==last){console.log(JSON.stringify({videoStatus:status.status}));last=status.status;}
   if(!['queued','running'].includes(status.status))break;await delay(real?10000:100);
  }while(Date.now()<end);
  assert.equal(status.status,'complete',JSON.stringify(status));
  await command(['/home/assistant/.local/bin/grok-video','download',jobId,'--turn',turn,'--output','/workspace/result.mp4']);
  resultBytes=await readFile(join(dir,'workspace/result.mp4'));assert.equal(resultBytes.subarray(4,8).toString(),'ftyp');
  const sent=JSON.parse(await command(['/home/assistant/.local/bin/wxbot','send','--turn',sendTurn,'--file','/workspace/result.mp4']));assert.equal(sent.status,'sent');
  return{text:'downloaded'};
 };
 await harness.run({text:'synthetic retrieve',onEvent(){},onSend:async r=>{assert.equal(r.attachment.name,'result.mp4');assert.deepEqual(Buffer.from(r.attachment.data,'base64'),resultBytes);return{status:'sent',id:r.requestId};}});
 if(real&&process.env.PLATFORM_GROK_TEST_ARTIFACT)await copyFile(join(dir,'workspace/result.mp4'),process.env.PLATFORM_GROK_TEST_ARTIFACT);
 console.log(JSON.stringify({skillDiscovery:'passed',credentialIsolation:'passed',crossTurnJob:'passed',download:'passed',sendRelay:'passed',actualGrokGeneration:real,videoBytes:resultBytes.length,realWechatSends:0}));
}finally{await harness.close();await rm(dir,{recursive:true,force:true});}
