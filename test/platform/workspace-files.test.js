import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,symlink,link} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,register,create} from './helpers.js';
import {memoryContext} from '../../src/platform/workspace-files.js';
import {CodexHarness} from '../../src/platform/adapters/codex.js';
async function setup(fn){const f=await fixture();try{const owner=await register(f),other=await register(f,'bob'),id=await create(owner),root=join(f.dir,'assistants',id,'harness','workspace');await mkdir(root,{recursive:true});const admin=f.client();await admin.request('/api/login',{username:'admin',password:'Admin-test-password-731'});await fn({f,owner,other,admin,id,root,api:'/api/assistants/'+id});}finally{await f.close();}}

test('文件浏览、分页、预览与下载按用户隔离，管理员只读且记录审计',()=>setup(async({f,owner,other,admin,root,api})=>{
 await mkdir(join(root,'incoming'));await writeFile(join(root,'incoming','hello.txt'),'你好世界');await writeFile(join(root,'.hidden'),'hidden');
 const url=api+'/files';assert.equal((await f.client().request(url)).status,401);assert.equal((await other.request(url)).status,404);
 const listing=await owner.request(url);assert.equal(listing.status,200);assert.deepEqual(listing.data.entries.map(e=>e.name),['incoming','.hidden']);
 const preview=await owner.request(api+'/files/preview?path=incoming%2Fhello.txt');assert.equal(preview.data.text,'你好世界');assert.equal(preview.data.editable,false);
 const download=await fetch(f.base+api+'/files/download?path=incoming%2Fhello.txt',{headers:{Cookie:owner.cookie}});assert.equal(await download.text(),'你好世界');assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(download.headers.get('x-content-type-options'),'nosniff');
 assert.equal((await admin.request(url)).status,200);assert.equal((await admin.request(api+'/memory/save',{path:'MEMORY.md',version:null,content:'no'})).status,404);
 assert.ok(f.app.store.db.prepare("SELECT count(*) n FROM audit WHERE action='view-workspace'").get().n>0);
 await mkdir(join(root,'many'));for(let i=0;i<205;i++)await writeFile(join(root,'many',String(i).padStart(3,'0')+'.txt'),'x');
 const first=(await owner.request(url+'?path=many')).data,second=(await owner.request(url+'?path=many&offset=200')).data;assert.equal(first.entries.length,200);assert.equal(first.nextOffset,200);assert.equal(second.entries.length,5);assert.equal(second.nextOffset,null);
}));

test('拒绝路径穿越、目录/文件链接、硬链接及跨站写入，不暴露工作区外文件',()=>setup(async({f,owner,root,api})=>{
 const secret=join(f.dir,'private');await writeFile(secret,'secret');await symlink(f.dir,join(root,'escape'));await symlink(secret,join(root,'MEMORY.md'));await link(secret,join(root,'hardlink'));
 for(const path of ['../private','/etc/passwd','escape/private','MEMORY.md','hardlink','a\\b','a/../private']){
  const response=await owner.request(api+'/files/preview?path='+encodeURIComponent(path));assert.ok(response.status>=400,path);assert.doesNotMatch(JSON.stringify(response.data),/"secret"/);
 }
 assert.equal((await owner.request(api+'/memory/save',{path:'MEMORY.md',version:null,content:'overwrite'})).status,403);
 assert.equal((await owner.request(api+'/memory/save',{path:'memory/preferences.md',version:null,content:'x'},{Origin:'https://evil.example'})).status,403);
 assert.equal((await owner.request(api+'/memory/save',{path:'.codex/auth.json',version:null,content:'x'})).status,403);assert.equal(await readFile(secret,'utf8'),'secret');
}));

test('记忆创建、编辑、删除、版本冲突与备份；新一轮 Codex 输入读取最新值',()=>setup(async({f,owner,root,id,api})=>{
 const save=body=>owner.request(api+'/memory/save',body),preview=()=>owner.request(api+'/files/preview?path=MEMORY.md');
 const created=await save({path:'MEMORY.md',version:null,content:'偏好简洁回答'});assert.equal(created.status,200);
 assert.equal((await save({path:'MEMORY.md',version:null,content:'覆盖'})).status,409);
 assert.equal((await save({path:'memory/preferences.md',version:null,content:'使用中文'})).status,200);
 const a=await preview();const simultaneous=await Promise.all([save({path:'MEMORY.md',version:a.data.version,content:'偏好 A'}),save({path:'MEMORY.md',version:a.data.version,content:'偏好 B'})]);assert.deepEqual(simultaneous.map(r=>r.status).sort(),[200,409]);
 const current=(await preview()).data;assert.match(await memoryContext(root),/偏好 [AB]/);
 const h=new CodexHarness({dir:join(f.dir,'assistants',id,'harness')});h.cwd='/workspace';h.threadId='test';let text;h.client={run:async({input})=>{text=input[0].text;return{text:'ok'};}};
 await h.run({text:'你好',onEvent:()=>{}});assert.ok(text.includes(current.text));assert.ok(text.includes('使用中文'));
 const update=await save({path:'MEMORY.md',version:current.version,content:'新的偏好'});assert.equal(update.status,200);await h.run({text:'继续',onEvent:()=>{}});assert.match(text,/新的偏好/);assert.ok(!text.includes(current.text));
 assert.equal((await owner.request(api+'/memory/delete',{path:'MEMORY.md',version:current.version})).status,409);
 assert.equal((await owner.request(api+'/memory/delete',{path:'MEMORY.md',version:update.data.version})).status,200);assert.equal((await preview()).status,404);
 const history=join(f.dir,'assistants',id,'harness','memory-history');assert.equal((await readdir(history)).length,3);
 assert.equal((await save({path:'memory/too-big.md',version:null,content:'中'.repeat(12000)})).status,400);
 assert.equal((await owner.request(api+'/files?memory=1')).data.entries[0].name,'memory');
 assert.equal((await save({path:'memory/newlines.md',version:null,content:'\n'.repeat(32768)})).status,200);
}));

test('大文件只做有限预览、二进制不当文本执行，图片预览按实际格式校验',()=>setup(async({f,owner,root,api})=>{
 await writeFile(join(root,'large.txt'),'x'.repeat(70000));await writeFile(join(root,'page.html'),'<script>alert(1)</script>');await writeFile(join(root,'bad.png'),'<html>no</html>');
 const large=(await owner.request(api+'/files/preview?path=large.txt')).data;assert.equal(large.truncated,true);assert.equal(large.text.length,65536);
 assert.equal((await owner.request(api+'/files/preview?path=page.html')).data.text,'<script>alert(1)</script>');
 const bad=await fetch(f.base+api+'/files/image?path=bad.png',{headers:{Cookie:owner.cookie}});assert.equal(bad.status,400);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfoAAAAASUVORK5CYII=','base64');await writeFile(join(root,'image.png'),png);
 const image=await fetch(f.base+api+'/files/image?path=image.png',{headers:{Cookie:owner.cookie}});assert.equal(image.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await image.arrayBuffer()),png);
}));
