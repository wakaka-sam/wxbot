import http from 'node:http';
import { createHash } from 'node:crypto';
import { chmod, lstat, rm } from 'node:fs/promises';
import { AppError } from './store.js';

export function mailOwner(store, env=process.env) {
 const user=store.userByName('admin');
 if(!user || user.id!==env.PLATFORM_MAIL_USER_ID)throw new AppError(403,'邮件通知仅允许已配置的 admin 账号');
 return user;
}
export function mailNotification(engine, request, {env=process.env,statusOnly=false}={}) {
 const {store}=engine,user=mailOwner(store,env);
 const allowed=statusOnly?['key']:['key','text'];
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).some(k=>!allowed.includes(k))||
    typeof request.key!=='string'||! /^(important|digest|health|test):[a-zA-Z0-9_-]{1,128}$/.test(request.key))throw new AppError(400,'Invalid notification request');
 if(!statusOnly&&(typeof request.text!=='string'||!request.text.trim()||request.text.length>20000))throw new AppError(400,'Invalid notification text');
 const key='mail-notify:'+request.key,prior=store.get(key);
 if(prior&&prior.userId!==user.id)throw new AppError(403,'邮件通知所属账号不一致');
 let receipt=prior;
 if(!receipt&&!statusOnly){
  const assistant=store.assistants(user.id)[0];
  if(!assistant||!assistant.active)throw new AppError(409,'admin 助手未启用');
  const id=createHash('sha256').update(key).digest('hex');
  const deliveries=engine.textDeliveries(assistant.id,request.text,key);
  if(!deliveries.length||deliveries.some(d=>!d.payload.binding?.accountId||!d.payload.binding?.userId))throw new AppError(409,'admin 尚未绑定微信');
  receipt={userId:user.id,assistantId:assistant.id,messageId:id,deliveryIds:deliveries.map(d=>d.id)};
  store.tx(()=>{
   store.addMessage(assistant.id,{id,role:'assistant',text:request.text,source:'mail-notify',sourceKey:key});
   for(const d of deliveries)store.queueDelivery(d.id,assistant.id,d.payload);
   store.set(key,receipt);
  });
  engine.publish(assistant.id,'message',store.message(id));
 }
 if(!receipt)return {key:request.key,status:'missing'};
 if(!statusOnly&&store.message(receipt.messageId)?.text!==request.text)throw new AppError(409,'同一通知标识不能更改正文');
 // Engine owns retries/binding checks. Never create another delivery for an unknown result.
 engine.deliver(receipt.assistantId);
 const states=receipt.deliveryIds.map(id=>store.delivery(id)?.state||'unknown');
 const status=states.every(s=>s==='sent')?'sent':states.includes('unknown')?'unknown':states.includes('failed')?'failed':'pending';
 return {key:request.key,status,parts:states};
}
export async function startMailNotifications(engine,path,{env=process.env}={}) {
 mailOwner(engine.store,env);
 // The caller places this socket inside the platform's private 0700 data directory.
 const old=await lstat(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
 if(old){if(!old.isSocket())throw new Error('Notification path is not a socket');await rm(path);}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  try{
   if(req.method!=='POST'||!['/notify','/status'].includes(req.url))throw new AppError(404,'Unknown notification operation');
   const chunks=[];let size=0;
   for await(const c of req){size+=c.length;if(size>100000)throw new AppError(413,'Request too large');chunks.push(c);}
   const result=mailNotification(engine,JSON.parse(Buffer.concat(chunks).toString()),{env,statusOnly:req.url==='/status'});
   res.end(JSON.stringify(result));
  }catch(e){res.statusCode=e.status||400;res.end(JSON.stringify({error:e.message}));}
 });
 server.requestTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
 await chmod(path,0o600);
 return {close:async()=>{await new Promise(resolve=>server.close(resolve));await rm(path,{force:true});}};
}
