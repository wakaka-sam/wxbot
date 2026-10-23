import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export class AppError extends Error {
  constructor(status, message, code = 'ERROR', details) { super(message); Object.assign(this, { status, code, details }); }
}
const decodeMessage = row => row ? {...row,attachments:JSON.parse(row.attachments||'[]')} : row;
const now = () => new Date().toISOString();
export class PlatformStore {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.db = new DatabaseSync(join(dir, 'platform.sqlite')); chmodSync(join(dir, 'platform.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS assistants(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 0,harness TEXT NOT NULL DEFAULT 'codex',channel TEXT NOT NULL DEFAULT 'wechat',thread_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,assistant_id TEXT NOT NULL REFERENCES assistants(id),role TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,source TEXT NOT NULL,source_key TEXT,job_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(assistant_id,source_key));
      CREATE INDEX IF NOT EXISTS messages_assistant ON messages(assistant_id,seq);
      CREATE TABLE IF NOT EXISTS jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,assistant_id TEXT NOT NULL REFERENCES assistants(id),message_id TEXT,prompt TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_assistant ON jobs(assistant_id,state,seq);
      CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,assistant_id TEXT NOT NULL REFERENCES assistants(id),payload TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT,action TEXT NOT NULL,target_id TEXT,created_at TEXT NOT NULL);`);
    if(!this.db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='attachments'))this.db.exec("ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  user(id) { return this.db.prepare('SELECT id,username,role,created_at FROM users WHERE id=?').get(id); }
  userByName(name) { return this.db.prepare('SELECT * FROM users WHERE username=?').get(name); }
  addUser(username, hash, role='user') {
    const id=randomUUID();
    try { this.db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id,username,hash,role,now()); }
    catch(e) { if (String(e.message).includes('UNIQUE')) throw new AppError(409,'此用户名已注册'); throw e; }
    return this.user(id);
  }
  users() { return this.db.prepare(`SELECT u.id,u.username,u.role,u.created_at,COUNT(a.id) AS assistants,COALESCE(SUM(a.active),0) AS active FROM users u LEFT JOIN assistants a ON a.user_id=u.id GROUP BY u.id ORDER BY u.created_at`).all(); }
  audit(actor,action,target) { this.db.prepare('INSERT INTO audit(actor_id,action,target_id,created_at) VALUES(?,?,?,?)').run(actor,action,target,now()); }
  set(key,value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,JSON.stringify(value)); }
  get(key) { const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row?JSON.parse(row.value):null; }
  assistant(id) { return this.db.prepare('SELECT * FROM assistants WHERE id=?').get(id); }
  owned(id,user,readOnly=false) {
    const a=this.assistant(id);
    if(!a || (a.user_id!==user.id && !(readOnly && user.role==='admin'))) throw new AppError(404,'助手不存在');
    return a;
  }
  assistants(userId) { return userId ? this.db.prepare('SELECT * FROM assistants WHERE user_id=? ORDER BY created_at').all(userId) : this.db.prepare('SELECT * FROM assistants ORDER BY created_at').all(); }
  createAssistant(userId,name) {
    if(typeof name!=='string'||!name.trim()||name.trim().length>60) throw new AppError(400,'助手名称须为 1–60 个字符');
    if(this.assistants(userId).length>=50) throw new AppError(409,'每位用户最多保存 50 个助手');
    const id=randomUUID(),ts=now(); this.db.prepare('INSERT INTO assistants(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,userId,name.trim(),ts,ts); return this.assistant(id);
  }
  activate(id,user,stopId) {
    return this.tx(()=>{
      const a=this.owned(id,user); if(a.active) return {assistant:a,stopped:null};
      const active=this.db.prepare('SELECT id,name FROM assistants WHERE user_id=? AND active=1').all(user.id);
      if(active.length>=3 && !stopId) throw new AppError(409,'最多同时激活 3 个助手，请先选择一个助手停止','ACTIVE_LIMIT',{active});
      let stopped=null;
      if(stopId){ const old=this.owned(stopId,user); if(!old.active||stopId===id) throw new AppError(400,'请选择正在激活的其他助手');
        this.db.prepare('UPDATE assistants SET active=0,updated_at=? WHERE id=?').run(now(),stopId); stopped=stopId;
      }
      if(this.db.prepare('SELECT COUNT(*) n FROM assistants WHERE user_id=? AND active=1').get(user.id).n>=3) throw new AppError(409,'激活数量已达上限','ACTIVE_LIMIT',{active});
      this.db.prepare('UPDATE assistants SET active=1,updated_at=? WHERE id=?').run(now(),id);
      this.audit(user.id,'activate',id); return {assistant:this.assistant(id),stopped};
    });
  }
  deactivate(id,user) { this.owned(id,user); this.db.prepare('UPDATE assistants SET active=0,updated_at=? WHERE id=?').run(now(),id); this.audit(user.id,'deactivate',id); }
  rename(id,user,name){this.owned(id,user); if(typeof name!=='string'||!name.trim()||name.trim().length>60)throw new AppError(400,'名称须为 1–60 个字符');this.db.prepare('UPDATE assistants SET name=?,updated_at=? WHERE id=?').run(name.trim(),now(),id);}
  thread(id,threadId){this.db.prepare('UPDATE assistants SET thread_id=?,updated_at=? WHERE id=?').run(threadId,now(),id);}
  messages(id,{before=Number.MAX_SAFE_INTEGER,limit=100}={}){return this.db.prepare('SELECT * FROM messages WHERE assistant_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(id,before,limit).reverse().map(decodeMessage);}
  recent(id,limit=10){return this.db.prepare("SELECT * FROM messages WHERE assistant_id=? AND kind='chat' AND role IN ('user','assistant') AND text<>'' ORDER BY seq DESC LIMIT ?").all(id,limit).reverse().map(decodeMessage);}
  message(id){return decodeMessage(this.db.prepare('SELECT * FROM messages WHERE id=?').get(id));}
  attachment(assistantId,id){const row=this.db.prepare("SELECT j.value FROM messages m,json_each(m.attachments) j WHERE m.assistant_id=? AND json_extract(j.value,'$.id')=? LIMIT 1").get(assistantId,id);return row?JSON.parse(row.value):null;}
  addMessage(a,{id=randomUUID(),role,kind='chat',text='',state='complete',source='system',sourceKey=null,jobId=null,attachments=[]}){
    const ts=now();this.db.prepare('INSERT INTO messages(id,assistant_id,role,kind,text,state,source,source_key,job_id,created_at,updated_at,attachments) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,a,role,kind,text,state,source,sourceKey,jobId,ts,ts,JSON.stringify(attachments));return this.message(id);
  }
  updateMessage(id,text,state='streaming'){this.db.prepare('UPDATE messages SET text=?,state=?,updated_at=? WHERE id=?').run(text,state,now(),id);return this.message(id);}
  submit(id,text,source,key,kind='chat',{messageId,outbound=[],attachments=[]}={}){
    return this.tx(()=>{
      const prior=key&&this.db.prepare('SELECT * FROM messages WHERE assistant_id=? AND source_key=?').get(id,key); if(prior){
        // Backfill metadata for previously ingested WeChat history, without rerunning the model.
        if(attachments.length&&!decodeMessage(prior).attachments.length)this.db.prepare('UPDATE messages SET attachments=? WHERE id=?').run(JSON.stringify(attachments),prior.id);
        return {message:this.message(prior.id),duplicate:true};
      }
      if(this.pending(id).length>=100)throw new AppError(429,'等待中的消息过多，请稍后发送');
      const jobId=randomUUID();
      const message=kind==='chat'?this.addMessage(id,{id:messageId,role:'user',text,source,sourceKey:key,jobId,attachments}):null;
      this.db.prepare('INSERT INTO jobs(id,assistant_id,message_id,prompt,kind,state,created_at) VALUES(?,?,?,?,?,?,?)').run(jobId,id,message?.id||null,text,kind,'pending',now());
      for(const delivery of outbound)this.queueDelivery(delivery.id,id,delivery.payload);
      return {message,jobId,duplicate:false};
    });
  }
  pending(id){return this.db.prepare("SELECT * FROM jobs WHERE assistant_id=? AND state='pending' ORDER BY seq").all(id);}
  jobState(id,state){this.db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state,id);}
  cancelPending(id){this.db.prepare("UPDATE jobs SET state='cancelled' WHERE assistant_id=? AND state='pending'").run(id);}
  recover(){this.db.prepare("UPDATE jobs SET state='interrupted' WHERE state='running'").run();this.db.prepare("UPDATE messages SET state='interrupted' WHERE state='streaming'").run();this.db.prepare("UPDATE outbox SET state='unknown',error='服务重启，发送结果待确认' WHERE state='sending'").run();}
  queueDelivery(id,a,payload){this.db.prepare('INSERT OR IGNORE INTO outbox(id,assistant_id,payload,state,created_at) VALUES(?,?,?,?,?)').run(id,a,JSON.stringify(payload),'pending',now());}
  deliveries(a){return this.db.prepare("SELECT * FROM outbox WHERE assistant_id=? AND state='pending' ORDER BY seq").all(a);}
  deliveryState(id,state,error=null){this.db.prepare('UPDATE outbox SET state=?,error=? WHERE id=?').run(state,error,id);}
  deliveryErrors(a){return this.db.prepare("SELECT id,state,error,created_at FROM outbox WHERE assistant_id=? AND state IN ('failed','unknown') ORDER BY seq DESC LIMIT 10").all(a);}
  close(){this.db.close();}
}
