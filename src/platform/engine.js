import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './store.js';
import { Schedules } from './schedules.js';
import { migrateSingleAssistant } from './single-assistant.js';
import { WechatChannel } from './adapters/wechat.js';
import { CodexHarness } from './adapters/codex.js';
import { normalizeAttachments, prepareAttachments } from './attachments.js';
import { validateSend, sendHash } from '../send-client.js';
// Also discard tool-status notifications queued by older deployments.
const TOOL_STATUS_TEXTS=new Set(['正在执行命令…','正在修改工作文件…','正在查询网页…','正在与子代理协作…','正在调用工具…']);
const uuidFor=value=>{const h=createHash('sha256').update(value).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;};
export class Engine extends EventEmitter {
  constructor(store,dir,{channelFactory=o=>new WechatChannel(o),harnessFactory=o=>new CodexHarness(o),publishDownload}={}){
    super();Object.assign(this,{store,dir,channelFactory,harnessFactory,publishDownload});this.runtimes=new Map();this.opening=new Map();this.locks=new Map();this.closed=false;this.schedules=new Schedules(store);
  }
  publish(id,type,data){this.emit('event',{assistantId:id,type,data});}
  async init(){await migrateSingleAssistant(this.store,this.dir);this.store.recover();this.schedules.settle();for(const a of this.store.assistants()){const r=await this.runtime(a);if(a.active){await r.channel.start();this.reconcile(a.id,r);this.wake(a.id);this.deliver(a.id);}}this.tickSchedules();this.scheduleTimer=setInterval(()=>this.tickSchedules(),10000);this.scheduleTimer.unref();}
  tickSchedules(now=Date.now()){
    if(this.closed)return;
    for(const task of this.schedules.due(now)){
      if(!this.connected(task.assistant_id))continue;
      try{const result=this.schedules.enqueue(task.id,now);if(result){this.publish(result.assistantId,'message',result.message);this.wake(result.assistantId);}}
      catch(error){this.publish(task.assistant_id,'error',{message:`自动任务入队失败：${error.message}`});}
    }
  }
  scheduleFromTool(id,run,request){
    if(this.closed||this.runtimes.get(id)?.active!==run||run.interrupted)throw new AppError(409,'任务管理轮次已结束');
    this.requireActive(id);
    if(run.scheduled&&!['list','history'].includes(request?.action))throw new AppError(403,'自动执行期间不能创建或修改自动任务');
    return this.requestSchedule(id,request);
  }
  requestSchedule(id,request){
    const result=this.schedules.request(id,request);
    if(result.message)this.publish(id,'message',result.message);
    if(result.jobId)this.wake(id);
    this.publish(id,'schedules',{});return result;
  }
  async runtime(a){
    if(this.runtimes.has(a.id))return this.runtimes.get(a.id);
    if(this.opening.has(a.id))return this.opening.get(a.id);
    const opening=(async()=>{
      const dir=join(this.dir,'assistants',a.id);await mkdir(dir,{recursive:true,mode:0o700});
      const channel=this.channelFactory({dir:join(dir,'channel'),bridgeOptions:{publishDownload:this.publishDownload},validateBinding:account=>{
        if(!account.id||!account.userId)throw new Error('微信未返回完整账号身份，请重新扫码');
        this.store.tx(()=>{
          const key=`binding:${account.id}`,owner=this.store.get(key);
          if(owner&&owner!==a.id)throw new Error('此微信连接已绑定其他助手，请回到原助手继续会话');
          const prior=this.store.get(`assistant-binding:${a.id}`);
          // A fresh bot is a connection, not a different human. Keep the owner
          // pinned to the WeChat user while allowing that user's bot to rotate.
          if(prior&&prior.userId!==account.userId)throw new Error('本次扫码的微信账号与原绑定账号不一致，请使用原来的微信账号');
          if(prior&&prior.id!==account.id){
            const oldKey=`binding:${prior.id}`;
            if(this.store.get(oldKey)===a.id)this.store.db.prepare('DELETE FROM settings WHERE key=?').run(oldKey);
            for(const row of this.store.deliveries(a.id)){
              const payload=JSON.parse(row.payload);
              if(payload.binding?.accountId!==prior.id||payload.binding?.userId!==account.userId)continue;
              payload.binding.accountId=account.id;
              this.store.db.prepare("UPDATE outbox SET payload=? WHERE id=? AND state='pending'").run(JSON.stringify(payload),row.id);
            }
            this.store.audit(a.user_id,'wechat-bot-rebound',a.id);
          }
          this.store.set(key,a.id);this.store.set(`assistant-binding:${a.id}`,{id:account.id,userId:account.userId});
        });
      }});
      const r={channel,harness:this.harnessFactory({dir:join(dir,'harness'),userId:a.user_id}),draining:null,delivering:null,active:null,command:Promise.resolve(),stateStamp:'',lastPhase:null,connectionStop:null};
      this.runtimes.set(a.id,r);
      channel.on('input',input=>{try{this.submit(a.id,input.text,'wechat',input.id,input.attachments);}catch(error){this.publish(a.id,'error',{message:error.message});}});
      channel.on('state',state=>{
        const previous=r.lastPhase;r.lastPhase=state.phase;
        const stamp=JSON.stringify(state);if(stamp!==r.stateStamp){r.stateStamp=stamp;this.publish(a.id,'assistant',this.snapshot(a.id));}
        if(this.connected(a.id)){
          this.wake(a.id);this.deliver(a.id);
        }else if(!this.closed&&(previous==='connected'||r.active)){
          void this.pauseDisconnected(a.id,r).catch(error=>this.publish(a.id,'error',{message:error.message}));
        }
      });
      return r;
    })();this.opening.set(a.id,opening);try{return await opening;}finally{this.opening.delete(a.id);}
  }
  connected(id){const c=this.runtimes.get(id)?.channel.snapshot();return Boolean(c?.phase==='connected'&&c.account?.userId);}
  requireConnected(id){if(!this.connected(id))throw new AppError(409,'请先连接微信，连接成功后才能使用助手','WECHAT_REQUIRED');}
  pauseDisconnected(id,r){
    if(r.connectionStop)return r.connectionStop;
    const stopping=Promise.resolve().then(async()=>{await this.interrupt(id);await r.draining;await r.harness.close();});
    r.connectionStop=stopping.finally(()=>{r.connectionStop=null;if(!this.closed&&this.connected(id))this.wake(id);});
    return r.connectionStop;
  }
  snapshot(id){const a=this.store.assistant(id),r=this.runtimes.get(id);return {...a,active:Boolean(a.active),running:Boolean(r?.active),pending:this.store.pending(id).length,lastWechatMessageSeq:this.store.lastWechatMessageSeq(id),connection:r?.channel.snapshot()||{phase:'offline',detail:'助手尚未激活',qr:null,account:null},deliveryErrors:this.store.deliveryErrors(id)};}
  list(userId){return this.store.assistants(userId).map(a=>{const s=this.snapshot(a.id);return {...s,connection:{...s.connection,qr:undefined}};});}
  adminUsers(){
    const assistants=new Map(this.store.assistants().map(a=>[a.user_id,a]));
    const stats=new Map(this.store.conversationStats().map(s=>[s.assistant_id,s]));
    return this.store.users().map(u=>{
      const a=assistants.get(u.id),runtime=a&&this.runtimes.get(a.id),connection=runtime?.channel.snapshot();
      const linked=Boolean(connection?.account?.userId),connected=Boolean(a?.active&&linked&&connection.phase==='connected');
      const phase=connection?.phase==='connected'&&!connected?'offline':connection?.phase||'offline';
      return {...u,assistantId:a?.id||null,assistantName:a?.name||null,
        messageCount:stats.get(a?.id)?.messageCount||0,lastUsedAt:stats.get(a?.id)?.lastUsedAt||null,
        running:Boolean(runtime?.active),wechat:{phase,connected,linked}};
    });
  }
  async lock(userId,fn){const previous=this.locks.get(userId)||Promise.resolve();const next=previous.catch(()=>{}).then(fn);this.locks.set(userId,next);try{return await next;}finally{if(this.locks.get(userId)===next)this.locks.delete(userId);}}
  async activate(id,user,stopId){return this.lock(user.id,async()=>{
    const {stopped}=this.store.activate(id,user,stopId);
    if(stopped)await this.stopRuntime(stopped);
    try{const r=await this.runtime(this.store.assistant(id));await r.channel.start();this.reconcile(id,r);this.wake(id);this.deliver(id);}
    catch(error){this.store.deactivate(id,user);throw error;}
    this.publish(id,'assistant',this.snapshot(id));return this.snapshot(id);
  });}
  async deactivate(id,user){return this.lock(user.id,async()=>{this.store.deactivate(id,user);await this.stopRuntime(id);return this.snapshot(id);});}
  async stopRuntime(id){const r=this.runtimes.get(id);this.store.cancelPending(id);this.schedules.settle();if(r){await r.command.catch(()=>{});await r.channel.stop();if(r.active){r.active.interrupted=true;r.active.inputAbort.abort();await r.harness.interrupt().catch(()=>{});}await r.draining;await r.harness.close();}this.publish(id,'assistant',this.snapshot(id));}
  requireActive(id){const a=this.store.assistant(id);if(!a?.active)throw new AppError(409,'请先激活此助手','INACTIVE');return a;}
  async channelCommand(id,action,body={}){
    const a=this.requireActive(id),r=await this.runtime(a);
    const next=r.command.catch(()=>{}).then(async()=>{this.requireActive(id);if(action==='login')await r.channel.login();else if(action==='verify')await r.channel.verify(body.code);else if(action==='disconnect'){await r.channel.disconnect();await this.pauseDisconnected(id,r);}else throw new AppError(404,'操作不存在');return this.snapshot(id);});
    r.command=next;return next;
  }
  reconcile(id,r){for(const m of r.channel.history())this.submit(id,m.text,'wechat',m.id,m.attachments);}
  submit(id,text,source='web',key=randomUUID(),attachments=[]){
    this.requireActive(id);if(source==='web')this.requireConnected(id);attachments=source==='wechat'?normalizeAttachments(attachments):this.uploads?.resolve(id,attachments)||[];
    if(typeof text!=='string'||(!text.trim()&&!attachments.length)||text.length>20000)throw new AppError(400,'消息须为 1–20000 个字符');
    if(typeof key!=='string'||key.length>500)throw new AppError(400,'请求标识无效');
    const messageId=randomUUID();
    const outbound=source==='web'?this.textDeliveries(id,text.trim(),`user:${messageId}`,'[User]: '):[];
    // Commit the input, model job and channel mirror together; retries cannot lose or duplicate the mirror.
    const result=this.store.submit(id,text.trim(),source,`${source}:${key}`,'chat',{messageId,outbound,attachments,onSubmit:message=>{if(source==='web')this.uploads?.claim(id,message.attachments);}});if(result.duplicate)return result;
    this.publish(id,'message',result.message);
    if(source==='wechat')this.publish(id,'assistant',this.snapshot(id));
    this.deliver(id);
    const r=this.runtimes.get(id);
    if(r?.active){r.active.superseded=true;r.active.interrupted=true;r.active.inputAbort.abort();void r.harness.interrupt().catch(()=>{});this.publish(id,'status',{message:'收到新输入，正在中断当前回复并调整方向'});}
    this.wake(id);return result;
  }
  textDeliveries(id,text,key,prefix=''){
    const r=this.runtimes.get(id),binding=r?.channel.snapshot().account||this.store.get(`assistant-binding:${id}`);
    if(!binding||!text.trim())return [];
    const points=Array.from(text),size=1200-Array.from(prefix).length,deliveries=[];
    for(let i=0;i<points.length;i+=size)deliveries.push({id:uuidFor(`${key}:${i}`),payload:{text:prefix+points.slice(i,i+size).join(''),binding:{accountId:binding.id,userId:binding.userId}}});
    return deliveries;
  }
  enqueueText(id,text,key,jobId=null){
    for(const delivery of this.textDeliveries(id,text,key))this.store.queueDelivery(delivery.id,id,delivery.payload,jobId);
    this.deliver(id);
  }
  async sendFromTool(id,run,binding,request){
    return this.lock(`send:${id}`,()=>this.sendToolPayload(id,run,binding,request));
  }
  async sendToolPayload(id,run,binding,{requestId,text,attachment}){
    validateSend(text,attachment);
    const r=this.runtimes.get(id);
    if(this.closed||r?.active!==run||run.interrupted)throw new AppError(409,'发送轮次已结束');
    this.requireActive(id);this.requireConnected(id);
    const current=r.channel.snapshot().account;
    if(!binding||current?.id!==binding.id||current?.userId!==binding.userId)throw new AppError(409,'本轮微信绑定已失效，请重新连接后再发送');
    const deliveryId=uuidFor(`wxbot-send:${id}:${run.jobId}:${requestId}`);
    const payload={text,binding:{accountId:binding.id,userId:binding.userId}};
    const prior=this.store.delivery(deliveryId);
    const contentHash=attachment?sendHash(text,attachment):null;
    const previous=prior?JSON.parse(prior.payload):null;
    if(prior&&(attachment?previous.contentHash!==contentHash||JSON.stringify(previous.binding)!==JSON.stringify(payload.binding):JSON.stringify(previous)!==JSON.stringify(payload)))throw new AppError(409,'同一 request-id 不能修改正文、附件或接收账号');
    if(!prior){
      if(attachment){
        payload.attachment=await r.channel.stageAttachment(attachment);payload.contentHash=contentHash;
        if(this.closed||r.active!==run||run.interrupted)throw new AppError(409,'发送轮次已结束');
        this.requireActive(id);this.requireConnected(id);
        const latest=r.channel.snapshot().account;
        if(latest?.id!==binding.id||latest?.userId!==binding.userId)throw new AppError(409,'本轮微信绑定已失效');
      }
      const message=this.store.tx(()=>{
        const m=this.store.addMessage(id,{id:deliveryId,role:'assistant',text,source:'wxbot-send',jobId:run.jobId,attachments:payload.attachment?[payload.attachment]:[]});
        this.store.queueDelivery(deliveryId,id,payload,run.jobId);return m;
      });
      this.publish(id,'message',message);
    }
    // An already-running delivery loop may have taken its pending snapshot
    // before this request was committed. Join successive drains until this
    // receipt settles, rather than reporting a queued message as a failure.
    do{
      this.deliver(id);
      if(!r.delivering)break;
      await r.delivering;
    }while(!this.closed&&!run.interrupted&&this.store.assistant(id)?.active&&r.blockedQuotaEpoch==null&&['pending','sending'].includes(this.store.delivery(deliveryId).state));
    const receipt=this.store.delivery(deliveryId);
    if(receipt.state!=='failed'&&text.trim())run.explicitTexts.add(text.trim());
    const unresolved=['pending','sending'].includes(receipt.state);
    return {id:deliveryId,status:unresolved?'unknown':receipt.state,error:receipt.error||(unresolved?
      (r.blockedQuotaEpoch!=null?'消息已入队等待微信回复额度；请让用户在微信发送消息后继续，不要换 request-id 重发':'消息已入队，尚未确认微信接收；请先核实，不要换 request-id 重发'):null)};
  }
  deliver(id){
    const r=this.runtimes.get(id);if(!r||r.delivering||this.closed||!this.store.assistant(id)?.active)return;
    if(!this.connected(id))return;
    if(r.blockedQuotaEpoch!=null&&r.blockedQuotaEpoch===(r.channel.snapshot().replyBudget?.epoch??0))return;
    r.blockedQuotaEpoch=null;
    // Install the drain guard before send() can synchronously emit channel state.
    r.delivering=Promise.resolve().then(async()=>{
      for(const row of this.store.deliveries(id)){
        if(this.closed||!this.store.assistant(id)?.active||!this.connected(id))break;
        const p=JSON.parse(row.payload);
        if(!p.attachment&&TOOL_STATUS_TEXTS.has(p.text.trim())){this.store.deliveryState(row.id,'skipped');continue;}
        this.store.deliveryState(row.id,'sending');
        try{const result=p.attachment?await r.channel.sendAttachment(p.attachment,row.id,p.binding):await r.channel.send(p.text,row.id,p.binding);
          if(result.status==='blocked'){
            this.store.deliveryState(row.id,'pending',result.error);
            r.blockedQuotaEpoch=result.budgetEpoch??r.channel.snapshot().replyBudget?.epoch??0;
            this.publish(id,'delivery',{id:row.id});break;
          }
          if(result.download){
            const noticeId=uuidFor(`download-notice:${row.id}`),text=result.download.text;
            const message=this.store.tx(()=>{
              const m=this.store.message(noticeId)||this.store.addMessage(id,{id:noticeId,role:'assistant',text,source:'download-fallback',jobId:row.job_id});
              this.store.queueDelivery(noticeId,id,{text,binding:p.binding},row.job_id);
              return m;
            });
            this.publish(id,'message',message);
            result.error=`${result.error||'附件发送结果未确认'}；备用下载链接已加入发送队列`;
          }
          this.store.deliveryState(row.id,result.status==='sent'?'sent':result.status==='unknown'?'unknown':'failed',result.error||null);}
        catch(error){this.store.deliveryState(row.id,'failed',error.message);}
        this.publish(id,'delivery',{id:row.id});
      }
    }).finally(()=>{r.delivering=null;if(!this.closed&&this.store.assistant(id)?.active&&this.store.deliveries(id).length&&
      (r.blockedQuotaEpoch==null||r.blockedQuotaEpoch!==(r.channel.snapshot().replyBudget?.epoch??0)))queueMicrotask(()=>this.deliver(id));});r.delivering.catch(()=>{});
  }
  wake(id){
    if(this.closed||!this.store.assistant(id)?.active)return;
    const r=this.runtimes.get(id);if(!r){void this.runtime(this.store.assistant(id)).then(()=>this.wake(id)).catch(e=>this.publish(id,'error',{message:e.message}));return;}
    if(r.draining||r.connectionStop||!this.connected(id))return;
    r.draining=this.drain(id,r).finally(()=>{r.draining=null;if(!this.closed&&this.store.assistant(id)?.active&&this.store.pending(id).length)this.wake(id);});
    r.draining.catch(error=>this.publish(id,'error',{message:error.message}));
  }
  async drain(id,r){
    while(!this.closed&&this.store.assistant(id)?.active&&this.connected(id)&&!r.connectionStop){
      const jobs=this.store.pending(id);if(!jobs.length)break;
      const boundary=jobs.findIndex(j=>j.kind!=='chat');
      const selected=jobs[0].kind!=='chat'?[jobs[0]]:jobs.slice(0,boundary<0?20:Math.min(boundary,20));
      const job=selected[0];for(const j of selected)this.store.jobState(j.id,'running');
      const run=r.active={interrupted:false,submitted:false,superseded:false,inputAbort:new AbortController(),items:new Map(),jobId:job.id,scheduled:job.kind==='schedule',explicitTexts:new Set()};this.publish(id,'assistant',this.snapshot(id));
      const sendBinding=r.channel.snapshot().account;
      const sendMessage=(item,complete=false)=>{
        // Keep blank lines inside a single completed message. textDeliveries
        // alone handles size limits; web deltas remain immediate. Waiting also
        // lets an explicit send suppress the identical automatic reply.
        if(!complete)return;
        if(run.explicitTexts.has(item.text.trim())){item.sent=item.text.length;return;}
        if(item.text.length>item.sent){
          this.enqueueText(id,item.text.slice(item.sent),`${item.id}:${item.sent}`,job.id);item.sent=item.text.length;
        }
      };
      try{
        if(job.execution_mode==='reminder'){
          const message=this.store.tx(()=>{const m=this.store.addMessage(id,{role:'assistant',text:job.reminder_text,source:'reminder',jobId:job.id});for(const d of this.textDeliveries(id,m.text,`reminder:${job.id}`))this.store.queueDelivery(d.id,id,d.payload,job.id);this.store.jobState(job.id,'done');return m;});
          this.publish(id,'message',message);this.deliver(id);continue;
        }
        const a=this.store.assistant(id);await r.harness.prepare({threadId:a.thread_id,onThread:thread=>this.store.thread(id,thread)});
        if(this.closed||!this.store.assistant(id)?.active||!this.connected(id))throw Object.assign(new Error('助手已停止'),{code:'interrupted'});
        const attachments=selected.flatMap(j=>this.store.message(j.message_id)?.attachments||[]);
        const prepared=await prepareAttachments(attachments,a=>this.readAttachment(id,a,r),{signal:run.inputAbort.signal,stage:(file,options)=>r.harness.stageAttachment(file,options)});
        if(run.interrupted||this.closed)throw Object.assign(new Error('本轮已中断'),{code:'interrupted'});
        if(prepared.notices.length){
          const m=this.store.addMessage(id,{role:'system',kind:'status',text:'附件处理提示：\n'+prepared.notices.join('\n'),jobId:job.id});
          this.publish(id,'message',m);this.enqueueText(id,m.text,`attachment-status:${job.id}`,job.id);
        }
        const prompt=[selected.map(j=>j.prompt).join('\n\n[后续输入]\n'),prepared.text,prepared.notices.length?'附件预览说明（预览不等于完整内容，有原文件路径时可直接读取；不要编造未读取内容）：\n'+prepared.notices.join('\n'):''].filter(Boolean).join('\n\n');
        run.submitted=true;
        const task=r.harness.run({text:prompt,images:prepared.images,onSchedule:request=>this.scheduleFromTool(id,run,request),onSend:request=>this.sendFromTool(id,run,sendBinding,request),onEvent:event=>{
          if(r.active!==run)return;
          if(event.type==='started'){if(run.interrupted||!this.connected(id))void r.harness.interrupt().catch(()=>{});return;}
          if(run.interrupted||!this.connected(id))return;
          // Tool lifecycle events are internal; only assistant messages reach users.
          if(!['delta','message'].includes(event.type))return;
          let item=run.items.get(event.itemId);
          if(!item){const kind=job.kind==='summary'?'summary':event.phase==='commentary'?'progress':'chat';const m=this.store.addMessage(id,{role:'assistant',kind,state:'streaming',source:'harness',jobId:job.id});item={id:m.id,text:'',sent:0,phase:event.phase};run.items.set(event.itemId,item);}
          item.phase=event.phase||item.phase;
          item.text=event.type==='delta'?item.text+event.delta:event.text;
          const message=this.store.updateMessage(item.id,item.text,event.type==='message'?'complete':'streaming');
          this.publish(id,'message',message);sendMessage(item,event.type==='message');
        }});
        await task;if(run.interrupted||!this.connected(id))throw Object.assign(new Error('微信连接已断开'),{code:'interrupted'});for(const item of run.items.values()){sendMessage(item,true);this.publish(id,'message',this.store.updateMessage(item.id,item.text,'complete'));}
        for(const j of selected)this.store.jobState(j.id,'done');
      }catch(error){
        const interrupted=run.interrupted||this.closed||error.code==='interrupted';
        for(const item of run.items.values()){sendMessage(item,true);this.publish(id,'message',this.store.updateMessage(item.id,item.text,interrupted?'interrupted':'error'));}
        const requeue=run.superseded&&!run.submitted&&!this.closed&&this.store.assistant(id)?.active;
        for(const j of selected)this.store.jobState(j.id,requeue?'pending':interrupted?'interrupted':'failed',error.message);
        if(!interrupted){const m=this.store.addMessage(id,{role:'system',kind:'status',text:`执行失败：${error.message}`,state:'error',jobId:job.id});this.publish(id,'message',m);this.enqueueText(id,m.text,`error:${m.id}`,job.id);await r.harness.close();}
      }finally{this.schedules.settle();r.active=null;this.publish(id,'assistant',this.snapshot(id));}
    }
  }
  async readAttachment(id,attachment,r=this.runtimes.get(id)){return this.uploads?.has(id,attachment.id)?this.uploads.read(id,attachment.id):r.channel.readAttachment(attachment);}
  async interrupt(id){const r=this.runtimes.get(id);this.store.cancelPending(id);this.schedules.settle();if(r?.active){r.active.interrupted=true;r.active.inputAbort.abort();await r.harness.interrupt();}}
  async close(){this.closed=true;clearInterval(this.scheduleTimer);await Promise.all([...this.locks.values()].map(p=>p.catch(()=>{})));for(const r of this.runtimes.values()){await r.command.catch(()=>{});await r.channel.stop();if(r.active){r.active.interrupted=true;r.active.inputAbort.abort();await r.harness.interrupt().catch(()=>{});}}
    await Promise.all([...this.runtimes.values()].map(async r=>{await r.connectionStop;await r.draining;await r.delivering;await r.harness.close();await r.channel.close();}));}
}
