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
  assert.match(await readFile(join(home,'.agents/skills/wxbot-browser/SKILL.md'),'utf8'),/saveState/);
  assert.match(await readFile(join(home,'.local/share/wxbot-tools/browser-preload.cjs'),'utf8'),/installBrowserCompatibility/);
  assert.equal(await readFile(join(home,'.local/share/wxbot-tools/browser.cjs'),'utf8'),await readFile(new URL('../../src/browser.cjs',import.meta.url),'utf8'));
 }finally{
  if(proxy===undefined)delete process.env.HTTP_PROXY;else process.env.HTTP_PROXY=proxy;
  if(secure===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=secure;
  await rm(home,{recursive:true,force:true});
 }
});

test('legacy Playwright launch keeps caller options and installs the guard before a page is created',async()=>{
 const {installBrowserCompatibility}=createRequire(import.meta.url)('../../src/browser.cjs');
 const calls=[];let handler;
 const context={setDefaultTimeout(){},setDefaultNavigationTimeout(){},async route(pattern,fn){calls.push('route');handler=fn;},async newPage(){calls.push('page');return {context:()=>context};}};
 let launchOptions,contextOptions;
 const browser={async newContext(options){contextOptions=options;return context;},async newPage(options){return (await this.newContext(options)).newPage();}};
 const playwright={chromium:{async launch(options){launchOptions=options;return browser;}}};
 installBrowserCompatibility(playwright);installBrowserCompatibility(playwright);
 const options={proxy:{server:'http://managed-proxy:1234'},headless:true,args:['--no-sandbox']};
 const result=await playwright.chromium.launch(options);
 await result.newPage({locale:'zh-CN'});
 assert.equal(launchOptions,options);assert.equal(contextOptions.locale,'zh-CN');assert.equal(contextOptions.serviceWorkers,'block');
 assert.deepEqual(calls,['route','page']);
 let action;
 await handler({request:()=>({...request('https://rum.battlenet.com.cn/collect'),resourceType:()=> 'fetch'}),abort:async()=>action='abort',continue:async()=>action='continue'});
 assert.equal(action,'abort');
 await handler({request:()=>request('https://shop.battlenet.com.cn/',true),abort:async()=>action='abort',continue:async()=>action='continue'});
 assert.equal(action,'continue');
});

test('managed legacy launches use the matching headless shell and proxy, and clean failed launches',async()=>{
 const {installBrowserCompatibility}=createRequire(import.meta.url)('../../src/browser.cjs');
 const {existsSync}=await import('node:fs');
 const secure=process.env.HTTPS_PROXY;process.env.HTTPS_PROXY='http://127.0.0.1:3128';
 let options;
 const playwright={chromium:{executablePath:()=>'/bundled/chrome',async launch(value){options=value;throw new Error('synthetic launch failure');}}};
 try {
  installBrowserCompatibility(playwright,{managed:true});
  for(const executablePath of ['/usr/bin/chromium','/usr/lib/chromium/chromium','/bundled/chrome']){
   await assert.rejects(playwright.chromium.launch({executablePath,channel:'chromium',headless:false,timeout:0,proxy:{server:'http://wrong-proxy'},args:['--disable-gpu']}),/synthetic launch failure/);
   assert.equal(options.executablePath,undefined);assert.equal(options.channel,undefined);assert.equal(options.headless,true);
   assert.deepEqual(options.proxy,{server:process.env.HTTPS_PROXY});assert.equal(options.timeout,30000);
   assert(options.args.includes('--disable-gpu'));assert(options.args.includes('--disable-dev-shm-usage'));
   assert.equal(existsSync(options.env.XDG_CONFIG_HOME),false,'failed launch must clean private runtime data');
  }
  await assert.rejects(playwright.chromium.launch({executablePath:'/custom/chrome'}),/仅支持平台配套/);
 }finally{if(secure===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=secure;}
});

test('named browser sessions reject paths and ambiguous state before launching',async()=>{
 const secure=process.env.HTTPS_PROXY;process.env.HTTPS_PROXY='http://127.0.0.1:3128';
 try{
  await assert.rejects(openBrowser({session:'../another-user'}),/session 须为/);
  await assert.rejects(openBrowser({session:'valid',contextOptions:{storageState:{}}}),/不能同时指定/);
 }finally{if(secure===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=secure;}
});
