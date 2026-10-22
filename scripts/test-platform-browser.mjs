import assert from 'node:assert/strict';
import {fixture} from '../test/platform/helpers.js';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const artifacts=process.env.BROWSER_ARTIFACTS||'/tmp/wxbot-platform-browser';
await mkdir(artifacts,{recursive:true});
const f=await fixture(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
await page.goto(f.base);await page.locator('#auth-view').waitFor({state:'visible'});await page.screenshot({path:join(artifacts,'login.png')});
await page.click('#register-tab');await page.fill('#username','browseruser');await page.fill('#password','Browser-test-731');await page.click('#auth-submit');await page.locator('#app-view').waitFor({state:'visible'});
for(let i=1;i<=4;i++){await page.click('#create-open');await page.fill('#assistant-name',`助手 ${i}`);await page.click('#name-form button[type=submit]');await page.waitForFunction(i=>document.querySelector('#chat-title').textContent===`助手 ${i}`,i);if(i<4)await page.waitForFunction(()=>document.querySelector('#assistant-toggle').textContent==='停止助手');}
await page.locator('#limit-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#stop-options button').count(),3);await page.locator('#stop-options button').first().click();await page.locator('#limit-dialog').waitFor({state:'hidden'});assert.equal(await page.locator('#active-count').textContent(),'3 / 3');
await page.fill('#chat-input','WAIT 请先构思一下');await page.click('#send');await page.locator('.message.progress').first().waitFor();await page.fill('#chat-input','改为给我三个简短建议');await page.click('#send');await page.waitForFunction(()=>[...document.querySelectorAll('.message.assistant.chat')].some(e=>e.textContent.includes('回答：改为给我三个简短建议')));assert.ok(f.fake.interrupts.length);
await page.click('#pair-open');await page.click('#qr-refresh');await page.locator('#qr').waitFor({state:'visible'});const r=[...f.fake.channels.values()].at(-1);r.state.phase='verifying';r.emitState();await page.locator('#verify-form').waitFor({state:'visible'});await page.fill('#pair-code','2468');await page.click('#verify-form button');await page.locator('#disconnect').waitFor({state:'visible'});await page.click('[data-close=pair-dialog]');await page.locator('.message.greeting').waitFor();await page.locator('.message.summary[data-state=complete]').first().waitFor();await page.screenshot({path:join(artifacts,'workspace.png')});
await page.reload();await page.locator('.assistant-card').last().click();await page.locator('.message.greeting').waitFor();await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(artifacts,'mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.setViewportSize({width:1440,height:960});
await page.click('#logout');await page.locator('#auth-view').waitFor({state:'visible'});await page.fill('#username','admin');await page.fill('#password','Admin-test-password-731');await page.click('#auth-submit');await page.click('#admin-nav');await page.locator('.admin-user',{hasText:'browseruser'}).click();await page.locator('.assistant-card').last().click();await page.locator('#readonly-banner').waitFor({state:'visible'});assert.equal(await page.locator('#chat-form').isVisible(),false);await page.locator('.message.greeting').waitFor();await page.screenshot({path:join(artifacts,'admin.png')});
await page.click('#password-open');await page.fill('#old-password','Admin-test-password-731');await page.fill('#new-password','New-admin-password-731');await page.click('#password-form button[type=submit]');await page.locator('#password-dialog').waitFor({state:'hidden'});
assert.deepEqual(errors,[]);console.log('BROWSER_PASS register/login/create4/swap/interrupt/QR/pair/history/mobile/admin/password; JS errors=0');
}finally{await browser.close();await f.close();}
