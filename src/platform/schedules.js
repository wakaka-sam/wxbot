import { randomUUID } from 'node:crypto';
import { AppError } from './store.js';
import { normalizeSchedule, nextSchedule } from './schedule-time.js';

export class Schedules {
 constructor(store){
  this.store=store;this.db=store.db;
  this.db.exec(`CREATE TABLE IF NOT EXISTS schedules(
   id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL REFERENCES assistants(id),request_id TEXT NOT NULL,
   name TEXT NOT NULL,prompt TEXT NOT NULL,spec TEXT NOT NULL,status TEXT NOT NULL,
   next_run_at INTEGER,last_run_at INTEGER,last_job_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
   UNIQUE(assistant_id,request_id));
   CREATE INDEX IF NOT EXISTS schedules_due ON schedules(status,next_run_at);`);
  if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='schedule_id'))this.db.exec('ALTER TABLE jobs ADD COLUMN schedule_id TEXT');
  if(!this.db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='scheduled_for'))this.db.exec('ALTER TABLE jobs ADD COLUMN scheduled_for INTEGER');
  this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS jobs_schedule_occurrence ON jobs(schedule_id,scheduled_for);');
 }
 view(row){
  if(!row)return null;
  const {request_id,...task}=row;
  return {...task,spec:JSON.parse(row.spec),last_job_state:row.last_job_id?this.db.prepare('SELECT state FROM jobs WHERE id=?').get(row.last_job_id)?.state||null:null};
 }
 get(assistantId,id){
  const row=this.db.prepare('SELECT * FROM schedules WHERE id=? AND assistant_id=?').get(id,assistantId);
  if(!row)throw new AppError(404,'自动任务不存在');return row;
 }
 list(assistantId){return this.db.prepare("SELECT * FROM schedules WHERE assistant_id=? ORDER BY CASE WHEN status IN ('active','paused','queued') THEN 0 ELSE 1 END,created_at DESC LIMIT 100").all(assistantId).map(r=>this.view(r));}
 request(assistantId,request,now=Date.now()){
  if(!request||typeof request!=='object'||Array.isArray(request))throw new AppError(400,'任务请求格式无效');
  const allowed=request.action==='add'?['action','requestId','name','prompt','spec']:request.action==='list'?['action']:['action','id'];
  if(Object.keys(request).some(k=>!allowed.includes(k)))throw new AppError(400,'任务请求包含不支持的字段');
  if(request.action==='list')return {tasks:this.list(assistantId),now:new Date(now).toISOString(),defaultTimezone:'Asia/Shanghai'};
  if(request.action==='add')return this.add(assistantId,request,now);
  if(!['pause','resume','remove'].includes(request.action)||typeof request.id!=='string')throw new AppError(400,'任务操作无效');
  return this.store.tx(()=>{
   const row=this.get(assistantId,request.id);
   if(['completed','cancelled'].includes(row.status))throw new AppError(409,'任务已结束，请创建新任务');
   if(row.status==='queued'&&request.action!=='remove')throw new AppError(409,'一次性任务已入队，可取消；已运行的任务会继续完成');
   let next=row.next_run_at;
   if(request.action==='resume'){
    if(row.status==='active')return {task:this.view(row)};
    const spec=JSON.parse(row.spec);next=nextSchedule(spec,now,Date.parse(row.created_at));
   }
   const status={pause:'paused',resume:'active',remove:'cancelled'}[request.action];
   this.db.prepare('UPDATE schedules SET status=?,next_run_at=?,updated_at=? WHERE id=?').run(status,status==='cancelled'?null:next,new Date(now).toISOString(),row.id);
   if(status!=='active')this.db.prepare("UPDATE jobs SET state='cancelled' WHERE schedule_id=? AND state='pending'").run(row.id);
   this.store.audit(this.store.assistant(assistantId).user_id,'schedule-'+request.action,row.id);
   return {task:this.view(this.get(assistantId,row.id)),note:'暂停或取消阻止后续执行；已经运行的任务允许完成。'};
  });
 }
 add(assistantId,{requestId,name,prompt,spec},now){
  if(typeof requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId))throw new AppError(400,'需要 8–100 位字母、数字、下划线或连字符组成的 requestId');
  if(typeof name!=='string'||!name.trim()||name.length>80||typeof prompt!=='string'||!prompt.trim()||prompt.length>10000)throw new AppError(400,'名称须为 1–80 字符，任务内容须为 1–10000 字符');
  // An acknowledged request may be retried after its one-time date has passed.
  const prior=this.db.prepare('SELECT * FROM schedules WHERE assistant_id=? AND request_id=?').get(assistantId,requestId);
  let normalized;
  try{normalized=normalizeSchedule(spec,prior?Date.parse(prior.created_at):now);}catch(e){throw new AppError(400,e.message);}
  const encoded=JSON.stringify(normalized);
  if(prior){
   if(prior.name!==name.trim()||prior.prompt!==prompt.trim()||prior.spec!==encoded)throw new AppError(409,'同一 requestId 不能更改任务');
   return {task:this.view(prior),duplicate:true};
  }
  return this.store.tx(()=>{
   const count=this.db.prepare("SELECT COUNT(*) n FROM schedules WHERE assistant_id=? AND status IN ('active','paused','queued')").get(assistantId).n;
   if(count>=20)throw new AppError(429,'每位用户最多保留 20 个未结束的自动任务');
   const id=randomUUID(),ts=new Date(now).toISOString(),next=nextSchedule(normalized,now);
   this.db.prepare('INSERT INTO schedules(id,assistant_id,request_id,name,prompt,spec,status,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,\'active\',?,?,?)').run(id,assistantId,requestId,name.trim(),prompt.trim(),encoded,next,ts,ts);
   this.store.audit(this.store.assistant(assistantId).user_id,'schedule-add',id);
   return {task:this.view(this.get(assistantId,id)),duplicate:false};
  });
 }
 settle(){this.db.exec("UPDATE schedules SET status='completed' WHERE status='queued' AND last_job_id IN (SELECT id FROM jobs WHERE state NOT IN ('pending','running'))");}
 due(now){return this.db.prepare("SELECT s.* FROM schedules s JOIN assistants a ON a.id=s.assistant_id WHERE s.status='active' AND a.active=1 AND s.next_run_at<=? ORDER BY s.next_run_at").all(now);}
 enqueue(id,now){
  return this.store.tx(()=>{
   const row=this.db.prepare("SELECT s.* FROM schedules s JOIN assistants a ON a.id=s.assistant_id WHERE s.id=? AND s.status='active' AND a.active=1 AND s.next_run_at<=?").get(id,now);
   if(!row||this.db.prepare("SELECT 1 FROM jobs WHERE schedule_id=? AND state IN ('pending','running')").get(id))return null;
   const jobId=randomUUID(),ts=new Date(now).toISOString(),spec=JSON.parse(row.spec);
   const message=this.store.addMessage(row.assistant_id,{role:'system',kind:'status',text:`自动任务「${row.name}」已到时间，等待执行（原定 ${new Date(row.next_run_at).toISOString()}）`,source:'schedule',sourceKey:`schedule:${row.id}:${row.next_run_at}`,jobId});
   const prompt=`[平台自动任务]\n任务：${row.name}\n原定时间：${new Date(row.next_run_at).toISOString()}\n当前时间：${ts}\n这是用户已创建的任务，到点执行一次下面的内容，不要再次创建定时任务。只完成此任务，不接续无关历史请求；完成后直接汇报结果，不发送多条进度。\n\n${row.prompt}`;
   this.db.prepare("INSERT INTO jobs(id,assistant_id,message_id,prompt,kind,state,created_at,schedule_id,scheduled_for) VALUES(?,?,?,?,'schedule','pending',?,?,?)").run(jobId,row.assistant_id,message.id,prompt,ts,row.id,row.next_run_at);
   this.db.prepare('UPDATE schedules SET status=?,next_run_at=?,last_run_at=?,last_job_id=?,updated_at=? WHERE id=?').run(spec.type==='once'?'queued':'active',spec.type==='once'?null:nextSchedule(spec,now,Date.parse(row.created_at)),now,jobId,ts,id);
   return {assistantId:row.assistant_id,message,jobId};
  });
 }
}
