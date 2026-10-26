import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSendRelay } from '../src/send-relay.js';
import { parseArgs, validateSend, ATTACHMENT_LIMIT } from '../src/send-client.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
const exec=promisify(execFile),cli=new URL('../src/cli.js',import.meta.url).pathname;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfoAAAAASUVORK5CYII=','base64');
const command=async(args)=>{try{return JSON.parse((await exec(process.execPath,[cli,'send',...args],{env:{...process.env,WXBOT_RELAY_DIR:'',WXBOT_PROFILE:'',WXBOT_SERVER:''}})).stdout);}catch(e){return JSON.parse(e.stdout||e.stderr);}};

test('真实 CLI 传递图片/大文件字节、保留名称，重复去重且同 ID 改附件被拒绝',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-send-media-')),sent=[];
 const relay=await createSendRelay(dir,async r=>{sent.push(r);return{status:'sent',id:r.requestId};});
 try{
  const image=join(dir,'图片.png'),file=join(dir,'报告.bin');
  await writeFile(image,png);const bytes=Buffer.alloc(350000,0xa7);await writeFile(file,bytes);
  const base=['--relay-dir',dir,'--turn',relay.turn],id=randomUUID();
  assert.equal((await command([...base,'--request-id',id,'--image',image])).status,'sent');
  assert.equal((await command([...base,'--request-id',id,'--image',image])).status,'sent');assert.equal(sent.length,1);
  assert.equal(sent[0].attachment.name,'图片.png');assert.deepEqual(Buffer.from(sent[0].attachment.data,'base64'),png);
  assert.equal((await command([...base,'--file',file])).status,'sent');assert.deepEqual(Buffer.from(sent[1].attachment.data,'base64'),bytes);
  assert.equal((await command([...base,'--request-id',id,'--file',file])).status,'failed');assert.equal(sent.length,2);
  const link=join(dir,'link.png');await symlink(image,link);
  assert.equal((await command([...base,'--image',link])).status,'failed');
  const big=join(dir,'large');await writeFile(big,'x');await truncate(big,ATTACHMENT_LIMIT+1);
  assert.equal((await command([...base,'--file',big])).status,'failed');
  assert.throws(()=>parseArgs(['send','--image',image,'--file',file]),/每次/);
  assert.throws(()=>parseArgs(['send','--image',image,'caption']),/每次/);
  assert.throws(()=>validateSend('',{kind:'file',name:'../../secret',data:'YQ=='}),/无效/);
  assert.throws(()=>validateSend('',{kind:'file',name:'ok',data:'!!!!'}),/无效/);
  assert.throws(()=>validateSend('',{kind:'file',name:'ok',data:'YQ==',path:'/root/private'}),/无效/);
 }finally{await relay.close();await rm(dir,{recursive:true,force:true});}
});

test('CLI 本机 HTTP 图片/文件实际进入上传和媒体发送，重复请求不重复上传',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-send-media-http-')),uploads=[],sent=[];
 const seed=new Store(dir);seed.set('account',{id:'bot',userId:'owner',token:'fake'});seed.set('paused',true);seed.close();
 const api={async uploadMedia(a,bytes,description){uploads.push({bytes,description});return{type:description.kind==='image'?2:4};},async sendItem(a,item){sent.push(item);}};
 const app=await createApp({dir,api});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 try{
  const image=join(dir,'image.png'),file=join(dir,'report.txt');await writeFile(image,png);await writeFile(file,'REPORT');
  const base=['--server',`http://127.0.0.1:${app.server.address().port}`],id=randomUUID();
  assert.equal((await command([...base,'--image',image,'--request-id',id])).status,'sent');
  assert.equal((await command([...base,'--image',image,'--request-id',id])).status,'sent');
  assert.equal((await command([...base,'--file',file])).status,'sent');
  assert.deepEqual(sent.map(i=>i.type),[2,4]);assert.equal(uploads.length,2);
  assert.deepEqual(uploads[0].bytes,png);assert.equal(uploads[1].bytes.toString(),'REPORT');
  assert.equal(uploads[1].description.name,'report.txt');
 }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
