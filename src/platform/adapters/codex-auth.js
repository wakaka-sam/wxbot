import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const locks=new Map();
async function readAuth(path,required=false){
  if(!path)return null;
  try{
    const raw=await readFile(path,'utf8'),data=JSON.parse(raw);
    const tokens=data.tokens,account=data.auth_mode==='chatgpt'?tokens?.account_id:null;
    if(!data.OPENAI_API_KEY&&!tokens?.access_token)throw new Error('invalid');
    let expires=0;
    try{const value=Number(JSON.parse(Buffer.from(tokens.access_token.split('.')[1],'base64url').toString()).exp)*1000;if(Number.isFinite(value)&&value>0)expires=value;}catch{}
    return {raw,account,expires,version:createHash('sha256').update(raw).digest('hex')};
  }catch{
    if(required)throw new Error('Codex 登录凭据不可用，请管理员检查平台模型登录配置');
    return null;
  }
}
async function replace(path,raw){
  const tmp=`${path}.${randomUUID()}.tmp`;
  try{await writeFile(tmp,raw,{mode:0o600,flag:'wx'});await rename(tmp,path);}
  finally{await rm(tmp,{force:true});}
}

// Auth metadata is used only to select fresher credentials for the configured
// account. JWT decoding is not authentication; the upstream still validates it.
// This does not refresh OAuth tokens or switch the deployment's account.
export async function syncCodexAuth(authFile,target,{sourceFile,now=Date.now()}={}){
  const key=resolve(authFile),previous=locks.get(key)||Promise.resolve();
  const task=previous.catch(()=>{}).then(async()=>{
    const canonical=await readAuth(authFile,true),cached=await readAuth(target);
    const source=sourceFile&&resolve(sourceFile)!==key?await readAuth(sourceFile):null;
    let selected=canonical;
    if(canonical.account){
      for(const candidate of [cached,source]){
        if(candidate?.account===canonical.account&&candidate.expires>selected.expires)selected=candidate;
      }
    }
    if(selected.expires&&selected.expires<=now){
      throw new Error('Codex 模型登录凭据已过期，请管理员更新平台的 Codex 登录；微信绑定和会话历史无需重建');
    }
    if(selected.version!==canonical.version)await replace(authFile,selected.raw);
    if(selected.version!==cached?.version)await replace(target,selected.raw);
    return selected.version;
  });
  locks.set(key,task);
  try{return await task;}finally{if(locks.get(key)===task)locks.delete(key);}
}
