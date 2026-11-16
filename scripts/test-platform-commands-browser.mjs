import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,until} from '../test/platform/helpers.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const artifacts=process.env.BROWSER_ARTIFACTS||'/tmp/wxbot-commands-browser';await mkdir(artifacts,{recursive:true});
const f=await fixture(),browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1280,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(f.base);await page.click('#register-tab');await page.fill('#username','commandbrowser');await page.fill('#password','Commands-browser-739');await page.click('#auth-submit');await page.locator('#schedules-open').waitFor({state:'visible'});
 const id=f.app.store.assistants(f.app.store.userByName('commandbrowser').id)[0].id,r=f.app.engine.runtimes.get(id);
 await page.fill('#chat-input','普通文字');assert(await page.locator('#send').isDisabled());
 await page.fill('#chat-input','/');await page.locator('#command-menu').waitFor({state:'visible'});assert.equal(await page.locator('#command-menu button').count(),18);
 await page.fill('#chat-input','/sta');await page.keyboard.press('Tab');assert.equal(await page.inputValue('#chat-input'),'/status');await page.keyboard.press('Enter');
 await page.locator('.message.system.command').filter({hasText:'微信：未连接'}).waitFor();assert.equal(f.fake.runs.length,0);
 await page.fill('#chat-input','/remind 30m 浏览器喝水');await page.click('#send');await page.locator('.message.system.command').filter({hasText:'已创建轻量提醒'}).waitFor();assert.equal(f.app.engine.schedules.list(id).length,1);
 await page.fill('#chat-input','/settings');await page.keyboard.press('Enter');await page.locator('.message.system.command').filter({hasText:'当前参数（只读）'}).waitFor();
 for(const width of [1280,390,320]){
  await page.setViewportSize({width,height:844});await page.fill('#chat-input','/');await page.locator('#command-menu').waitFor({state:'visible'});
  const bounds=await page.locator('#command-menu').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=width&&bounds.y>=0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(artifacts,`commands-${width}.png`),fullPage:true});
 }
 await page.keyboard.press('Escape');assert(await page.locator('#command-menu').isHidden());await page.click('#commands-open');await page.locator('#command-option-help').click();await page.fill('#chat-input','/help task');await page.keyboard.press('Enter');await page.locator('.message.system.command').filter({hasText:'run 会真实执行'}).waitFor();
 await r.channel.pair();await page.waitForFunction(()=>document.querySelector('#connection-gate').hidden);
 await page.fill('#chat-input','WAIT browser long');await page.click('#send');await until(()=>r.harness.pending);const before=f.fake.interrupts.length;
 await page.fill('#chat-input','/status');await page.click('#send');await page.locator('.message.system.command').filter({hasText:'执行：正在回复'}).waitFor();assert.equal(f.fake.interrupts.length,before);
 await page.fill('#chat-input','/stop');await page.click('#send');await until(()=>!r.draining);assert.equal(f.fake.runs.length,1);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({offlineCommands:'passed',suggestionsKeyboardAndClick:'passed',reminder:'passed',queryWithoutInterrupt:'passed',stop:'passed',mobile:[390,320],pageErrors:errors}));
}finally{await browser.close();await f.close();}
