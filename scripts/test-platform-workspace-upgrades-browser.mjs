import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from '../test/platform/helpers.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const artifacts=process.env.BROWSER_ARTIFACTS||'/tmp/wxbot-workspace-browser';await mkdir(artifacts,{recursive:true});
const f=await fixture(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
async function nav(selector){if(!await page.locator(selector).isVisible())await page.click('#menu-open');await page.click(selector);}
async function screenshot(name,selector){await page.setViewportSize({width:320,height:844});const box=await page.locator(selector).boundingBox();assert(box.x>=0&&box.x+box.width<=321);assert(await page.locator(selector).evaluate(n=>n.scrollWidth<=n.clientWidth+1));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(artifacts,name+'.png'),fullPage:true});}
try{
 await page.goto(f.base);await page.click('#register-tab');await page.fill('#username','workspacebrowser');await page.fill('#password','Workspace-browser-739');await page.click('#auth-submit');await page.locator('#schedules-open').waitFor({state:'visible'});
 const id=f.app.store.assistants(f.app.store.userByName('workspacebrowser').id)[0].id;
 for(let i=0;i<12;i++)f.app.store.addMessage(id,{role:'assistant',text:'项目月报验收 '+i});
 await nav('#history-open');await page.fill('#history-query','月报');await page.click('#history-submit');await page.locator('.history-result').first().waitFor();assert.equal(await page.locator('.history-result').count(),10);await page.click('#history-more');await page.waitForFunction(()=>document.querySelectorAll('.history-result').length===12);
 await page.locator('.history-result').first().click();await page.locator('.history-target').waitFor();assert.match(await page.locator('.history-target').textContent(),/项目月报/);await screenshot('history-320','#history-dialog');await page.click('#history-close');
 await nav('#notifications-open');await page.locator('#notify-save').waitFor();await page.waitForFunction(()=>!document.querySelector('#notify-save').disabled);await page.check('#notify-quiet');await page.fill('#notify-start','23:00');await page.fill('#notify-end','08:00');await page.check('#notify-final');await page.fill('#notify-digest','30');await screenshot('notifications-320','#notifications-dialog');await page.click('#notify-save');await page.locator('#notifications-dialog').waitFor({state:'hidden'});
 await nav('#notifications-open');await page.waitForFunction(()=>!document.querySelector('#notify-save').disabled);assert(await page.locator('#notify-final').isChecked());assert.equal(await page.inputValue('#notify-digest'),'30');await page.click('#notifications-close');
 await nav('#schedules-open');await page.selectOption('#schedule-template','morning');await page.fill('#template-topic','前端技术');await page.click('#template-apply');assert.match(await page.inputValue('#schedule-prompt'),/前端技术/);assert.equal(await page.inputValue('#schedule-mode'),'agent');await page.click('#schedule-preview');await page.locator('#schedule-preview-result').filter({hasText:'接下来'}).waitFor();assert.equal(f.app.engine.schedules.list(id).length,0);await screenshot('templates-320','#schedules-dialog');await page.click('#schedule-submit');await page.locator('.schedule-card').waitFor();assert.equal(f.app.engine.schedules.list(id).length,1);await page.click('#schedules-close');
 await page.fill('#chat-input','/memory add 浏览器偏好：简洁');await page.click('#send');await page.locator('.message.command').filter({hasText:'已保存记忆'}).waitFor();await page.fill('#chat-input','/memory');await page.click('#send');await page.locator('.message.command').filter({hasText:'记忆 ·'}).waitFor();
 await page.reload();await page.locator('#chat-input').waitFor({state:'visible'});await nav('#history-open');await page.fill('#history-query','月报');await page.click('#history-submit');await page.locator('.history-result').first().waitFor();await page.click('#history-close');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({historySearchAndContext:'passed',notificationPersistence:'passed',templatePreviewAndCreate:'passed',memoryCommands:'passed',mobile:320,pageErrors:errors}));
}finally{await browser.close();await f.close();}
