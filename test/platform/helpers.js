import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { readChannelAttachment } from '../../src/platform/attachments.js';
import { createPlatform } from '../../src/platform/server.js';
export async function until(fn,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await delay(10);}assert.fail('状态未及时完成');}
export function mocks(){
 const channels=new Map(),savedChannels=new Map(),harnesses=[],runs=[],sent=[],interrupts=[];let count=0;
 class Channel extends EventEmitter{
  constructor(options){super();this.options=options;this.state=savedChannels.get(options.dir)||{phase:'offline',detail:'未连接',qr:null,account:null};this.incoming=[];channels.set(options.dir,this);}
  snapshot(){return {...this.state};}
  emitState(){savedChannels.set(this.options.dir,this.state);this.emit('state',this.snapshot());}
  async start(){if(this.state.account)this.state={...this.state,phase:'connected',detail:'在线'};this.emitState();}
  async stop(){this.state={...this.state,phase:'paused',qr:null};this.emitState();}
  async login(){this.state={...this.state,phase:'waiting',detail:'扫码',qr:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTfoAAAAASUVORK5CYII='};this.emitState();}
  async pair(account={id:'bot-'+count++,userId:'owner'}){this.options.validateBinding(account);this.state={phase:'connected',detail:'在线',qr:null,account};this.emitState();this.emit('paired');}
  async verify(code){if(code!=='2468')throw new Error('配对码无效');await this.pair();}
  async disconnect(){this.state={phase:'offline',detail:'已断开',qr:null,account:null};this.emitState();}
  async send(text,id,binding){sent.push({dir:this.options.dir,text,id,binding});return {status:'sent'};}
  input(text,id='input-'+count++,attachments=[]){const m={id,text,attachments};this.incoming.push(m);this.emit('input',m);}
  history(){return this.incoming;}
  async readAttachment(a){return readChannelAttachment(this.options.dir,a.id);}
  async close(){}
 }
 class Harness{
  constructor(options){this.options=options;this.threadId=null;this.pending=null;this.closed=false;harnesses.push(this);}
  async prepare({threadId,onThread}){this.closed=false;this.threadId=threadId||'thread-'+count++;onThread(this.threadId);await delay(5);}
  async run({text,images=[],onEvent}){
   runs.push({threadId:this.threadId,text,images,dir:this.options.dir});
   let resolve,reject;const held=new Promise((r,j)=>{resolve=r;reject=j;});held.catch(()=>{});this.pending={resolve,reject};
   onEvent({type:'started',turnId:'turn-'+count++});
   onEvent({type:'delta',itemId:'one',delta:'先确认你的问题。\n\n',phase:'commentary'});
   onEvent({type:'message',itemId:'one',text:'先确认你的问题。\n\n',phase:'commentary'});
   if(text.includes('WAIT'))await held;else{resolve();await delay(20);await held;}
   onEvent({type:'delta',itemId:'two',delta:'回答：'+text,phase:'final_answer'});
   onEvent({type:'message',itemId:'two',text:'回答：'+text,phase:'final_answer'});
   this.pending=null;return {text:'回答：'+text};
  }
  async interrupt(){interrupts.push(this.threadId);this.pending?.reject(Object.assign(new Error('中断'),{code:'interrupted'}));}
  async close(){this.closed=true;await this.interrupt();}
 }
 return{channels,harnesses,runs,sent,interrupts,options:{channelFactory:o=>new Channel(o),harnessFactory:o=>new Harness(o)}};
}
export async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'wxbot-platform-test-')),fake=mocks();
 let app;
 async function start(){app=await createPlatform({dir,adminPassword:'Admin-test-password-731',engineOptions:fake.options});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return app;}
 await start();
 const ctx={dir,fake,get app(){return app;},get base(){return `http://127.0.0.1:${app.server.address().port}`;},async restart(){await app.close();await start();},async close(){await app.close();await rm(dir,{recursive:true,force:true});}};
 ctx.client=()=>{let cookie='';return{get cookie(){return cookie;},async request(path,body,extra={}){
  const response=await fetch(ctx.base+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'X-Wxbot-Platform':'1','Content-Type':'application/json'}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
  if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
  return{status:response.status,headers:response.headers,data:await response.json()};
 }};};
 return ctx;
}
export async function register(ctx,name='alice'){const c=ctx.client();assert.equal((await c.request('/api/register',{username:name,password:'Test-password-731'})).status,201);return c;}
export async function create(c,name='助手'){const r=await c.request('/api/assistants',{name});assert.equal(r.status,201);return r.data.assistant.id;}
