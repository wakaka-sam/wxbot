import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Downloads } from '../src/downloads.js';
import { createPlatform } from '../src/platform/server.js';
import { mocks } from './platform/helpers.js';

const id = () => randomBytes(32).toString('hex');
test('下载链接跨重启去重、内容不可修改、有效期及文件完整性保护', async () => {
 const dir=await mkdtemp(join(tmpdir(),'wxbot-downloads-'));let now=1000;
 let store=new Downloads(dir,{publicUrl:'https://download.test',now:()=>now,ttl:1000});
 try {
  const key=id(),bytes=Buffer.from('private report');
  const [a,b]=await Promise.all([store.publish(bytes,'报告.xlsx',key),store.publish(bytes,'报告.xlsx',key)]);
  assert.deepEqual(a,b);assert(!a.url.includes(key));
  const token=new URL(a.url).pathname.split('/').at(-1);
  assert.deepEqual((await store.read(token)).bytes,bytes);
  await assert.rejects(store.publish(Buffer.from('changed'),'报告.xlsx',key),/不能修改/);
  await store.close();store=new Downloads(dir,{publicUrl:'https://download.test',now:()=>now,ttl:1000});
  assert.deepEqual(await store.publish(bytes,'报告.xlsx',key),a);
  await unlink(join(dir,token+'.bin'));await symlink('/etc/hosts',join(dir,token+'.bin'));
  await assert.rejects(store.read(token),/不可用/);
  const c=await store.publish(bytes,'later.txt',id());now=3000;
  await assert.rejects(store.read(new URL(c.url).pathname.split('/').at(-1)),/过期/);
  await store.cleanup();await assert.rejects(store.read('../anything'),/不存在/);
 } finally {await store.close();await rm(dir,{recursive:true,force:true});}
});

test('下载 HTTP：发布需宿主凭据，外部微信 GET/HEAD 免登录，过期拒绝、API 跨站保护保留',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-download-http-')),secret=id(),keyfile=join(dir,'key');
 await writeFile(keyfile,secret,{mode:0o600});
 const app=await createPlatform({dir,publicUrl:'https://download.test',downloadTokenFile:keyfile,adminPassword:'Test-password-731',engineOptions:mocks().options});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 try {
  const publish=(token,bytes='contents',key=id())=>fetch(base+'/internal/downloads',{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-File-Name':encodeURIComponent('中文.xlsx'),'X-Download-Id':key},body:bytes});
  assert.equal((await publish('wrong')).status,403);
  const response=await publish(secret);assert.equal(response.status,200);const link=await response.json();
  const path=new URL(link.url).pathname;
  const download=await fetch(base+path,{headers:{'Sec-Fetch-Site':'cross-site',Origin:'https://weixin.qq.com'}});
  assert.equal(download.status,200);assert.equal(await download.text(),'contents');
  assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(download.headers.get('cache-control'),'no-store');
  assert.equal(download.headers.get('referrer-policy'),'no-referrer');
  const head=await fetch(base+path,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await fetch(base+'/downloads/'+id())).status,404);
  assert.equal((await fetch(base+'/api/admin/users',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  const huge=await publish(secret,Buffer.alloc(20*1024*1024+1));assert.equal(huge.status,413);
  app.downloads.now=()=>link.expiresAt+1;
  assert.equal((await fetch(base+path)).status,404);
 } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});
