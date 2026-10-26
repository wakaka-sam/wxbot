import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncCodexAuth } from '../../src/platform/adapters/codex-auth.js';
const auth=(expires,account='same')=>JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:account,access_token:`test.${Buffer.from(JSON.stringify({exp:expires})).toString('base64url')}.fake`,refresh_token:'synthetic'}});

test('同账号新凭据替换过期副本，保留助手更新的凭据，多个助手同步后不回退',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-auth-'));
 try{
  const root=join(dir,'canonical'),target=join(dir,'assistant'),source=join(dir,'source'),other=join(dir,'other');
  await writeFile(root,auth(10));await writeFile(target,auth(10));await writeFile(source,auth(100));
  const v=await syncCodexAuth(root,target,{sourceFile:source,now:20000});
  assert.equal(await readFile(target,'utf8'),auth(100));assert.equal(await readFile(root,'utf8'),auth(100));
  assert.equal((await stat(target)).mode&0o777,0o600);
  await writeFile(target,auth(200));
  const next=await syncCodexAuth(root,target,{sourceFile:source,now:20000});assert.notEqual(next,v);
  await Promise.all([syncCodexAuth(root,other,{sourceFile:source,now:20000}),syncCodexAuth(root,target,{sourceFile:source,now:20000})]);
  assert.equal(await readFile(other,'utf8'),auth(200));assert.equal(await readFile(root,'utf8'),auth(200));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('拒绝用其他账号替代；全过期时明确报错且不输出凭据、不覆盖文件',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-auth-expired-'));
 try{
  const root=join(dir,'canonical'),target=join(dir,'assistant'),source=join(dir,'source');
  await writeFile(root,auth(10));await writeFile(target,auth(10));await writeFile(source,auth(999,'different'));
  await assert.rejects(syncCodexAuth(root,target,{sourceFile:source,now:20000}),e=>e.message.includes('已过期')&&!e.message.includes('synthetic'));
  assert.equal(await readFile(target,'utf8'),auth(10));assert.equal(await readFile(root,'utf8'),auth(10));
  await writeFile(root,auth(100));await syncCodexAuth(root,target,{sourceFile:source,now:20000});
  assert.equal(await readFile(target,'utf8'),auth(100));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('不解析或复制 API key 到日志，缺少可选来源仍使用配置的凭据',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-auth-api-'));
 try{
  const root=join(dir,'canonical'),target=join(dir,'assistant');
  const raw=JSON.stringify({OPENAI_API_KEY:'synthetic-key'});await writeFile(root,raw);
  await syncCodexAuth(root,target,{sourceFile:join(dir,'missing')});assert.equal(await readFile(target,'utf8'),raw);
  await writeFile(root,'invalid-sensitive-value');
  await assert.rejects(syncCodexAuth(root,target),e=>e.message.includes('凭据不可用')&&!e.message.includes('invalid-sensitive'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
