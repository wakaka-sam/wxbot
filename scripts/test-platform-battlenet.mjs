// Run on sg with deployment env; isolated temporary harness, no user sessions.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexHarness } from '../src/platform/adapters/codex.js';
if(process.env.PLATFORM_AGENT_TEST!=='1')throw new Error('Set PLATFORM_AGENT_TEST=1');
const dir=await mkdtemp(join(tmpdir(),'wxbot-battlenet-test-'));
let harness=new CodexHarness({dir});let threadId;
const legacy=process.env.PLATFORM_BROWSER_LEGACY_TEST==='1';
try{
 await harness.prepare({onThread:id=>threadId=id});
 harness.client.requestTimeout=90000;
 if(legacy){
  const probe=await harness.client.request('command/exec',{command:['/usr/local/bin/node','-e',`console.log(JSON.stringify({preload:process.env.NODE_OPTIONS,patched:require('playwright').chromium.launch.toString().includes('launch.apply')}))`],cwd:'/workspace',timeoutMs:10000});
  assert.equal(probe.exitCode,0,probe.stderr);console.log(probe.stdout);assert(JSON.parse(probe.stdout).patched,'legacy Chromium must be patched before script execution');
 }

 const result=await harness.client.request('command/exec',{command:['/usr/local/bin/node','-e',`
 const assert=require('node:assert/strict');
 const {openBrowser}=require('/home/assistant/.local/share/wxbot-tools/browser.cjs');
 (async()=>{
  const {browser,context,page,omitted}=${legacy ? `(await (async()=>{const {chromium}=require('playwright');const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],proxy:{server:process.env.HTTPS_PROXY||process.env.HTTP_PROXY}});const page=await browser.newPage();const omitted=[];page.on('requestfailed',r=>{if(new URL(r.url()).hostname==='rum.battlenet.com.cn')omitted.push({host:'rum.battlenet.com.cn',type:r.resourceType()});});return {browser,context:page.context(),page,omitted};})())` : 'await openBrowser()'};
  try{
   await context.route('https://example.com/wxbot-telemetry-test',route=>route.fulfill({contentType:'text/html',body:'<html><title>Telemetry probe</title><body>probe<script>fetch("https://rum.battlenet.com.cn/probe").catch(()=>document.body.dataset.done="yes")</script></body></html>'}));
   await page.goto('https://example.com/wxbot-telemetry-test');
   await page.waitForFunction(()=>document.body.dataset.done==='yes');
   assert(omitted.length>0);console.log(JSON.stringify({syntheticTelemetry:'passed'}));
   const response=await page.goto('https://shop.battlenet.com.cn/zh-cn/family/hearthstone/items/2136772/free-battlenet-shop-gift',{waitUntil:'domcontentloaded',timeout:45000});
   await page.waitForTimeout(7000);
   const text=await page.locator('body').innerText();
   assert.equal(response.status(),200);assert(new URL(page.url()).pathname.endsWith('/free-battlenet-shop-gift'));
   assert(!new URL(page.url()).searchParams.has('error'));assert(text.includes('战网商城免费赠礼'));
   console.log(JSON.stringify({url:page.url(),httpStatus:response.status(),product:'战网商城免费赠礼',omitted}));
  }finally{await browser.close();}
 })().catch(e=>{console.error(e);process.exitCode=1;});
 `],cwd:'/workspace',timeoutMs:75000});
 console.log(result.stdout);assert.equal(result.exitCode,0,result.stderr);
 const isolation=await harness.client.request('command/exec',{command:['/usr/bin/python3','-c',`import socket,pathlib,json
out={}
for host,port in [('127.0.0.1',3211),('169.254.169.254',80)]:
 try:
  s=socket.create_connection((host,port),2);s.close();out[host]='reachable'
 except Exception:out[host]='blocked'
try:
 open('/home/assistant/.codex/auth.json','rb').read(1);out['credentials']='readable'
except Exception:out['credentials']='blocked'
print(json.dumps(out))`],cwd:'/workspace',timeoutMs:10000});
 assert.equal(isolation.exitCode,0,isolation.stderr);assert.deepEqual(JSON.parse(isolation.stdout),{'127.0.0.1':'blocked','169.254.169.254':'blocked',credentials:'blocked'});console.log('network and credential isolation passed');
 if(process.env.PLATFORM_BROWSER_MODEL_TEST==='1'){
  const originalScript=`const {chromium}=require('playwright');
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],proxy:{server:process.env.HTTPS_PROXY||process.env.HTTP_PROXY}});const p=await browser.newPage();try{await p.goto('https://shop.battlenet.com.cn/zh-cn/family/hearthstone/items/2136772/free-battlenet-shop-gift',{waitUntil:'domcontentloaded',timeout:45000});await p.waitForTimeout(6000);console.log(JSON.stringify({url:p.url(),title:await p.title(),text:(await p.locator('body').innerText()).slice(0,16000)}));}catch(e){console.log(String(e))}await browser.close()})();
`;
  const scriptPath=join(dir,'workspace','check-battlenet.cjs');
  if(legacy)await writeFile(scriptPath,originalScript);
  // Persist at least one turn: an empty thread has no rollout to resume.
  await harness.run({text:'记住浏览器测试标记 BROWSER-RESUME-42，稍后继续检查工作区的浏览器脚本。本轮不要运行脚本，只回复已记住。',onEvent(){}});
  // Same thread and existing files survive restart, as in the reported incident.
  await harness.close();harness=new CodexHarness({dir});await harness.prepare({threadId,onThread:id=>assert.equal(id,threadId)});
  let usedBrowser=false;harness.client.lines.on('line',line=>{if(line.includes(legacy?'node /workspace/check-battlenet.cjs':'browser.cjs'))usedBrowser=true;});
  const prompt=legacy?'请原样执行 node /workspace/check-battlenet.cjs，不要修改或替换脚本。只根据脚本的实际输出报告页面是否成功打开、商品名称，不要登录、兑换或领取。':'使用浏览器实际访问 https://shop.battlenet.com.cn/zh-cn/family/hearthstone/items/2136772/free-battlenet-shop-gift 。只读查看页面，不登录、不兑换、不领取。简短报告看到的商品名称和是否成功打开，不需要微信发送。';
  const answer=await harness.run({text:prompt,onEvent(){}});
  assert(usedBrowser,'model should execute the requested browser path');assert.match(answer.text,/战网商城免费赠礼/);
  if(legacy)assert.equal(await readFile(scriptPath,'utf8'),originalScript,'legacy script must remain unchanged');
  console.log(JSON.stringify({legacy,resumedThread:true,scriptUnchanged:legacy,answer:answer.text}));
 }

}finally{await harness.close();await rm(dir,{recursive:true,force:true});}
