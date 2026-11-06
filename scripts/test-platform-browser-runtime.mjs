// Opt-in deployment acceptance. Uses synthetic, isolated assistants, never
// production conversations/accounts. No model turn, website form submission or login.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, readFile, stat, cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexHarness } from '../src/platform/adapters/codex.js';
if(process.env.PLATFORM_AGENT_TEST!=='1')throw new Error('Set PLATFORM_AGENT_TEST=1');
const artifacts=process.env.BROWSER_ARTIFACTS;
if(!artifacts)throw new Error('Set BROWSER_ARTIFACTS to a private output directory');
await mkdir(artifacts,{recursive:true,mode:0o700});
const dirs=[await mkdtemp('/tmp/wxbot-browser-accept-'),await mkdtemp('/tmp/wxbot-browser-peer-')];
const harnesses=dirs.map(dir=>new CodexHarness({dir}));
const [h,peer]=harnesses;
const command=async(h,code,timeoutMs=60000)=>{
 const r=await h.client.request('command/exec',{command:['/usr/local/bin/node','-e',code],cwd:'/workspace',timeoutMs});
 assert.equal(r.exitCode,0,r.stderr);return JSON.parse(r.stdout);
};
const report={};
try{
 await h.prepare({onThread(){}});h.client.requestTimeout=150000;
 const sockets=await h.client.request('command/exec',{command:['/usr/bin/python3','-c',`import socket,pathlib,json,subprocess
out={}
try:
 s=socket.socket(socket.AF_UNIX);s.close();out['unixSocket']='allowed'
except OSError as e:out['unixSocketErrno']=e.errno
for p in ['/home/assistant/.codex/auth.json','/proc/1/root/home/assistant/.codex/auth.json','/etc/wxbot-platform.env']:
 try:
  open(p,'rb').read(1);out[p]='READABLE'
 except OSError:out[p]='blocked'
for host,port in [('127.0.0.1',3211),('169.254.169.254',80)]:
 try:
  s=socket.create_connection((host,port),2);s.close();out[host]='reachable'
 except OSError:out[host]='blocked'
for url in ['http://127.0.0.1:3211/health','http://169.254.169.254/']:
 r=subprocess.run(['curl','--max-time','8','-sS','-o','/dev/null','-w','%{http_code}',url],capture_output=True,text=True);out[url]=r.stdout
out['seccomp']=[s.strip() for s in pathlib.Path('/proc/self/status').read_text().splitlines() if s.startswith('Seccomp:')][0]
print(json.dumps(out))`],cwd:'/workspace',timeoutMs:25000});
 assert.equal(sockets.exitCode,0,sockets.stderr);report.isolation=JSON.parse(sockets.stdout);
 assert.equal(report.isolation.unixSocketErrno,1);
 for(const [key,value] of Object.entries(report.isolation))if(key.startsWith('/')||key==='127.0.0.1'||key==='169.254.169.254')assert.equal(value,'blocked');
 assert.equal(report.isolation['http://127.0.0.1:3211/health'],'403');assert.equal(report.isolation['http://169.254.169.254/'],'403');
 report.functional=await command(h,String.raw`
 const assert=require('node:assert/strict'),fs=require('node:fs/promises');
 const {openBrowser}=require('/home/assistant/.local/share/wxbot-tools/browser.cjs');
 (async()=>{
  const first=await openBrowser({session:'acceptance',contextOptions:{viewport:{width:1365,height:900}}});
  let result;
  try{
   const {browser,context,page}=first;
   const response=await page.goto('https://example.com');
   assert.equal(response.status(),200);assert.equal(await page.title(),'Example Domain');assert.equal(await page.evaluate(()=>6*7),42);
   await page.screenshot({path:'/workspace/https.png'});
   // A synthetic dynamic form on a known HTTPS origin; no real reservation data.
   await context.route('https://example.com/wxbot-form',route=>route.fulfill({contentType:'text/html',body:'<html><title>Browser acceptance</title><body><h1>Dynamic form acceptance</h1><div id="app"></div><script>setTimeout(()=>{document.getElementById("app").innerHTML=\'<label>Test value <input id="test-value"></label><p id="status">Loaded by JavaScript</p><a href="/wxbot-download">Download test file</a>\'},100)</script></body></html>'}));
   await context.route('https://example.com/wxbot-download',route=>route.fulfill({contentType:'text/plain',headers:{'content-disposition':'attachment; filename="probe.txt"'},body:'synthetic-download'}));
   await page.goto('https://example.com/wxbot-form');await page.locator('#test-value').fill('synthetic-form-value');
   assert.equal(await page.locator('#test-value').inputValue(),'synthetic-form-value');
   await page.evaluate(()=>{document.cookie='wxbot_probe=synthetic; Path=/; Secure; SameSite=Lax';localStorage.setItem('wxbot_probe','synthetic');});
   const second=await context.newPage();await second.goto('https://example.com');
   assert(await second.evaluate(()=>document.cookie.includes('wxbot_probe=synthetic')));await second.close();
   await page.screenshot({path:'/workspace/form.png'});
   const downloading=page.waitForEvent('download');await page.locator('a').click();const download=await downloading;await download.saveAs('/workspace/download.txt');
   assert.equal(await fs.readFile('/workspace/download.txt','utf8'),'synthetic-download');
   await first.saveState();result={version:browser.version(),https:response.status(),javascript:true,dynamicForm:true,filled:true,sameContextCookie:true,download:true};
  }finally{await first.browser.close();}
  const resumed=await openBrowser({session:'acceptance'});
  try{await resumed.page.goto('https://example.com');assert(await resumed.page.evaluate(()=>document.cookie.includes('wxbot_probe=synthetic')&&localStorage.getItem('wxbot_probe')==='synthetic'));result.restoredState=true;}
  finally{await resumed.browser.close();}
  const {chromium}=require('playwright');
  for(const executablePath of ['/usr/bin/chromium','/usr/lib/chromium/chromium']){
   const b=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
   try{const p=await b.newPage();await p.goto('https://example.com');assert.equal(await p.title(),'Example Domain');}finally{await b.close();}
  }
  result.legacyPaths=true;
  const persistent=await chromium.launchPersistentContext('/home/assistant/.cache/wxbot-browser/persistent-test',{executablePath:'/usr/lib/chromium/chromium',headless:true});
  try{const p=await persistent.newPage();await p.goto('https://example.com');assert.equal(await p.title(),'Example Domain');result.persistentContext=true;}finally{await persistent.close();}
  await fs.rm('/home/assistant/.cache/wxbot-browser/persistent-test',{recursive:true,force:true});
  console.log(JSON.stringify(result));
 })().catch(e=>{console.error(e.message);process.exitCode=1});
 `,90000);
 const state=await stat(join(dirs[0],'home/.local/share/wxbot-browser/sessions/acceptance.json'));
 assert.equal(state.mode&0o777,0o600);report.stateFileMode='0600';
 const root=join(dirs[0],'home/.cache/wxbot-browser');
 assert.deepEqual((await readdir(root)).filter(s=>s.startsWith('run-')),[]);
 assert.deepEqual((await readdir(join(root,'tmp'))).filter(name=>!name.startsWith('codex-bwrap-synthetic-mount-targets-')),[]);report.cleanup=true;
 await peer.prepare({onThread(){}});peer.client.requestTimeout=60000;
 report.peer=await command(peer,String.raw`
 const assert=require('node:assert/strict'),fs=require('node:fs');
 const {openBrowser}=require('/home/assistant/.local/share/wxbot-tools/browser.cjs');
 (async()=>{assert(!fs.existsSync('/home/assistant/.local/share/wxbot-browser/sessions/acceptance.json'));
 const {browser,page}=await openBrowser({session:'acceptance'});try{await page.goto('https://example.com');assert(!(await page.evaluate(()=>document.cookie.includes('wxbot_probe')||localStorage.getItem('wxbot_probe'))));console.log(JSON.stringify({stateIsolated:true}));}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});
 `);
 await peer.close();
 report.airasia=await command(h,String.raw`
 const {openBrowser}=require('/home/assistant/.local/share/wxbot-tools/browser.cjs');
 (async()=>{const {browser,page}=await openBrowser({contextOptions:{viewport:{width:1365,height:1000}}});
 const result={};try{
  try{const response=await page.goto('https://www.airasia.com/check-in/',{waitUntil:'domcontentloaded'});result.httpStatus=response?.status();}catch(e){result.navigationError=e.name;}
  try{await page.locator('input:visible').first().waitFor({timeout:20000});}catch{}
  result.url=page.url();result.title=await page.title();
  result.visibleInputs=await page.locator('input:visible').evaluateAll(es=>es.map(e=>({type:e.type,name:e.name,placeholder:e.placeholder})));
  result.bodyText=(await page.locator('body').innerText()).slice(0,3500);
  result.formLoaded=result.visibleInputs.some(i=>i.type!=='checkbox'&&i.type!=='hidden');
  await page.screenshot({path:'/workspace/airasia.png',fullPage:true});
  result.screenshot=true;console.log(JSON.stringify(result));
 }finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exitCode=1});
 `,100000);
 for(const name of ['https.png','form.png','airasia.png'])await cp(join(dirs[0],'workspace',name),join(artifacts,name));
 await writeFile(join(artifacts,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify(report,null,2));
}finally{for(const h of harnesses)await h.close();for(const dir of dirs)await rm(dir,{recursive:true,force:true});}
