import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {WechatChannel} from '../../src/platform/adapters/wechat.js';
import {saveMedia,describeMedia} from '../../src/media.js';
import {until} from './helpers.js';

test('真实微信适配器：扫码事件、输入隔离、发送凭证去重及停止后恢复轮询',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-channel-test-'));
 let paired=0,polls=0,batch=0;const received=[],sent=[];
 const api={baseUrl:'https://ilinkai.weixin.qq.com',async qr(){return{qrcode:'test-qr',qrcode_img_content:'https://example.com/test-pair'};},async status(){return{status:'confirmed',bot_token:'fake-token',ilink_bot_id:'test-bot',ilink_user_id:'test-user'};},async updates(a,cursor,signal){polls++;await delay(10,undefined,{signal});return{get_updates_buf:'cursor-'+batch,msgs:batch++===0?[{message_id:1,message_type:1,message_state:2,from_user_id:'test-user',item_list:[{type:1,text_item:{text:'你好'}},{type:4,file_item:{file_name:'notes.txt'}}],context_token:'fake-context'},{message_id:2,message_type:1,message_state:2,from_user_id:'another-user',item_list:[{type:1,text_item:{text:'不应该读到'}}]}]:[]};},async sendText(a,text,id,context){sent.push({text,id,context});}};
 const channel=new WechatChannel({dir,api,bridgeOptions:{pollDelay:10,media:async()=>{const bytes=Buffer.from('REAL-CHANNEL-ATTACHMENT');return saveMedia(bytes,describeMedia(bytes,'notes.txt'),dir);}},validateBinding:a=>assert.equal(a.id,'test-bot')});
 channel.on('paired',()=>paired++);channel.on('input',m=>received.push(m));
 try{
 await channel.start();await channel.login();await until(()=>received.length===1);assert.equal(paired,1);assert.equal(received[0].text,'你好');assert.equal(received[0].attachments[0].name,'notes.txt');assert.equal((await channel.readAttachment(received[0].attachments[0])).toString(),'REAL-CHANNEL-ATTACHMENT');assert.deepEqual(channel.history()[0].attachments,received[0].attachments);assert.equal(channel.snapshot().phase,'connected');assert.equal(channel.snapshot().account.token,undefined);
 const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';assert.equal((await channel.send('问候',id,{accountId:'test-bot',userId:'test-user'})).status,'sent');await channel.send('问候',id,{});assert.equal(sent.length,1);assert.equal(sent[0].context,'fake-context');
 await channel.stop();const stopped=polls;await delay(40);assert.equal(polls,stopped);await channel.start();await until(()=>polls>stopped&&channel.snapshot().phase==='connected');assert.equal(paired,1);assert.equal(channel.history().length,1);
 await assert.rejects(channel.send('错误账号','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',{accountId:'other'}));assert.equal(sent.length,1);
 }finally{await channel.close();await rm(dir,{recursive:true,force:true});}
});
