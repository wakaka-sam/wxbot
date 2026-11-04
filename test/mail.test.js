import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestMail,mailEnabled } from '../src/mail-host.js';
test('mail authorization is bound to host user, with fixed target and read actions only',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wx-mail-')),file=join(dir,'token');await writeFile(file,'test-secret');
 const env={PLATFORM_MAIL_USER_ID:'owner',PLATFORM_MAIL_TOKEN_FILE:file};let calls=0;
 const fetcher=async(url,opts)=>{calls++;assert.ok(url.startsWith('http://127.0.0.1:24784/messages'));assert.equal(opts.headers.Authorization,'Bearer test-secret');assert.equal(opts.redirect,'error');return {ok:true,json:async()=>({messages:[]})};};
 try{
 assert.equal(mailEnabled('other',env),false);
 await assert.rejects(requestMail('other',{action:'list'},{env,fetcher}),/未获/);assert.equal(calls,0);
 for(const request of [{action:'send'},{action:'list',userId:'owner'},{action:'list',url:'http://evil'},{action:'read',accountId:'a'}])await assert.rejects(requestMail('owner',request,{env,fetcher}));
 await requestMail('owner',{action:'list',search:'a & b'},{env,fetcher});assert.equal(calls,1);
 await assert.rejects(requestMail('owner',{action:'accounts'},{env,fetcher:async()=>{throw Error('secret');}}),/邮件连接不可用/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('harness grants mail relay only to the configured user and closes it after the turn',async()=>{
 const {CodexHarness}=await import('../src/platform/adapters/codex.js');
 const {mkdir,access}=await import('node:fs/promises');
 const oldUser=process.env.PLATFORM_MAIL_USER_ID,oldFile=process.env.PLATFORM_MAIL_TOKEN_FILE;
 process.env.PLATFORM_MAIL_USER_ID='owner';process.env.PLATFORM_MAIL_TOKEN_FILE='/unused-host-secret';
 const dir=await mkdtemp(join(tmpdir(),'mail-harness-'));
 try{
  for(const userId of ['owner','other']){
   const root=join(dir,userId);await mkdir(join(root,'home'),{recursive:true});await mkdir(join(root,'workspace'));
   const h=new CodexHarness({dir:root,userId});let turn;
   h.client={run:async({input})=>{const text=input[0].text;assert.equal(text.includes('已授权只读邮件工具'),userId==='owner');turn=h.mailRelay?.turn;assert.equal(Boolean(turn),userId==='owner');return {};}};
   await h.run({text:'查看邮件',onEvent:()=>{}});
   if(turn)await assert.rejects(access(join(root,'home','.local/share/wxbot-mail',turn)));
  }
 }finally{
  if(oldUser===undefined)delete process.env.PLATFORM_MAIL_USER_ID;else process.env.PLATFORM_MAIL_USER_ID=oldUser;
  if(oldFile===undefined)delete process.env.PLATFORM_MAIL_TOKEN_FILE;else process.env.PLATFORM_MAIL_TOKEN_FILE=oldFile;
  await rm(dir,{recursive:true,force:true});
 }
});
