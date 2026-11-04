import { readFile } from 'node:fs/promises';
export function mailEnabled(userId,env=process.env){return Boolean(userId&&env.PLATFORM_MAIL_USER_ID===userId&&env.PLATFORM_MAIL_TOKEN_FILE);}
export async function requestMail(userId,r,{env=process.env,fetcher=fetch}={}){
 if(!mailEnabled(userId,env))throw new Error('当前账号未获邮件读取授权');
 if(!r||typeof r!=='object'||Array.isArray(r))throw new Error('Invalid mail request');
 const allowed=r.action==='list'?['action','accountId','search','since','unread','offset']:r.action==='read'?['action','accountId','id']:r.action==='accounts'?['action']:[];
 if(!allowed.length||Object.keys(r).some(k=>!allowed.includes(k)))throw new Error('Unsupported mail operation');
 for(const [k,v] of Object.entries(r))if(typeof v!=='string'||v.length>300)throw new Error('Invalid mail argument');
 let path='/accounts';
 if(r.action==='list'){
  const q=new URLSearchParams(Object.entries(r).filter(([k])=>k!=='action'));path='/messages?'+q;
 }
 if(r.action==='read'){
  if(!r.accountId||!r.id)throw new Error('Missing message identity');
  path='/messages/'+encodeURIComponent(r.accountId)+'/'+encodeURIComponent(r.id);
 }
 const token=(await readFile(env.PLATFORM_MAIL_TOKEN_FILE,'utf8')).trim();
 // Fixed loopback target: requests never choose host, URL, credentials or user.
 let response;
 try{response=await fetcher('http://127.0.0.1:24784'+path,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(60000),redirect:'error'});}catch{throw new Error('邮件连接不可用，请确认 Mac 开机联网及邮件隧道正常');}
 if(!response.ok)throw new Error(`邮件读取失败（${response.status}）`);
 return response.json();
}
