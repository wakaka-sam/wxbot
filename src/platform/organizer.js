import {randomUUID,createHash} from 'node:crypto';
import {AppError} from './store.js';
const fail=message=>{throw new AppError(400,message);};
const text=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.trim().length>max)fail(`${label}须为 1–${max} 个字符`);return value.trim();};
const priorities=['high','normal','low'];
export const organizerTime=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value)):'不设时间';
export function dueTime(value,now=Date.now()){
 if(value===null||value===undefined||value==='none'||value==='无')return null;
 if(typeof value!=='string')fail('截止时间无效');
 const relative=value.match(/^(\d+)(m|h|d)$/);
 let at;if(relative)at=now+Number(relative[1])*({m:60000,h:3600000,d:86400000}[relative[2]]);
 else {if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))fail('时间请用 30m、2h、1d、none 或含时区 ISO 时间');const [year,month,day]=value.slice(0,10).split('-').map(Number);if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate())fail('日期不存在');at=Date.parse(value);}
 if(!Number.isFinite(at)||at<=now||at>now+366*86400000)fail('截止时间须在未来一年内');return new Date(at).toISOString();
}
function tags(value=[]){if(!Array.isArray(value)||value.length>10)fail('标签最多 10 个');return [...new Set(value.map(v=>text(v,30,'标签')))];}
function url(value){const raw=text(value,2000,'链接');let u;try{u=new URL(raw);}catch{fail('链接无效');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)fail('仅支持不带账号密码的 HTTP/HTTPS 链接');return u.href;}
const decode=r=>r?{...r,...(r.tags?{tags:JSON.parse(r.tags),attachments:JSON.parse(r.attachments)}:{})}:r;
export class Organizer{
 constructor(store){this.store=store;this.db=store.db;this.db.exec(`
 CREATE TABLE IF NOT EXISTS todos(id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL REFERENCES assistants(id),title TEXT NOT NULL,due_at TEXT,priority TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',revision INTEGER NOT NULL DEFAULT 1,reminded_revision INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS todos_owner ON todos(assistant_id,status,due_at);
 CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL REFERENCES assistants(id),kind TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,tags TEXT NOT NULL,attachments TEXT NOT NULL DEFAULT '[]',message_seq INTEGER,status TEXT NOT NULL DEFAULT 'unread',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS collections_owner ON collections(assistant_id,created_at);
 CREATE TABLE IF NOT EXISTS organizer_receipts(assistant_id TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(assistant_id,request_id));
 CREATE TABLE IF NOT EXISTS guide_sessions(assistant_id TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(assistant_id,source));
 `);}
 get(kind,owner,ref){const table=kind==='todo'?'todos':'collections';if(typeof ref!=='string'||!/^[a-f0-9-]{8,36}$/.test(ref))fail('ID 请使用完整 ID 或至少 8 位唯一前缀');const rows=this.db.prepare(`SELECT * FROM ${table} WHERE assistant_id=? AND id LIKE ? LIMIT 2`).all(owner,ref+'%');if(!rows.length)throw new AppError(404,'找不到自己的这条记录');if(rows.length>1)fail('ID 前缀不唯一');return decode(rows[0]);}
 request(owner,r,now=Date.now()){
  if(!r||typeof r!=='object'||Array.isArray(r))fail('请求格式无效');
  const actions={todo:['list','get','add','update','done','remove'],collection:['list','get','add','update','read','unread','remove','export'],message:['recent']};
  if(typeof r.kind!=='string'||typeof r.action!=='string'||!Object.hasOwn(actions,r.kind)||!actions[r.kind].includes(r.action))fail('类型或操作无效，请查看 wxbot-organize --help');
  if(r.action==='update'&&!['title','dueAt','priority','tags'].some(k=>Object.hasOwn(r,k)))fail('请提供要修改的字段');
  const read=['list','get','export','recent'].includes(r.action);
  const allowed={list:['kind','action','filter','q','tag','page'],get:['kind','action','id'],export:['kind','action'],recent:['kind','action'],add:r.kind==='todo'?['kind','action','requestId','title','dueAt','priority']:['kind','action','requestId','type','title','url','messageSeq','attachmentId','tags'],update:r.kind==='todo'?['kind','action','requestId','id','title','dueAt','priority']:['kind','action','requestId','id','title','tags'],done:['kind','action','requestId','id'],remove:['kind','action','requestId','id'],read:['kind','action','requestId','id'],unread:['kind','action','requestId','id']}[r.action];
  if(Object.keys(r).some(k=>!allowed.includes(k)))fail('包含不支持的字段');
  if(!read&&(typeof r.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(r.requestId)))fail('修改操作需要 8–100 位 requestId，重试时保持不变');
  const hash=createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))))).digest('hex');
  return this.store.tx(()=>{
   if(!read){const old=this.db.prepare('SELECT * FROM organizer_receipts WHERE assistant_id=? AND request_id=?').get(owner,r.requestId);if(old){if(old.hash!==hash)throw new AppError(409,'requestId 已用于另一项操作');return JSON.parse(old.result);}}
   const result=this.perform(owner,r,now);
   if(!read){this.db.prepare('INSERT INTO organizer_receipts VALUES(?,?,?,?)').run(owner,r.requestId,hash,JSON.stringify(result));this.store.audit(this.store.assistant(owner).user_id,`organizer-${r.kind}-${r.action}`,result.item?.id||r.id);}
   return result;
  });
 }
 perform(owner,r,now){
  const stamp=new Date(now).toISOString(),table=r.kind==='todo'?'todos':'collections';
  if(r.kind==='message')return {items:this.db.prepare('SELECT seq,role,text,attachments FROM messages WHERE assistant_id=? ORDER BY seq DESC LIMIT 10').all(owner).map(m=>({...m,text:m.text.slice(0,800),attachments:JSON.parse(m.attachments)}))};
  if(r.action==='get')return {item:this.get(r.kind,owner,r.id)};
  if(r.action==='list'){
   const page=r.page??1;if(!Number.isSafeInteger(page)||page<1||page>10000)fail('页码无效');let where='assistant_id=?',values=[owner];
   if(r.kind==='todo'){
    const filter=r.filter||'open';if(!['open','today','done','all'].includes(filter))fail('待办筛选为 open/today/done/all');
    if(filter!=='all'){where+=' AND status=?';values.push(filter==='done'?'done':'open');}
    if(filter==='today'){const shifted=new Date(now+8*3600000),end=Date.parse(shifted.toISOString().slice(0,10)+'T23:59:59.999+08:00');where+=' AND due_at<=?';values.push(new Date(end).toISOString());}
   }else{const filter=r.filter||'all';if(!['all','unread','read'].includes(filter))fail('收藏筛选为 all/unread/read');if(filter!=='all'){where+=' AND status=?';values.push(filter);}if(r.tag){where+=' AND EXISTS(SELECT 1 FROM json_each(tags) WHERE value=?)';values.push(text(r.tag,30,'标签'));}}
   if(r.q){where+=r.kind==='todo'?' AND instr(lower(title),lower(?))>0':' AND (instr(lower(title),lower(?))>0 OR instr(lower(content),lower(?))>0)';values.push(text(r.q,100,'关键词'));if(r.kind==='collection')values.push(r.q.trim());}
   const total=this.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...values).n;
   const order=r.kind==='todo'?"CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,due_at IS NULL,due_at,id":"created_at DESC,id";
   return {items:this.db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT 10 OFFSET ?`).all(...values,(page-1)*10).map(decode),page,total,pages:Math.max(1,Math.ceil(total/10))};
  }
  if(r.action==='export'){
   const rows=this.db.prepare('SELECT * FROM collections WHERE assistant_id=? ORDER BY created_at,id').all(owner).map(decode);
   return {format:'json',items:rows};
  }
  if(r.action==='add'){
   if(this.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE assistant_id=?`).get(owner).n>=1000)throw new AppError(429,'最多保存 1000 条，请先删除不用的记录');
   const id=randomUUID();
   if(r.kind==='todo'){
    const priority=r.priority===undefined?'normal':r.priority;if(!priorities.includes(priority))fail('优先级为 high/normal/low');
    this.db.prepare('INSERT INTO todos(id,assistant_id,title,due_at,priority,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,owner,text(r.title,300,'待办标题'),dueTime(r.dueAt,now),priority,stamp,stamp);
   }else{
    let content,attachments=[],seq=null,title=r.title;
    if(r.type==='link'){if(r.messageSeq!==undefined||r.attachmentId!==undefined)fail('链接收藏不要填写消息或附件编号');content=url(r.url);title||=content.slice(0,300);}
    else if(r.type==='message'){
     if(r.url!==undefined||r.attachmentId!==undefined)fail('消息收藏不要填写链接或附件编号');if(!Number.isSafeInteger(r.messageSeq))fail('消息编号无效');
     const m=this.db.prepare('SELECT * FROM messages WHERE assistant_id=? AND seq=?').get(owner,r.messageSeq);if(!m)throw new AppError(404,'找不到自己的这条消息');content=m.text;attachments=JSON.parse(m.attachments);seq=m.seq;title||=content.slice(0,80)||'消息附件';
    }else if(r.type==='file'){
     if(r.url!==undefined||r.messageSeq!==undefined)fail('文件收藏不要填写链接或消息编号');if(typeof r.attachmentId!=='string')fail('附件 ID 无效');const a=this.store.attachment(owner,r.attachmentId);if(!a||a.error)throw new AppError(404,'找不到自己的可用附件');content=a.name||'附件';attachments=[a];title||=content;
    }else fail('收藏类型为 link/message/file');
    this.db.prepare('INSERT INTO collections(id,assistant_id,kind,title,content,tags,attachments,message_seq,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,owner,r.type,text(title,300,'收藏标题'),content,JSON.stringify(tags(r.tags)),JSON.stringify(attachments),seq,stamp,stamp);
   }
   return {item:this.get(r.kind,owner,id)};
  }
  const item=this.get(r.kind,owner,r.id);
  if(r.action==='remove'){this.cancelReminders(item.id);this.db.prepare(`DELETE FROM ${table} WHERE id=? AND assistant_id=?`).run(item.id,owner);return {removed:item.id};}
  if(r.kind==='todo'){
   if(r.action==='done'){this.db.prepare("UPDATE todos SET status='done',updated_at=? WHERE id=?").run(stamp,item.id);this.cancelReminders(item.id);}
   else{
    if(item.status!=='open')fail('已完成待办不能修改，请新建待办');
    const title=r.title===undefined?item.title:text(r.title,300,'待办标题'),priority=r.priority??item.priority,due=r.dueAt===undefined?item.due_at:dueTime(r.dueAt,now);if(!priorities.includes(priority))fail('优先级为 high/normal/low');
    // Any pending reminder text becomes stale on edit. Already-sent reminders only reset on a new deadline.
    const reset=due!==item.due_at||item.reminded_revision===item.revision&&this.db.prepare("SELECT 1 FROM outbox WHERE state='pending' AND json_extract(payload,'$.todoId')=?").get(item.id);
    this.cancelReminders(item.id);
    this.db.prepare('UPDATE todos SET title=?,due_at=?,priority=?,revision=revision+1,reminded_revision=?,updated_at=? WHERE id=?').run(title,due,priority,reset||item.reminded_revision===null?null:item.revision+1,stamp,item.id);
   }
  }else{
   if(r.action==='update')this.db.prepare('UPDATE collections SET title=?,tags=?,updated_at=? WHERE id=?').run(r.title===undefined?item.title:text(r.title,300,'收藏标题'),JSON.stringify(r.tags===undefined?item.tags:tags(r.tags)),stamp,item.id);
   else this.db.prepare('UPDATE collections SET status=?,updated_at=? WHERE id=?').run(r.action,stamp,item.id);
  }
  return {item:this.get(r.kind,owner,item.id)};
 }
 cancelReminders(id){this.db.prepare("UPDATE outbox SET state='skipped',error='待办已完成、修改或删除',updated_at=? WHERE state='pending' AND json_extract(payload,'$.todoId')=?").run(new Date().toISOString(),id);}
 reminderValid(owner,p){if(!p.todoId)return true;const t=this.db.prepare('SELECT status,revision FROM todos WHERE assistant_id=? AND id=?').get(owner,p.todoId);return t?.status==='open'&&t.revision===p.todoRevision;}
 tick(engine,now){
  const rows=this.db.prepare("SELECT t.* FROM todos t JOIN assistants a ON a.id=t.assistant_id WHERE a.active=1 AND t.status='open' AND t.due_at<=? AND (t.reminded_revision IS NULL OR t.reminded_revision!=t.revision)").all(new Date(now).toISOString());
  for(const t of rows){try{const body=`待办到期：${t.title}\n\n截止：${organizerTime(t.due_at)}（北京时间）\n\n完成后发送 /todo done ${t.id}`;const deliveries=engine.textDeliveries(t.assistant_id,body,`todo:${t.id}:${t.revision}`);if(!deliveries.length)continue;
   const m=this.store.tx(()=>{const m=this.store.addMessage(t.assistant_id,{role:'system',text:body,source:'todo-reminder'});for(const d of deliveries)this.store.queueDelivery(d.id,t.assistant_id,{...d.payload,notice:'todo',todoId:t.id,todoRevision:t.revision});this.db.prepare('UPDATE todos SET reminded_revision=revision WHERE id=?').run(t.id);return m;});engine.publish(t.assistant_id,'message',m);engine.deliver(t.assistant_id);
  }catch(error){engine.publish(t.assistant_id,'error',{message:`待办提醒入队失败：${error.message}`});}}
 }
}
