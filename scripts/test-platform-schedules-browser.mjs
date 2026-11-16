import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../test/platform/helpers.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const artifacts=process.env.BROWSER_ARTIFACTS||'/tmp/wxbot-schedules-browser';await mkdir(artifacts,{recursive:true});
const f=await fixture(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(f.base);await page.click('#register-tab');await page.fill('#username','schedulebrowser');await page.fill('#password','Schedule-browser-739');await page.click('#auth-submit');
 await page.locator('#schedules-open').waitFor({state:'visible'});assert(!(await page.locator('#chat-input').isDisabled()));assert(await page.locator('#send').isDisabled());
 await page.click('#schedules-open');await page.locator('#schedules-empty').waitFor({state:'visible'});
 await page.fill('#schedule-name','早间喝水');await page.fill('#schedule-prompt','提醒我喝水');await page.click('#schedule-submit');
 await page.locator('.schedule-card').waitFor();assert.equal(await page.locator('.schedule-card').count(),1);
 assert.match(await page.locator('.schedule-card').textContent(),/每天 09:00（Asia\/Shanghai）/);
 await page.getByRole('button',{name:'暂停',exact:true}).click();await page.getByRole('button',{name:'恢复',exact:true}).waitFor();
 await page.getByRole('button',{name:'恢复',exact:true}).click();await page.getByRole('button',{name:'暂停',exact:true}).waitFor();
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'取消任务',exact:true}).click();await page.getByText('已取消',{exact:true}).waitFor();
 await page.fill('#schedule-name','单次测试');await page.fill('#schedule-prompt','提醒一次');await page.selectOption('#schedule-type','once');
 const tomorrow=new Date(Date.now()+86400000+8*3600000).toISOString().slice(0,16);await page.fill('#schedule-at',tomorrow);await page.click('#schedule-submit');
 await page.waitForFunction(()=>document.querySelectorAll('.schedule-card').length===2);
 assert.equal(f.app.engine.schedules.list(f.app.store.assistants(f.app.store.userByName('schedulebrowser').id)[0].id).find(t=>t.name==='单次测试').spec.at,new Date(tomorrow+':00+08:00').toISOString());
 await page.screenshot({path:join(artifacts,'desktop.png'),fullPage:true});
 for(const width of [390,320]){
  await page.setViewportSize({width,height:844});
  const box=await page.locator('#schedules-dialog').boundingBox();assert(box.x>=0&&box.x+box.width<=width);
  assert(await page.locator('#schedules-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
  await page.screenshot({path:join(artifacts,`mobile-${width}.png`),fullPage:true});
 }
 await page.click('#schedules-close');await page.click('#menu-open');await page.click('#schedules-open');await page.locator('.schedule-card').first().waitFor();
 assert.equal(await page.locator('.schedule-card').count(),2);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({newUserWithoutWechat:'passed',createPauseResumeCancel:'passed',oneTimeTimezone:'passed',mobile:[390,320],pageErrors:errors}));
}finally{await browser.close();await f.close();}
