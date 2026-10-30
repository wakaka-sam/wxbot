import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSendTools } from '../../src/send-tools.js';
const { omitRequest, openBrowser } = createRequire(import.meta.url)('../../src/browser.cjs');
const request=(url,navigation=false)=>({url:()=>url,isNavigationRequest:()=>navigation});
test('browser omits only exact broken telemetry host subresources, never navigation or business endpoints',()=>{
 assert(omitRequest(request('https://rum.battlenet.com.cn/collect')));
 assert(!omitRequest(request('https://rum.battlenet.com.cn/',true)));
 for(const url of ['https://shop.battlenet.com.cn/','https://account.battlenet.com.cn/login','https://rum.battlenet.com.cn.evil.example/','https://rum.battlenet.com.cn@shop.battlenet.com.cn/','http://127.0.0.1/','https://example.com/','https://unknown.invalid/'])assert(!omitRequest(request(url)),url);
});
test('browser helper requires the managed proxy and is installed in the assistant environment',async()=>{
 const home=await mkdtemp(join(tmpdir(),'wxbot-browser-tools-'));
 const proxy=process.env.HTTP_PROXY,secure=process.env.HTTPS_PROXY;
 try{
  delete process.env.HTTP_PROXY;delete process.env.HTTPS_PROXY;
  await assert.rejects(openBrowser(),/需要平台网络代理/);
  await installSendTools(home);
  assert.equal(await readFile(join(home,'.local/share/wxbot-tools/browser.cjs'),'utf8'),await readFile(new URL('../../src/browser.cjs',import.meta.url),'utf8'));
 }finally{
  if(proxy===undefined)delete process.env.HTTP_PROXY;else process.env.HTTP_PROXY=proxy;
  if(secure===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=secure;
  await rm(home,{recursive:true,force:true});
 }
});
