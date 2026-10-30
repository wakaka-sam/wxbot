// Opt-in real CLI integration test. Run on sg with deployment env; uses only
// temporary synthetic data, and never reads production conversations.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CodexHarness } from '../src/platform/adapters/codex.js';

if (process.env.PLATFORM_AGENT_TEST !== '1') throw new Error('Set PLATFORM_AGENT_TEST=1 to run the isolated real-model test');
const dir=await mkdtemp(join(tmpdir(),'wxbot-agent-test-'));
let harness,threadId;
const command=async(argv,timeoutMs=25000)=>{
 const r=await harness.client.request('command/exec',{command:argv,cwd:'/workspace',timeoutMs});
 assert.equal(r.exitCode,0,r.stderr);return r.stdout;
};
try{
 if(process.env.PLATFORM_LEGACY_HARNESS){
  const {CodexHarness:Legacy}=await import(pathToFileURL(process.env.PLATFORM_LEGACY_HARNESS));
  harness=new Legacy({dir});await harness.prepare({onThread:id=>threadId=id});
  await harness.run({text:'记住本次测试标记 UPGRADE-739，只回复记住了。',onEvent:()=>{}});
  await harness.close();
 }
 // A project must not be able to replace the platform's permission profile.
 await mkdir(join(dir,'workspace','.codex'),{recursive:true});
 await writeFile(join(dir,'workspace','.codex','config.toml'),'sandbox_mode = "danger-full-access"\nweb_search = "disabled"\n');
 harness=new CodexHarness({dir});await harness.prepare({threadId,onThread:id=>{if(threadId)assert.equal(id,threadId);threadId=id;}});
 const scope=harness.scope;
 const limits=execFileSync('/usr/bin/systemctl',['show',scope,'-p','MemoryMax','-p','TasksMax','-p','CPUQuotaPerSecUSec'],{encoding:'utf8'});
 assert.match(limits,/MemoryMax=805306368/);assert.match(limits,/TasksMax=192/);
 const security=JSON.parse(await command(['/usr/bin/python3','-c',`import pathlib,socket,json,subprocess
out={}
for p in ['/home/assistant/.codex/auth.json','/proc/1/root/home/assistant/.codex/auth.json','/etc/wxbot-platform.env']:
 try:
  open(p,'rb').read(1);out[p]='READABLE'
 except Exception:out[p]='blocked'
for addr in [('127.0.0.1',3211),('169.254.169.254',80)]:
 try:
  s=socket.create_connection(addr,2);s.close();out[str(addr)]='CONNECTED'
 except Exception:out[str(addr)]='blocked'
pathlib.Path('/workspace/check.txt').write_text('WRITE_OK')
out['workspace']=pathlib.Path('/workspace/check.txt').read_text()
for url in ['http://127.0.0.1:3211/health','http://169.254.169.254/','https://example.com']:
 r=subprocess.run(['curl','--max-time','6','-sS','-o','/dev/null','-w','%{http_code}',url],capture_output=True,text=True);out[url]=r.stdout
print(json.dumps(out))`]));
 assert(!Object.values(security).includes('READABLE'));assert(!Object.values(security).includes('CONNECTED'));
 assert.equal(security.workspace,'WRITE_OK');assert.equal(security['http://127.0.0.1:3211/health'],'403');assert.equal(security['http://169.254.169.254/'],'403');assert.equal(security['https://example.com'],'200');
 const browser=JSON.parse(await command(['/usr/local/bin/node','-e',`const {openBrowser}=require('/home/assistant/.local/share/wxbot-tools/browser.cjs');(async()=>{const {browser:b,page:p}=await openBrowser();try{await p.goto('https://example.com');await p.screenshot({path:'/workspace/browser-check.png'});console.log(JSON.stringify({title:await p.title(),links:await p.locator('a').count()}));}finally{await b.close();}})().catch(e=>{console.error(e.message);process.exit(1)});`]));
 assert.equal(browser.title,'Example Domain');assert(browser.links>0);
 const kinds={};harness.client.lines.on('line',line=>{try{const e=JSON.parse(line);if(e.method==='item/started'){const t=e.params.item.type;kinds[t]=(kinds[t]||0)+1;}}catch{}});
 const result=await harness.run({text:'实际验收：运行 Python 计算 sum(i*i for i in range(1,11))，写入 /workspace/probe.txt 并读回；使用网页搜索工具查找 Python 官方 pathlib 文档，给出链接；调用一个子代理确认 17*19 并等待结果。若上文有测试标记，请复述。简短汇报实际结果。',onEvent:()=>{}});
 assert.equal((await readFile(join(dir,'workspace','probe.txt'),'utf8')).trim(),'385');
 assert(kinds.commandExecution>0);assert(kinds.webSearch>0);assert(kinds.subAgentActivity>0);
 assert.match(result.text,/323/);if(process.env.PLATFORM_LEGACY_HARNESS)assert.match(result.text,/UPGRADE-739/);
 await harness.close();harness=new CodexHarness({dir});await harness.prepare({threadId,onThread:id=>assert.equal(id,threadId)});
 const persisted=await command(['/bin/cat','/workspace/probe.txt']);assert.equal(persisted.trim(),'385');
 console.log(JSON.stringify({security:'passed',resourceLimits:'passed',browser:'passed',projectOverrideBlocked:'passed',legacyResume:Boolean(process.env.PLATFORM_LEGACY_HARNESS),persistentWorkspace:'passed',modelTools:kinds}));
}finally{await harness?.close();await rm(dir,{recursive:true,force:true});}
