import assert from 'node:assert/strict';
import {saveMedia,describeMedia} from '../src/media.js';
import {fixture} from '../test/platform/helpers.js';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const artifacts=process.env.BROWSER_ARTIFACTS||'/tmp/wxbot-platform-browser';
await mkdir(artifacts,{recursive:true});
const f=await fixture(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
const external=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<a href="${f.base}/?from=external">Open assistant</a>`);});
await new Promise(resolve=>external.listen(0,'127.0.0.1',resolve));
try{
// Exercise message submission without the secure-context-only randomUUID API.
await page.addInitScript(()=>{
 Object.defineProperty(crypto,'randomUUID',{value:undefined});
 const OriginalEventSource=window.EventSource;window.testStreams=[];
 window.EventSource=class extends OriginalEventSource{constructor(...args){super(...args);window.testStreams.push(this);}};
});
// localhost -> 127.0.0.1 is a real cross-site top-level link, without forged headers.
await page.goto(`http://localhost:${external.address().port}`);
const landing=page.waitForResponse(response=>response.url()===f.base+'/?from=external');
await page.click('a');const response=await landing;
assert.equal(response.status(),200);assert.equal((await response.request().allHeaders())['sec-fetch-site'],'cross-site');
await page.locator('#auth-view').waitFor({state:'visible'});await page.screenshot({animations:'disabled',path:join(artifacts,'login.png')});
await page.click('#register-tab');await page.fill('#username','browseruser');await page.fill('#password','Browser-test-731');await page.click('#auth-submit');await page.locator('#app-view').waitFor({state:'visible'});
await page.waitForFunction(()=>document.querySelector('#chat-title').textContent==='我的助手');
assert.equal(await page.locator('#create-open').count(),0);assert.equal(await page.locator('#assistant-cards').count(),0);
assert.equal(await page.locator('#chat-input').isDisabled(),true);assert.equal(await page.locator('#connection-gate').isVisible(),true);
const r=[...f.fake.channels.values()].at(-1);
await page.click('#pair-open');await page.click('#qr-refresh');await page.locator('#qr').waitFor({state:'visible'});assert.match(await page.locator('#pair-qr-panel').textContent(),/连接成功后.*微信中输入消息/);
r.state.phase='verifying';r.emitState();await page.locator('#verify-form').waitFor({state:'visible'});await page.fill('#pair-code','2468');await page.click('#verify-form button');await page.locator('#pair-success').waitFor({state:'visible'});
assert.match(await page.locator('#pair-detail').textContent(),/在微信中输入消息/);
assert.equal(await page.locator('#pair-qr-panel').isVisible(),false);assert.equal(f.fake.sent.length,0);assert.equal(f.fake.runs.length,0);
await page.screenshot({animations:'disabled',path:join(artifacts,'pair-success.png')});
for(const width of [390,320]){
 await page.setViewportSize({width,height:844});
 const bounds=await page.locator('#pair-dialog').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width);
 await page.screenshot({animations:'disabled',path:join(artifacts,`pair-success-mobile-${width}.png`)});
}
await page.setViewportSize({width:1440,height:960});
r.input('你好，从微信开始','browser-first-input');await page.locator('#pair-dialog').waitFor({state:'hidden'});
await page.waitForFunction(()=>[...document.querySelectorAll('.message.assistant.chat')].some(e=>e.textContent.includes('回答：你好，从微信开始')));
// Existing history, repeated input and polling must not close a newly opened dialog.
await page.click('#pair-open');await page.locator('#pair-success').waitFor({state:'visible'});
r.input('你好，从微信开始','browser-first-input');
await page.waitForResponse(response=>response.url()===f.base+'/api/assistants');
assert.equal(await page.locator('#pair-dialog').isVisible(),true);
// Even if SSE is unavailable, the persisted input sequence closes it on polling.
await page.evaluate(()=>window.testStreams.forEach(s=>s.close()));r.input('新的微信消息','browser-next-input');
await page.locator('#pair-dialog').waitFor({state:'hidden'});
await page.reload();await page.locator('.message.user').first().waitFor();
await page.waitForFunction(()=>!document.querySelector('#chat-input').disabled);assert.equal(await page.locator('#connection-gate').isVisible(),false);
await page.fill('#chat-input','WAIT 请先构思一下');await page.click('#send');await page.locator('.message.progress').first().waitFor();await page.fill('#chat-input','改为给我三个简短建议');await page.click('#send');await page.waitForFunction(()=>[...document.querySelectorAll('.message.assistant.chat')].some(e=>e.textContent.includes('回答：改为给我三个简短建议')));assert.ok(f.fake.interrupts.length);
await page.fill('#chat-input','网页消息也同步到微信');await page.click('#send');await page.waitForFunction(()=>[...document.querySelectorAll('.message.assistant.chat')].some(e=>e.textContent.includes('回答：网页消息也同步到微信')));assert.equal(f.fake.sent.filter(s=>s.text==='[User]: 网页消息也同步到微信').length,1);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfoAAAAASUVORK5CYII=','base64');
const image=await saveMedia(png,describeMedia(png,'微信图片.png'),r.options.dir),bytes=Buffer.from('BROWSER-ATTACHMENT-CONTENT');
const doc=await saveMedia(bytes,describeMedia(bytes,'微信资料.txt'),r.options.dir);
r.input('','browser-attachments',[image,doc]);
await page.locator('.attachment-preview').waitFor();assert.equal(await page.locator('.message.user').filter({has:page.locator('.attachment-preview')}).locator('.message-body').count(),0);await page.waitForFunction(()=>document.querySelector('.attachment-preview').naturalWidth>0);
await page.waitForFunction(()=>[...document.querySelectorAll('.message.assistant.chat')].some(e=>e.textContent.includes('BROWSER-ATTACHMENT-CONTENT')));
const downloaded=await page.evaluate(async()=>await(await fetch([...document.querySelectorAll('.message-attachment a')].find(a=>a.textContent.includes('微信资料.txt')).href)).text());assert.equal(downloaded,'BROWSER-ATTACHMENT-CONTENT');
await page.screenshot({animations:'disabled',path:join(artifacts,'workspace.png')});
await page.reload();await page.locator('.message.user').first().waitFor();
for(const viewport of [{width:390,height:844},{width:320,height:568},{width:390,height:430}]){
 await page.setViewportSize(viewport);
 await page.waitForFunction(()=>Math.abs(document.querySelector('#app-view').getBoundingClientRect().height-innerHeight)<2);
 const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,composer:document.querySelector('#chat-form').getBoundingClientRect().toJSON(),header:document.querySelector('.topbar').getBoundingClientRect().toJSON(),height:innerHeight}));
 assert.equal(geometry.overflow,false);assert.ok(geometry.composer.bottom<=geometry.height&&geometry.composer.bottom>=geometry.height-40);assert.ok(geometry.composer.top>geometry.header.bottom);
 await page.click('#menu-open');await page.locator('#sidebar.open').waitFor();await page.waitForFunction(()=>Math.abs(document.querySelector('#sidebar').getBoundingClientRect().left)<1);assert.equal(await page.locator('#user-name').isVisible(),true);
 assert.equal(await page.locator('#menu-open').getAttribute('aria-expanded'),'true');await page.keyboard.press('Escape');await page.locator('#sidebar.open').waitFor({state:'hidden'});
}
await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('#sidebar').getBoundingClientRect().right<=0);await page.screenshot({animations:'disabled',path:join(artifacts,'mobile.png')});
await page.click('#menu-open');await page.waitForFunction(()=>Math.abs(document.querySelector('#sidebar').getBoundingClientRect().left)<1);await page.screenshot({animations:'disabled',path:join(artifacts,'mobile-sidebar.png')});await page.click('#sidebar-close');
await page.fill('#chat-input','WAIT 检查断开');await page.click('#send');await page.locator('#interrupt').waitFor();
await page.click('#pair-open');page.once('dialog',d=>d.accept());await page.click('#disconnect');await page.waitForFunction(()=>document.querySelector('#chat-input').disabled);await page.click('[data-close=pair-dialog]');
await page.locator('#connection-gate').waitFor();await page.waitForFunction(()=>!document.querySelector('#pair-open').disabled);await page.screenshot({animations:'disabled',path:join(artifacts,'mobile-connect-required.png')});
assert.equal(f.app.engine.runtimes.get(f.app.store.assistants(f.app.store.userByName('browseruser').id)[0].id).active,null);
await page.setViewportSize({width:1440,height:960});
await page.click('#logout');await page.locator('#auth-view').waitFor({state:'visible'});await page.fill('#username','admin');await page.fill('#password','Admin-test-password-731');await page.click('#auth-submit');await page.click('#admin-nav');await page.locator('.admin-user',{hasText:'browseruser'}).click();await page.locator('#readonly-banner').waitFor({state:'visible'});assert.equal(await page.locator('#chat-form').isVisible(),false);await page.locator('.message.user').first().waitFor();await page.screenshot({animations:'disabled',path:join(artifacts,'admin.png')});
// The directory exposes user activity, live status, filters and mobile navigation.
assert.match(await page.locator('#admin-user-detail').textContent(),/创建时间：.*最近使用：.*条消息/);
assert.match(await page.locator('#chat-title').textContent(),/browseruser/);
assert.equal(await page.locator('.message.user .message-meta span').first().textContent(),'browseruser');
await page.fill('#admin-search','no-such-user');await page.locator('#admin-empty').waitFor();
await page.fill('#admin-search','browseruser');assert.equal(await page.locator('.admin-user').count(),1);
await page.selectOption('#admin-filter','connected');await page.locator('#admin-empty').waitFor();
await r.pair({id:'browser-bot',userId:'owner'});await page.click('#admin-refresh');await page.locator('.admin-user .wechat-badge.online').waitFor();
assert.equal(await page.locator('#admin-connected').textContent(),'1');
r.state.phase='reconnecting';r.emitState();await page.locator('#admin-empty').waitFor();
await page.selectOption('#admin-filter','all');await page.locator('.admin-user .wechat-badge.pending').waitFor();
await page.fill('#admin-search','');await page.selectOption('#admin-sort','name');assert.match(await page.locator('.admin-user').first().textContent(),/admin/);
await page.selectOption('#admin-sort','recent');assert.match(await page.locator('.admin-user').first().textContent(),/browseruser/);
assert.match(await page.locator('.admin-user').filter({hasText:'admin'}).textContent(),/尚未使用/);
await page.route('**/api/admin/users',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'temporarily unavailable'})}));
await page.click('#admin-refresh');await page.locator('#admin-users-panel.stale').waitFor();
assert.match(await page.locator('#admin-refresh-status').textContent(),/更新失败/);assert.equal(await page.locator('.admin-user').count(),2);
await page.unroute('**/api/admin/users');await page.click('#admin-refresh');await page.waitForFunction(()=>!document.querySelector('#admin-users-panel').classList.contains('stale'));
await page.screenshot({animations:'disabled',path:join(artifacts,'admin.png')});
for(const width of [390,320]){
 await page.setViewportSize({width,height:844});await page.click('#admin-back');await page.locator('#admin-users-panel').waitFor();
 assert.equal(await page.locator('.chat-panel').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({animations:'disabled',path:join(artifacts,`admin-directory-${width}.png`)});
 await page.locator('.admin-user',{hasText:'browseruser'}).click();await page.locator('#readonly-banner').waitFor();
 assert.equal(await page.locator('#admin-users-panel').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.screenshot({animations:'disabled',path:join(artifacts,`admin-conversation-${width}.png`)});
}
await page.setViewportSize({width:1440,height:960});
await page.click('#password-open');await page.fill('#old-password','Admin-test-password-731');await page.fill('#new-password','New-admin-password-731');await page.click('#password-form button[type=submit]');await page.locator('#password-dialog').waitFor({state:'hidden'});
assert.deepEqual(errors,[]);console.log('BROWSER_PASS external-link/register/default-assistant/wechat-gate/interrupt/QR/pair/web-mirror/image-preview/attachment-download/history/mobile/drawer/disconnect/admin/password; JS errors=0');
}finally{await browser.close();await new Promise(resolve=>external.close(resolve));await f.close();}
