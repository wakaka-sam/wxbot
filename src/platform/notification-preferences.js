import {createHash} from 'node:crypto';
import {AppError} from './store.js';
const defaults={quiet:null,finalOnly:false,digestMinutes:0};
export const notificationPreferences=(store,id)=>({...defaults,...store.get(`notifications:${id}`)});
export function updateNotifications(store,id,patch){
 if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['quiet','finalOnly','digestMinutes'].includes(k)))throw new AppError(400,'通知设置字段无效');
 const p={...notificationPreferences(store,id),...patch};
 if(typeof p.finalOnly!=='boolean'||!Number.isInteger(p.digestMinutes)||p.digestMinutes<0||p.digestMinutes>1440)throw new AppError(400,'摘要间隔为 0–1440 整数分钟，0 表示关闭');
 if(p.quiet!==null){
  if(typeof p.quiet!=='object'||Object.keys(p.quiet).some(k=>!['start','end'].includes(k))||![p.quiet.start,p.quiet.end].every(t=>typeof t==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t))||p.quiet.start===p.quiet.end)throw new AppError(400,'免打扰起止时间须为不同的 HH:mm，使用北京时间');
 }
 store.set(`notifications:${id}`,p);return p;
}
export function isQuiet(p,now=Date.now()){
 if(!p.quiet)return false;
 const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now),{start,end}=p.quiet;
 return start<end?time>=start&&time<end:time>=start||time<end;
}
export function notificationKind(store,row,payload){
 if(payload.notice)return payload.notice;
 return row.job_id?(store.db.prepare('SELECT kind FROM jobs WHERE id=?').get(row.job_id)?.kind==='schedule'?'task':'reply'):'direct';
}
// Freeze a bounded digest and mark its source receipts in the same transaction.
// Retries only deliver the frozen outbox item; they never rebuild/resend it.
export function buildDigests(engine,id,prefs,now=Date.now()){
 if(!prefs.digestMinutes||isQuiet(prefs,now))return;
 const store=engine.store,groups=new Map();
 for(const row of store.deliveries(id)){
  const p=JSON.parse(row.payload);
  if(notificationKind(store,row,p)!=='task'||p.attachment)continue;
  const job=row.job_id&&store.db.prepare('SELECT state FROM jobs WHERE id=?').get(row.job_id);if(job&&['pending','running'].includes(job.state))continue;
  const key=JSON.stringify(p.binding);if(!groups.has(key))groups.set(key,[]);groups.get(key).push({row,p});
 }
 for(const group of groups.values()){
  if(Date.parse(group[0].row.created_at)+prefs.digestMinutes*60000>now)continue;
  const selected=group.slice(0,3),key=createHash('sha256').update(selected.map(x=>x.row.id).join(':')).digest('hex'),messageId='digest-'+key;
  const text='任务摘要\n\n'+selected.map(({row,p},i)=>{const task=row.job_id&&store.db.prepare('SELECT s.name FROM schedules s JOIN jobs j ON j.schedule_id=s.id WHERE j.id=?').get(row.job_id);return `${i+1}. ${task?.name||'自动任务'}\n${Array.from(p.text).slice(0,260).join('')}${Array.from(p.text).length>260?'…':''}`;}).join('\n\n')+'\n\n完整结果请查看网页聊天或任务执行记录。';
  const message=store.tx(()=>{
   const m=store.addMessage(id,{id:messageId,role:'system',kind:'summary',text,source:'notification-digest'});
   for(const d of engine.textDeliveries(id,text,messageId))store.queueDelivery(d.id,id,{...d.payload,binding:selected[0].p.binding,notice:'digest'});
   for(const {row} of selected)store.deliveryState(row.id,'skipped',`已合并至任务摘要 ${messageId}`);
   return m;
  });engine.publish(id,'message',message);
 }
}
