import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './store.js';
const derive=promisify(scrypt), digest=token=>createHash('sha256').update(token).digest('hex');
export async function hashPassword(password){
  if(typeof password!=='string'||password.length<10||password.length>128)throw new AppError(400,'密码须为 10–128 个字符');
  const salt=randomBytes(16).toString('hex'),hash=await derive(password,salt,64);return `${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password,saved){
  if(typeof password!=='string'||password.length>128)return false;
  const [salt,hex]=saved.split(':'),hash=await derive(password,salt,64),wanted=Buffer.from(hex,'hex');return wanted.length===hash.length&&timingSafeEqual(hash,wanted);
}
export class Auth {
  constructor(store,{secure=false}={}){this.store=store;this.secure=secure;this.attempts=new Map();}
  rate(key,limit=15,window=600000){const now=Date.now(),record=this.attempts.get(key);if(!record||record.until<now){this.attempts.set(key,{n:1,until:now+window});}else if(++record.n>limit)throw new AppError(429,'操作过于频繁，请稍后重试');if(this.attempts.size>10000)for(const[k,v]of this.attempts)if(v.until<now)this.attempts.delete(k);}
  async register(username,password,role='user'){
    if(typeof username!=='string'||! /^[a-zA-Z0-9_.-]{3,32}$/.test(username))throw new AppError(400,'用户名须为 3–32 位字母、数字、下划线、点或短横线');
    if(this.store.userByName(username))throw new AppError(409,'此用户名已注册');
    return this.store.addUser(username,await hashPassword(password),role);
  }
  async login(username,password){
    const u=typeof username==='string'&&this.store.userByName(username);
    const dummy='00000000000000000000000000000000:'+ '00'.repeat(64);
    const valid=await verifyPassword(password,u?.password_hash||dummy);
    if(!u||!valid)throw new AppError(401,'用户名或密码错误');return this.store.user(u.id);
  }
  issue(user,res){const token=randomBytes(32).toString('hex');this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),user.id,Date.now()+7*86400000);this.store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());res.setHeader('Set-Cookie',this.cookie(token));return token;}
  cookie(token){return `wxplatform=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?604800:0}${this.secure?'; Secure':''}`;}
  token(req){const match=(req.headers.cookie||'').match(/(?:^|;\s*)wxplatform=([a-f0-9]{64})(?:;|$)/);return match?.[1];}
  current(req){const token=this.token(req);if(!token)return null;const row=this.store.db.prepare('SELECT user_id FROM sessions WHERE hash=? AND expires_at>?').get(digest(token),Date.now());return row?this.store.user(row.user_id):null;}
  logout(req,res){const token=this.token(req);if(token)this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token));res.setHeader('Set-Cookie',this.cookie(''));}
  async changePassword(user,oldPassword,newPassword){const u=this.store.userByName(user.username);if(!await verifyPassword(oldPassword,u.password_hash))throw new AppError(400,'原密码不正确');const hash=await hashPassword(newPassword);this.store.tx(()=>{this.store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,user.id);this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);});}
}
