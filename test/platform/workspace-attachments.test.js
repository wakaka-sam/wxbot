import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,link,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {stageWorkspaceAttachment} from '../../src/platform/workspace-attachments.js';
import {prepareAttachments} from '../../src/platform/attachments.js';
import {CodexHarness} from '../../src/platform/adapters/codex.js';
import {fixture,register,create,until} from './helpers.js';
import {saveMedia,describeMedia} from '../../src/media.js';

async function scratch(fn){const dir=await mkdtemp(join(tmpdir(),'wxbot-workspace-test-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('完整原文件与有限预览分离：大 Excel、长文本、压缩包和损坏文档均可在工作区读取',()=>scratch(async dir=>{
 const xlsx=join(dir,'large.xlsx');
 execFileSync('/usr/bin/python3',['-c',`import zipfile,sys
rows=''.join('<row r="%d"><c r="A%d" t="inlineStr"><is><t>%s</t></is></c></row>'%(i,i,'ROW-%d-'%i+'x'*600) for i in range(1,302))
with zipfile.ZipFile(sys.argv[1],'w') as z:
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+rows+'</sheetData></worksheet>')
`,xlsx]);
 const originals=[['大表.xlsx',await readFile(xlsx)],['长文.txt',Buffer.from('x'.repeat(65000)+'TEXT-END')],['archive.zip',Buffer.from([80,75,3,4,0,255])],['broken.docx',Buffer.from('broken-docx')]];
 const files=originals.map(([name,bytes])=>({id:randomUUID(),name,bytes}));
 const h=new CodexHarness({dir:join(dir,'harness')});h.cwd='/workspace';
 const prepared=await prepareAttachments(files,a=>a.bytes,{stage:(a,o)=>h.stageAttachment(a,o)});
 assert.equal(prepared.files.length,4);assert.match(prepared.notices.join('\n'),/截断/);assert.doesNotMatch(prepared.text,/ROW-301-|TEXT-END/);
 for(let i=0;i<files.length;i++){
  const path=prepared.files[i].path;assert.match(path,/^\/workspace\/incoming\//);assert.ok(prepared.text.includes(path));
  assert.deepEqual(await readFile(join(h.dir,'workspace',path.slice('/workspace/'.length))),files[i].bytes);
 }
 assert.match(prepared.notices.join('\n'),/完整原文件已提供到工作区/);
 assert.doesNotMatch(prepared.notices.join('\n'),/重发|请拆分|请转换/);
 // Read beyond both preview limits using a command, just as the agent can.
 const raw=join(h.dir,'workspace',prepared.files[0].path.slice('/workspace/'.length));
 const tail=execFileSync('/usr/bin/python3',['-c',"import sys,zipfile;print('ROW-301-' in zipfile.ZipFile(sys.argv[1]).read('xl/worksheets/sheet1.xml').decode())",raw],{encoding:'utf8'});
 assert.equal(tail.trim(),'True');
}));

test('同名附件不覆盖，重启保留原件，不同助手工作区隔离',()=>scratch(async dir=>{
 const a=join(dir,'alice'),b=join(dir,'bob'),first={id:randomUUID(),name:'同名.xlsx',bytes:Buffer.from('first')},second={...first,id:randomUUID(),bytes:Buffer.from('second')};
 const one=await stageWorkspaceAttachment(a,first),two=await stageWorkspaceAttachment(a,second);
 assert.notEqual(one.relativePath,two.relativePath);assert.deepEqual(await readFile(join(a,one.relativePath)),first.bytes);
 await stageWorkspaceAttachment(b,{...first,bytes:Buffer.from('bob')});assert.deepEqual(await readFile(join(a,one.relativePath)),first.bytes);
 const h=new CodexHarness({dir:join(dir,'harness')});const staged=await h.stageAttachment(first);
 const resumed=new CodexHarness({dir:h.dir});assert.equal((await resumed.stageAttachment(first)).path,staged.path);
 assert.deepEqual(await readFile(join(h.dir,'workspace',staged.path.slice('/workspace/'.length))),first.bytes);
}));

test('拒绝目录符号链接和非法 ID，原子落盘不会改写目标文件或硬链接',()=>scratch(async dir=>{
 const workspace=join(dir,'workspace'),outside=join(dir,'outside');await mkdir(workspace);await mkdir(outside);
 const attachment={id:randomUUID(),name:'../../escape.xlsx',bytes:Buffer.from('attachment')};
 await symlink(outside,join(workspace,'incoming'));await assert.rejects(stageWorkspaceAttachment(workspace,attachment),/工作区/);assert.deepEqual(await readdir(outside),[]);
 await rm(join(workspace,'incoming'));await mkdir(join(workspace,'incoming'));
 const target=join(outside,'private');await writeFile(target,'private');
 await symlink(target,join(workspace,'incoming',attachment.id+'.xlsx'));
 const staged=await stageWorkspaceAttachment(workspace,attachment);assert.equal(await readFile(target,'utf8'),'private');assert.deepEqual(await readFile(join(workspace,staged.relativePath)),attachment.bytes);
 await rm(join(workspace,staged.relativePath));await link(target,join(workspace,staged.relativePath));await stageWorkspaceAttachment(workspace,attachment);assert.equal(await readFile(target,'utf8'),'private');
 await assert.rejects(stageWorkspaceAttachment(workspace,{...attachment,id:'../../escape'}),/标识/);
 const controller=new AbortController();controller.abort();await assert.rejects(stageWorkspaceAttachment(workspace,attachment,{signal:controller.signal}),{name:'AbortError'});
 assert.equal((await readdir(join(workspace,'incoming'))).some(n=>n.startsWith('.upload-')),false);
}));

test('落盘失败不会声称原文件已提供，也不阻止其他附件',()=>scratch(async dir=>{
 const files=[{id:randomUUID(),name:'fail.txt'},{id:randomUUID(),name:'ok.txt'}],h=new CodexHarness({dir});
 const result=await prepareAttachments(files,()=>Buffer.from('full-content'),{stage:(a,o)=>{if(a.name==='fail.txt')throw new Error('存储空间不足');return h.stageAttachment(a,o);}});
 assert.equal(result.files.length,1);assert.match(result.notices[0],/存储空间不足/);assert.doesNotMatch(result.notices[0],/已提供/);assert.equal(result.text.includes(files[0].id),false);
}));

test('微信普通附件实际经 Engine 落入正确工作区，后续轮次和服务重启仍能读取',async()=>{
 const f=await fixture();try{
  const alice=await register(f),bob=await register(f,'bob'),id=await create(alice),other=await create(bob);
  const r=f.app.engine.runtimes.get(id),otherRuntime=f.app.engine.runtimes.get(other);await r.channel.pair();
  const bytes=Buffer.from('FULL-CONTENT-'+ 'x'.repeat(61000)+'-TAIL'),file=await saveMedia(bytes,describeMedia(bytes,'details.txt'),r.channel.options.dir);
  r.channel.input('读取完整文件','workspace-file',[file]);await until(()=>f.fake.runs.length===1&&!r.active);
  const path=join(r.harness.options.dir,'workspace','incoming',file.id+'.txt');assert.deepEqual(await readFile(path),bytes);
  assert.ok(f.fake.runs[0].text.includes('/workspace/incoming/'+file.id+'.txt'));assert.doesNotMatch(f.fake.runs[0].text,/-TAIL/);
  await assert.rejects(readFile(join(otherRuntime.harness.options.dir,'workspace','incoming',file.id+'.txt')),{code:'ENOENT'});
  r.channel.input('继续处理该文件','workspace-followup');await until(()=>f.fake.runs.length===2&&!r.active);assert.deepEqual(await readFile(path),bytes);
  await f.restart();assert.deepEqual(await readFile(path),bytes);assert.equal(f.fake.runs.length,2);
 }finally{await f.close();}
});
