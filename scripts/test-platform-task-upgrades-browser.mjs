import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture,until } from '../test/platform/helpers.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const artifacts=process.env.BROWSER_ARTIFACTS||'/tmp/wxbot-task-upgrades-browser';await mkdir(artifacts,{recursive:true});
const f=await fixture(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(f.base);await page.click('#register-tab');await page.fill('#username','taskbrowser');await page.fill('#password','Task-browser-739');await page.click('#auth-submit');await page.locator('#schedules-open').waitFor({state:'visible'});
 const id=f.app.store.assistants(f.app.store.userByName('taskbrowser').id)[0].id,r=f.app.engine.runtimes.get(id);await r.channel.pair();
 await page.click('#schedules-open');await page.fill('#schedule-name','喝水');await page.fill('#schedule-prompt','喝水时间到了');await page.click('#schedule-submit');await page.locator('.schedule-card').waitFor();
 await page.getByRole('button',{name:'编辑',exact:true}).click();await page.fill('#schedule-name','工作日喝水');await page.selectOption('#schedule-type','workdays');await page.fill('#schedule-time','10:30');
 await page.fill('#schedule-until',new Date(Date.now()+30*86400000).toISOString().slice(0,16));await page.click('#schedule-submit');await page.getByRole('heading',{name:'工作日喝水',exact:true}).waitFor();assert.match(await page.locator('.schedule-card').textContent(),/周一至周五 10:30/);
 const next=f.app.engine.schedules.list(id)[0].next_run_at;
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'立即试运行',exact:true}).click();await until(()=>f.app.engine.schedules.list(id)[0].last_job_state==='done'&&!r.delivering);
 await page.locator('summary').click();await page.getByText('微信已接收',{exact:false}).waitFor();assert.equal(f.fake.runs.length,0);assert.equal(f.app.engine.schedules.list(id)[0].next_run_at,next);
 await page.screenshot({path:join(artifacts,'task-history-desktop.png'),fullPage:true});
 for(const width of [390,320]){await page.setViewportSize({width,height:844});const box=await page.locator('#schedules-dialog').boundingBox();assert(box.x>=0&&box.x+box.width<=width);assert(await page.locator('#schedules-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await page.screenshot({path:join(artifacts,`task-history-mobile-${width}.png`),fullPage:true});}
 await page.click('#schedules-close');await page.setViewportSize({width:1280,height:900});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfoAAAAASUVORK5CYII=','base64');
 await page.locator('#upload-input').setInputFiles([{name:'browser.txt',mimeType:'text/plain',buffer:Buffer.from('BROWSER-UPLOAD-739')},{name:'image.png',mimeType:'image/png',buffer:png}]);
 await page.waitForFunction(()=>document.querySelectorAll('.upload-chip').length===2&&[...document.querySelectorAll('.upload-chip button')].every(b=>!b.disabled));await page.click('#send');await until(()=>f.fake.runs.length===1&&!r.draining);
 assert.match(f.fake.runs[0].text,/BROWSER-UPLOAD-739/);assert.equal(f.fake.runs[0].images.length,1);assert.equal(await page.locator('.upload-chip').count(),0);
 await page.evaluate(bytes=>{const data=new DataTransfer();data.items.add(new File([Uint8Array.from(bytes)],'pasted.png',{type:'image/png'}));document.querySelector('#chat-input').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},[...png]);
 await page.waitForFunction(()=>document.querySelector('.upload-chip button')&&!document.querySelector('.upload-chip button').disabled);await page.locator('.upload-chip button').click();assert.equal(await page.locator('.upload-chip').count(),0);
 await page.evaluate(()=>{const data=new DataTransfer();data.items.add(new File(['DROP-UPLOAD-739'],'drop.txt',{type:'text/plain'}));document.querySelector('#chat-form').dispatchEvent(new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true}));});
 await page.waitForFunction(()=>document.querySelector('.upload-chip button')&&!document.querySelector('.upload-chip button').disabled);
 for(const width of [390,320]){await page.setViewportSize({width,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(artifacts,`uploads-mobile-${width}.png`),fullPage:true});}
 await page.click('#send');await until(()=>f.fake.runs.length===2&&!r.draining);assert.match(f.fake.runs[1].text,/DROP-UPLOAD-739/);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({editAndWorkdays:'passed',manualReminderWithoutModel:'passed',executionDeliveryHistory:'passed',fileUpload:'passed',imagePaste:'passed',dragDrop:'passed',mobile:[390,320],pageErrors:errors}));
}finally{await browser.close();await f.close();}
