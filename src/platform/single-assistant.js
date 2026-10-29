import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const cleanupKey='single-assistant:cleanup';
const validId=id=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
// Inspect saved logins without starting a second poller or reading conversations.
function hasLogin(dir,id){
  if(!validId(id))throw new Error('迁移遇到无效助手 ID');
  const file=join(dir,'assistants',id,'channel','clawbot.sqlite');
  if(!existsSync(file))return false;
  const db=new DatabaseSync(file,{readOnly:true});
  try{const row=db.prepare("SELECT value FROM settings WHERE key='account'").get();const account=row&&JSON.parse(row.value);return Boolean(account?.id&&account?.userId&&account?.token);}
  finally{db.close();}
}
export async function migrateSingleAssistant(store,dir){
  if(!store.get('single-assistant:v1')){
    // Resolve every winner before changing anything. An unreadable channel DB
    // fails the migration instead of silently deleting a possibly linked assistant.
    const plans=store.users().map(user=>{
      const choices=store.assistants(user.id).map(a=>({...a,login:hasLogin(dir,a.id)}));
      choices.sort((a,b)=>Number(b.login)-Number(a.login)||Number(b.login&&b.active)-Number(a.login&&a.active)||b.updated_at.localeCompare(a.updated_at)||a.id.localeCompare(b.id));
      return {user,keep:choices[0],remove:choices.slice(1)};
    });
    store.tx(()=>{
      const removed=[];
      for(const {user,keep,remove} of plans){
        if(!keep)store.createAssistant(user.id,'我的助手');
        else store.db.prepare('UPDATE assistants SET active=1 WHERE id=?').run(keep.id);
        for(const a of remove){
          for(const table of ['outbox','jobs','messages'])store.db.prepare(`DELETE FROM ${table} WHERE assistant_id=?`).run(a.id);
          for(const row of store.db.prepare('SELECT key,value FROM settings').all()){
            if(row.key===`assistant-binding:${a.id}`||(row.key.startsWith('binding:')&&JSON.parse(row.value)===a.id))store.db.prepare('DELETE FROM settings WHERE key=?').run(row.key);
          }
          store.db.prepare('DELETE FROM assistants WHERE id=?').run(a.id);removed.push(a.id);
          store.audit(user.id,'single-assistant-remove',a.id);
        }
      }
      store.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS assistants_one_per_user ON assistants(user_id)');
      store.set(cleanupKey,removed);store.set('single-assistant:v1',true);
    });
  }
  // A persisted cleanup list makes filesystem deletion retryable after a crash.
  for(const id of store.get(cleanupKey)||[]){
    if(!validId(id)||store.assistant(id))throw new Error('迁移清理目标无效');
    await rm(join(dir,'assistants',id),{recursive:true,force:true});
  }
  store.set(cleanupKey,[]);
}
