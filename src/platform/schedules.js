import { randomUUID } from 'node:crypto';
import { AppError } from './store.js';
import { normalizeSchedule, nextSchedule } from './schedule-time.js';
const requestIdValid=id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(id);
const timestamp=now=>new Date(now).toISOString();
export class Schedules {
 constructor(store){
  this.store=store;this.db=store.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS schedules(
   id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL REFERENCES assistants(id),request_id TEXT NOT NULL,
   name TEXT NOT NULL,prompt TEXT NOT NULL,spec TEXT NOT NULL,status TEXT NOT NULL,
   next_run_at INTEGER,last_run_at INTEGER,last_job_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
   UNIQUE(assistant_id,request_id));
   CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);`);
  for(const [table,columns] of Object.entries({jobs:{schedule_id:'TEXT',scheduled_for:'INTEGER'},schedules:{mode:"TEXT NOT NULL DEFAULT 'agent'",version:'INTEGER NOT NULL DEFAULT 1',creation_payload:'TEXT',anchor_at:'INTEGER'}})){
   const existing=new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
   for(const [column,type] of Object.entries(columns))if(!existing.has(column))this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  for(const row of this.db.prepare('SELECT id,created_at FROM schedules WHERE anchor_at IS NULL').all())this.db.prepare('UPDATE schedules SET anchor_at=? WHERE id=?').run(Date.parse(row.created_at),row.id);
  this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS jobs_schedule_occurrence ON jobs(schedule_id,scheduled_for);');
 }
 view(row){
  if(!row)return null;
  const {request_id,creation_payload,...task}=row;
  return {...task,spec:JSON.parse(row.spec),last_job_state:row.last_job_id?this.db.prepare('SELECT state FROM jobs WHERE id=?').get(row.last_job_id)?.state||null:null};
 }
 get(assistantId,id){const row=this.db.prepare('SELECT * FROM schedules WHERE id=? AND assistant_id=?').get(id,assistantId);if(!row)throw new AppError(404,'自动任务不存在');return row;}
 list(assistantId){return this.db.prepare("SELECT * FROM schedules WHERE assistant_id=? ORDER BY CASE WHEN status IN ('active','paused','queued') THEN 0 ELSE 1 END,created_at DESC LIMIT 100").all(assistantId).map(r=>this.view(r));}
 history(assistantId,id,{before=Number.MAX_SAFE_INTEGER,limit=20}={}){
  this.get(assistantId,id);
  if(!Number.isSafeInteger(before)||before<1||!Number.isInteger(limit)||limit<1||limit>50)throw new AppError(400,'分页参数无效');
  const rows=this.db.prepare('SELECT seq,id,state,created_at,started_at,finished_at,error,scheduled_for,execution_mode,manual FROM jobs WHERE assistant_id=? AND schedule_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(assistantId,id,before,limit+1);
  const runs=rows.slice(0,limit).map(row=>({...row,
   messages:this.db.prepare("SELECT id,role,kind,substr(text,1,12000) text,length(text)>12000 truncated,state,created_at FROM messages WHERE assistant_id=? AND job_id=? AND source<>'schedule' ORDER BY seq LIMIT 40").all(assistantId,row.id),
   deliveries:this.db.prepare('SELECT id,state,error,created_at,updated_at FROM outbox WHERE assistant_id=? AND job_id=? ORDER BY seq LIMIT 100').all(assistantId,row.id)}));
  return {runs,nextBefore:rows.length>limit?runs.at(-1).seq:null};
 }
 request(assistantId,request,now=Date.now()){
  if(!request||typeof request!=='object'||Array.isArray(request))throw new AppError(400,'任务请求格式无效');
  const fields={add:['action','requestId','name','prompt','spec','mode'],update:['action','id','version','name','prompt','spec','mode'],run:['action','id','requestId'],history:['action','id','before','limit'],list:['action']};
  const allowed=fields[request.action]||['action','id'];
  if(Object.keys(request).some(k=>!allowed.includes(k)))throw new AppError(400,`任务请求包含不支持的字段；允许字段：${allowed.join(', ')}。时间规则使用 spec，例如 {"type":"once","at":"含时区的未来ISO时间"}。运行 wxbot-schedule --help 查看完整示例。`);
  if(request.action==='list')return {tasks:this.list(assistantId),now:timestamp(now),defaultTimezone:'Asia/Shanghai'};
  if(request.action==='add')return this.add(assistantId,request,now);
  if(typeof request.id!=='string')throw new AppError(400,'需要任务 ID');
  if(request.action==='history')return this.history(assistantId,request.id,request);
  if(request.action==='update')return this.update(assistantId,request,now);
  if(request.action==='run')return this.runNow(assistantId,request,now);
  if(!['pause','resume','remove'].includes(request.action))throw new AppError(400,'任务操作无效');
  return this.store.tx(()=>{
   const row=this.get(assistantId,request.id);
   if(['completed','cancelled'].includes(row.status))throw new AppError(409,'任务已结束，请创建新任务');
   if(row.status==='queued'&&request.action!=='remove')throw new AppError(409,'一次性任务已入队，可取消；已运行的任务会继续完成');
   let next=row.next_run_at;
   if(request.action==='resume'){
    if(row.status==='active')return {task:this.view(row)};
    const spec=JSON.parse(row.spec);next=nextSchedule(spec,now,row.anchor_at??Date.parse(row.created_at));
    if(next===null)throw new AppError(409,'任务已超过截止时间，请先编辑规则');
   }
   const status={pause:'paused',resume:'active',remove:'cancelled'}[request.action];
   this.db.prepare('UPDATE schedules SET status=?,next_run_at=?,updated_at=?,version=version+1 WHERE id=?').run(status,status==='cancelled'?null:next,timestamp(now),row.id);
   if(status!=='active')this.cancelPending(row.id,now);
   this.store.audit(this.store.assistant(assistantId).user_id,'schedule-'+request.action,row.id);
   return {task:this.view(this.get(assistantId,row.id)),note:'暂停或取消阻止后续执行；已经运行的任务允许完成。'};
  });
 }
 content({name,prompt,spec,mode='agent'},now){
  if(typeof name!=='string'||!name.trim()||name.length>80||typeof prompt!=='string'||!prompt.trim()||prompt.length>10000)throw new AppError(400,'名称须为 1–80 字符，任务内容须为 1–10000 字符');
  if(!['agent','reminder'].includes(mode))throw new AppError(400,'模式须为 agent 或 reminder');
  let normalized;try{normalized=normalizeSchedule(spec,now);}catch(e){throw new AppError(400,e.message);}
  return {name:name.trim(),prompt:prompt.trim(),spec:JSON.stringify(normalized),mode};
 }
 add(assistantId,request,now){
  if(!requestIdValid(request.requestId))throw new AppError(400,'需要 8–100 位字母、数字、下划线或连字符组成的 requestId');
  const prior=this.db.prepare('SELECT * FROM schedules WHERE assistant_id=? AND request_id=?').get(assistantId,request.requestId);
  const content=this.content(request,prior?Date.parse(prior.created_at):now),encoded=JSON.stringify(content);
  if(prior){
   const original=prior.creation_payload||JSON.stringify({name:prior.name,prompt:prior.prompt,spec:prior.spec,mode:prior.mode});
   if(original!==encoded)throw new AppError(409,'同一 requestId 不能更改任务');
   return {task:this.view(prior),duplicate:true};
  }
  return this.store.tx(()=>{
   const count=this.db.prepare("SELECT COUNT(*) n FROM schedules WHERE assistant_id=? AND status IN ('active','paused','queued')").get(assistantId).n;
   if(count>=20)throw new AppError(429,'每位用户最多保留 20 个未结束的自动任务');
   const id=randomUUID(),ts=timestamp(now),next=nextSchedule(JSON.parse(content.spec),now);
   this.db.prepare("INSERT INTO schedules(id,assistant_id,request_id,name,prompt,spec,status,next_run_at,created_at,updated_at,mode,creation_payload,anchor_at) VALUES(?,?,?,?,?,?,'active',?,?,?,?,?,?)").run(id,assistantId,request.requestId,content.name,content.prompt,content.spec,next,ts,ts,content.mode,encoded,now);
   this.store.audit(this.store.assistant(assistantId).user_id,'schedule-add',id);
   return {task:this.view(this.get(assistantId,id)),duplicate:false};
  });
 }
 update(assistantId,request,now){
  return this.store.tx(()=>{
   const row=this.get(assistantId,request.id);
   if(!Number.isInteger(request.version)||row.version!==request.version)throw new AppError(409,'任务已发生变化，请刷新后再编辑');
   if(!['active','paused'].includes(row.status))throw new AppError(409,'仅可编辑启用或暂停的任务');
   if(this.busy(row.id))throw new AppError(409,'任务正在排队或执行，请等待完成，或先暂停取消排队');
   const c=this.content(request,now),next=nextSchedule(JSON.parse(c.spec),now);
   const original=row.creation_payload||JSON.stringify({name:row.name,prompt:row.prompt,spec:row.spec,mode:row.mode});
   this.db.prepare('UPDATE schedules SET name=?,prompt=?,spec=?,mode=?,next_run_at=?,updated_at=?,version=version+1,creation_payload=?,anchor_at=? WHERE id=?').run(c.name,c.prompt,c.spec,c.mode,next,timestamp(now),original,now,row.id);
   this.store.audit(this.store.assistant(assistantId).user_id,'schedule-update',row.id);
   return {task:this.view(this.get(assistantId,row.id))};
  });
 }
 busy(id){return this.db.prepare("SELECT 1 FROM jobs WHERE schedule_id=? AND state IN ('pending','running')").get(id);}
 cancelPending(id,now){this.db.prepare("UPDATE jobs SET state='cancelled',finished_at=? WHERE schedule_id=? AND state='pending'").run(timestamp(now),id);}
 settle(){this.db.exec("UPDATE schedules SET status='completed',version=version+1 WHERE status='queued' AND NOT EXISTS (SELECT 1 FROM jobs WHERE schedule_id=schedules.id AND state IN ('pending','running'))");}
 due(now){return this.db.prepare("SELECT s.* FROM schedules s JOIN assistants a ON a.id=s.assistant_id WHERE s.status='active' AND a.active=1 AND s.next_run_at<=? ORDER BY s.next_run_at").all(now);}
 createJob(row,now,{manual=false,requestId=null}={}){
  if(this.store.pending(row.assistant_id).length>=100)throw new AppError(429,'等待中的任务过多，请稍后再试');
  const jobId=randomUUID(),ts=timestamp(now),scheduledFor=manual?null:row.next_run_at;
  const message=this.store.addMessage(row.assistant_id,{role:'system',kind:'status',text:`自动任务「${row.name}」${manual?'手动试运行':'已到时间'}，等待执行`,source:'schedule',sourceKey:manual?`schedule-manual:${requestId}`:`schedule:${row.id}:${scheduledFor}`,jobId});
  const prompt=`[平台自动任务]\n任务：${row.name}\n原定时间：${timestamp(scheduledFor??now)}\n当前时间：${ts}\n这是用户已创建的任务，执行一次下面的内容，不要再次创建定时任务。只完成此任务，不接续无关历史请求；完成后直接汇报结果，不发送多条进度。\n\n${row.prompt}`;
  this.db.prepare("INSERT INTO jobs(id,assistant_id,message_id,prompt,kind,state,created_at,schedule_id,scheduled_for,execution_mode,reminder_text,manual,request_id) VALUES(?,?,?,?,'schedule','pending',?,?,?,?,?,?,?)").run(jobId,row.assistant_id,message.id,prompt,ts,row.id,scheduledFor,row.mode,row.mode==='reminder'?row.prompt:null,manual?1:0,requestId);
  this.db.prepare('UPDATE schedules SET last_run_at=?,last_job_id=?,updated_at=? WHERE id=?').run(now,jobId,ts,row.id);
  return {assistantId:row.assistant_id,message,jobId};
 }
 runNow(assistantId,{id,requestId},now){
  if(!requestIdValid(requestId))throw new AppError(400,'立即执行需要唯一 requestId；重试复用');
  return this.store.tx(()=>{
   const row=this.get(assistantId,id),prior=this.db.prepare('SELECT * FROM jobs WHERE assistant_id=? AND request_id=?').get(assistantId,requestId);
   if(prior){if(prior.schedule_id!==id)throw new AppError(409,'同一 requestId 不能用于其他任务');return {task:this.view(row),jobId:prior.id,duplicate:true};}
   if(row.status==='cancelled')throw new AppError(409,'任务已取消，请创建新任务');
   if(this.busy(id))throw new AppError(409,'已有执行等待中，请勿重复运行');
   const result=this.createJob(row,now,{manual:true,requestId});
   this.store.audit(this.store.assistant(assistantId).user_id,'schedule-run',id);
   return {...result,task:this.view(this.get(assistantId,id)),note:'试运行会真实执行任务并发送结果；原定时间不变。'};
  });
 }
 enqueue(id,now){
  return this.store.tx(()=>{
   const row=this.db.prepare("SELECT s.* FROM schedules s JOIN assistants a ON a.id=s.assistant_id WHERE s.id=? AND s.status='active' AND a.active=1 AND s.next_run_at<=?").get(id,now);
   if(!row||this.busy(id))return null;
   const spec=JSON.parse(row.spec);
   if(spec.until&&now>Date.parse(spec.until)){this.db.prepare("UPDATE schedules SET status='completed',next_run_at=NULL,version=version+1 WHERE id=?").run(id);return null;}
   const result=this.createJob(row,now),next=spec.type==='once'?null:nextSchedule(spec,now,row.anchor_at??Date.parse(row.created_at));
   this.db.prepare('UPDATE schedules SET status=?,next_run_at=?,version=version+1 WHERE id=?').run(next===null?'queued':'active',next,id);
   return result;
  });
 }
}
