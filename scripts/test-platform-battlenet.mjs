// Run on sg with deployment env; isolated temporary harness, no user sessions.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexHarness } from '../src/platform/adapters/codex.js';
if(process.env.PLATFORM_AGENT_TEST!=='1')throw new Error('Set PLATFORM_AGENT_TEST=1');
const dir=await mkdtemp(join(tmpdir(),'wxbot-battlenet-test-'));
const harness=new CodexHarness({dir});
try{
 await harness.prepare({onThread(){}});
 const result=await harness.client.request('command/exec',{command:['/usr/local/bin/node','-e',`
 const assert=require('node:assert/strict');
 const {openBrowser}=require('/home/assistant/.local/share/wxbot-tools/browser.cjs');
 (async()=>{
  const {browser,context,page,omitted}=await openBrowser();
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
  let usedHelper=false;harness.client.lines.on('line',line=>{if(line.includes('browser.cjs'))usedHelper=true;});
  const answer=await harness.run({text:'使用浏览器实际访问 https://shop.battlenet.com.cn/zh-cn/family/hearthstone/items/2136772/free-battlenet-shop-gift 。只读查看页面，不登录、不兑换、不领取。简短报告看到的商品名称和是否成功打开，不需要微信发送。',onEvent(){}});
  assert(usedHelper,'model should use the platform browser helper');assert.match(answer.text,/战网商城免费赠礼/);console.log(JSON.stringify({modelUsesBrowserHelper:true,answer:answer.text}));
 }

}finally{await harness.close();await rm(dir,{recursive:true,force:true});}
