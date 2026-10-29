import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { normalizeAttachments, prepareAttachments, readChannelAttachment } from '../../src/platform/attachments.js';
import { saveMedia, describeMedia } from '../../src/media.js';
import { CodexHarness } from '../../src/platform/adapters/codex.js';
import { PlatformStore } from '../../src/platform/store.js';
import { fixture, register, create, until } from './helpers.js';

const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfoAAAAASUVORK5CYII=','base64');
async function saved(dir,bytes,name){return saveMedia(bytes,describeMedia(bytes,name),dir);}

test('附件只读取指定助手媒体目录，拒绝路径穿越、符号链接及超限元数据',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-attachment-test-'));
 try{
  const a=await saved(dir,PNG,'截图.png');assert.deepEqual(await readChannelAttachment(dir,a.id),PNG);
  await assert.rejects(readChannelAttachment(dir,'../../auth.json'),/标识/);
  const link=randomUUID();await symlink('/etc/hosts',join(dir,'media',link));await assert.rejects(readChannelAttachment(dir,link),/路径/);
  const values=normalizeAttachments([{name:'../../secret\n.txt',id:'../../auth.json',path:'/etc/passwd',mime:'text/html'}]);
  assert.equal(values[0].name,'secret.txt');assert.equal(values[0].id,undefined);assert.equal(values[0].path,undefined);assert.ok(values[0].error);
  assert.equal(normalizeAttachments(Array(11).fill(a)).at(-1).name,'其余附件');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('图片 bytes 传递、文本截断与格式失败独立降级，不伪装为已读',async()=>{
 const list=[{id:randomUUID(),name:'photo.png'},{id:randomUUID(),name:'notes.txt'},{id:randomUUID(),name:'archive.zip'},{name:'lost.pdf',error:'下载失败'}];
 const bytes=new Map([[list[0].id,PNG],[list[1].id,Buffer.from('TOKEN-ALPHA\n'+'x'.repeat(61000))],[list[2].id,Buffer.from('binary')]]);
 const p=await prepareAttachments(list,a=>bytes.get(a.id));
 assert.deepEqual(p.images[0].bytes,PNG);assert.match(p.text,/TOKEN-ALPHA/);assert.match(p.notices.join('\n'),/截断/);assert.match(p.notices.join('\n'),/暂不解析/);assert.match(p.notices.join('\n'),/下载失败/);
 const bad=await prepareAttachments([{id:randomUUID(),name:'binary.txt'}],()=>Buffer.from([0,255,1]));assert.equal(bad.images.length,0);assert.ok(bad.notices.length);
});

test('DOCX/XLSX 提取真实正文和单元格；损坏文件明确提示',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-doc-test-'));
 try{
  execFileSync('/usr/bin/python3',['-c',`import zipfile,sys
from pathlib import Path
p=Path(sys.argv[1])
with zipfile.ZipFile(str(p/'sample.docx'),'w') as z:
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文档校验 DOCX-731</w:t></w:r></w:p></w:body></w:document>')
with zipfile.ZipFile(str(p/'sample.xlsx'),'w') as z:
 z.writestr('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>预算 XLSX-529</t></si></sst>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>375</v></c></row></sheetData></worksheet>')
`,dir]);
  for(const [name,token] of [['sample.docx','DOCX-731'],['sample.xlsx','XLSX-529']]){
   const result=await prepareAttachments([{id:randomUUID(),name}],()=>readFile(join(dir,name)));
   assert.match(result.text,new RegExp(token));assert.ok(!result.notices.some(n=>n.includes('失败')));
  }
  const bad=await prepareAttachments([{id:randomUUID(),name:'bad.docx'}],()=>Buffer.from('not zip'));assert.match(bad.notices[0],/损坏/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('PDF 提取文字，不以文件名代替内容',{skip:!existsSync('/usr/bin/pdftotext')},async()=>{
 const body='BT /F1 18 Tf 20 100 Td (PDF-PROBE-827) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${body.length} >>\nstream\n${body}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
 const result=await prepareAttachments([{id:randomUUID(),name:'document.pdf'}],()=>Buffer.from(pdf));assert.match(result.text,/PDF-PROBE-827/);
});

test('附件随任务落库，重启恢复且不重复；所有者/admin 下载，其他用户与未登录拒绝',async()=>{
 const f=await fixture();try{
  const alice=await register(f),bob=await register(f,'bob'),admin=f.client();await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'});
  const id=await create(alice);
  let channel=f.app.engine.runtimes.get(id).channel;channel.state={...channel.state,phase:'connected',account:{id:'attachment-bot',userId:'owner'}};channel.emitState();
  const image=await saved(channel.options.dir,PNG,'测试.png'),doc=await saved(channel.options.dir,Buffer.from('ATTACHMENT-CONTENT-493'),'notes.txt');
  const originalWake=f.app.engine.wake;f.app.engine.wake=()=>{};
  channel.emit('input',{id:'attachment-message',text:'',attachments:[image,doc]});
  assert.equal(f.app.store.messages(id)[0].attachments.length,2);assert.equal(f.app.store.messages(id)[0].text,'');assert.equal(f.app.store.recent(id).length,1);
  assert.equal((await alice.request(`/api/assistants/${id}/messages`,{text:'',requestId:randomUUID(),attachments:[image]})).status,400);
  f.app.engine.wake=originalWake;
  await f.restart();channel=f.app.engine.runtimes.get(id).channel;channel.readAttachment=a=>readChannelAttachment(channel.options.dir,a.id);
  await until(()=>f.fake.runs.length===1&&!f.app.engine.runtimes.get(id).active);
  assert.match(f.fake.runs[0].text,/ATTACHMENT-CONTENT-493/);assert.deepEqual(f.fake.runs[0].images[0].bytes,PNG);
  channel.emit('input',{id:'attachment-message',text:'',attachments:[image,doc]});assert.equal(f.app.store.messages(id).filter(m=>m.role==='user').length,1);
  const path=`/api/assistants/${id}/attachments/${image.id}`;
  const request=c=>fetch(f.base+path,{headers:{cookie:c?.cookie||''}});
  const owner=await request(alice);assert.equal(owner.status,200);assert.equal(owner.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await owner.arrayBuffer()),PNG);
  assert.equal((await request(bob)).status,404);assert.equal((await request()).status,401);assert.equal((await request(admin)).status,200);
  assert.equal((await fetch(f.base+path+'?download=1',{headers:{cookie:alice.cookie}})).headers.get('content-type'),'application/octet-stream');
  assert.equal((await fetch(f.base+`/api/assistants/${id}/attachments/${randomUUID()}`,{headers:{cookie:alice.cookie}})).status,404);
  const history=(await alice.request(`/api/assistants/${id}/messages`)).data.messages;assert.equal(history.find(m=>m.role==='user').attachments[0].name,'测试.png');
 }finally{await f.close();}
});

test('Codex 使用隔离 workspace 内 localImage，文字与图片同一 turn',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-harness-test-'));
 try{
  const h=new CodexHarness({dir});h.cwd='/workspace';h.threadId='existing-thread';let input;
  h.client={run:async args=>{input=args;return {text:'ok'};}};
  const id=randomUUID();await h.run({text:'看图',images:[{id,mime:'image/png',bytes:PNG}],onEvent:()=>{}});
  assert.equal(input.threadId,'existing-thread');assert.deepEqual(input.input.map(i=>i.type),['text','localImage']);assert.equal(input.input[1].path,`/workspace/incoming/${id}.png`);
  assert.deepEqual(await readFile(join(dir,'workspace','incoming',id+'.png')),PNG);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('生成中收到图片会中断同一会话；读取失败提示也回传 ClawBot',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);
  const channel=f.app.engine.runtimes.get(id).channel;await channel.pair();
  channel.input('WAIT 先构思','before-image');await until(()=>f.fake.runs.length===1);
  const thread=f.fake.runs[0].threadId,image=await saved(channel.options.dir,PNG,'new.png');
  channel.input('根据图片修改','new-image',[image,{name:'broken.pdf',error:'下载失败'}]);
  await until(()=>f.fake.runs.length===2&&!f.app.engine.runtimes.get(id).active);
  assert.equal(f.fake.runs[1].threadId,thread);assert.ok(f.fake.interrupts.includes(thread));assert.deepEqual(f.fake.runs[1].images[0].bytes,PNG);
  assert.ok(f.app.store.messages(id).some(m=>m.role==='system'&&m.text.includes('下载失败')));
  await until(()=>f.fake.sent.some(m=>m.text.includes('broken.pdf：下载失败')));
 }finally{await f.close();}
});

test('附件尚在读取时收到补充输入：取消旧准备，将原图与补充文字一起提交',async()=>{
 const f=await fixture();try{
  const c=await register(f),id=await create(c);
  const channel=f.app.engine.runtimes.get(id).channel;await channel.pair();const image=await saved(channel.options.dir,PNG,'pending.png');
  let reading=false,release;const held=new Promise(r=>release=r);let first=true;
  channel.readAttachment=async a=>{if(first){first=false;reading=true;await held;}return readChannelAttachment(channel.options.dir,a.id);};
  channel.input('这是原图','original-picture',[image]);await until(()=>reading);
  channel.input('补充：只描述颜色','follow-up');release();
  await until(()=>f.fake.runs.length===1&&!f.app.engine.runtimes.get(id).active);
  assert.match(f.fake.runs[0].text,/这是原图/);assert.match(f.fake.runs[0].text,/只描述颜色/);assert.deepEqual(f.fake.runs[0].images[0].bytes,PNG);
  assert.equal(f.app.store.pending(id).length,0);assert.equal(f.app.store.messages(id).filter(m=>m.role==='user').length,2);
 }finally{await f.close();}
});

test('旧数据库无损新增附件字段，历史文字及已存在附件保持可读',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wxbot-migration-test-'));let store;
 try{
  store=new PlatformStore(dir);store.addUser('test','hash');const user=store.users()[0],a=store.assistants(user.id)[0];store.addMessage(a.id,{role:'user',text:'旧消息'});store.close();
  const db=new DatabaseSync(join(dir,'platform.sqlite'));db.exec('ALTER TABLE messages DROP COLUMN attachments');db.close();
  store=new PlatformStore(dir);assert.equal(store.messages(a.id)[0].text,'旧消息');assert.deepEqual(store.messages(a.id)[0].attachments,[]);
  const old=store.submit(a.id,'[微信附件]','wechat','wechat:legacy');
  const attachment={id:randomUUID(),name:'old.txt'};
  const backfill=store.submit(a.id,'请查看附件','wechat','wechat:legacy','chat',{attachments:[attachment]});
  assert.equal(backfill.duplicate,true);assert.equal(backfill.message.id,old.message.id);assert.deepEqual(backfill.message.attachments,[attachment]);assert.equal(store.pending(a.id).length,1);
  const placeholder=store.submit(a.id,'请查看我发送的附件。','wechat','wechat:old-placeholder','chat',{attachments:[attachment]});
  assert.equal(store.submit(a.id,'','wechat','wechat:old-placeholder','chat',{attachments:[attachment]}).message.text,'');
  assert.equal(store.message(placeholder.message.id).text,'');
  const genuine=store.submit(a.id,'请查看我发送的附件。','wechat','wechat:genuine','chat',{attachments:[attachment]});
  store.submit(a.id,'请查看我发送的附件。','wechat','wechat:genuine','chat',{attachments:[attachment]});
  assert.equal(store.message(genuine.message.id).text,'请查看我发送的附件。');
 }finally{store?.close();await rm(dir,{recursive:true,force:true});}
});
