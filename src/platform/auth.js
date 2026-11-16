import { scrypt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './store.js';
const GUEST_AGE=30*86400;
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
    const valid=await verifyPassword(password,u?.role==='guest'?dummy:u?.password_hash||dummy);
    if(!u||u.role==='guest'||!valid)throw new AppError(401,'用户名或密码错误');return this.store.user(u.id);
  }
  session(user){const token=randomBytes(32).toString('hex'),age=user.role==='guest'?GUEST_AGE:604800;this.store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),user.id,Date.now()+age*1000);this.store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());return {token,age};}
  issue(user,res){const {token,age}=this.session(user);res.setHeader('Set-Cookie',user.role==='guest'?[this.cookie(token,age),this.cookie(token,age,'wxplatform_guest')]:this.cookie(token,age));return token;}
  cookie(token,age=604800,name='wxplatform'){return `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token?age:0}${this.secure?'; Secure':''}`;}
  token(req,name='wxplatform'){const match=(req.headers.cookie||'').match(new RegExp('(?:^|;\\s*)'+name+'=([a-f0-9]{64})(?:;|$)'));return match?.[1];}
  guest(req,res){
    const current=this.current(req);if(current)return current;
    const token=this.token(req,'wxplatform_guest'),row=token&&this.store.db.prepare("SELECT s.expires_at,u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>? AND u.role='guest'").get(digest(token),Date.now());
    if(row){res.setHeader('Set-Cookie',this.cookie(token,Math.max(1,Math.floor((row.expires_at-Date.now())/1000))));return this.store.user(row.id);}
    this.rate(`guest:${req.socket.remoteAddress||'unknown'}`,60,3600000);
    const user=this.store.addUser('guest-'+randomBytes(10).toString('hex'),'','guest');this.issue(user,res);return user;
  }
  async bindGuest(user,username,password,res){
    if(typeof username!=='string'||!/^[a-zA-Z0-9_.-]{3,32}$/.test(username))throw new AppError(400,'用户名须为 3–32 位字母、数字、下划线、点或短横线');
    const hash=await hashPassword(password);
    const result=this.store.tx(()=>{
      if(this.store.user(user.id)?.role!=='guest')throw new AppError(409,'游客空间已绑定账号，请使用该账号登录');
      if(this.store.userByName(username))throw new AppError(409,'此用户名已注册；请换一个用户名绑定，或登录已有账号（不会合并游客资料）');
      this.store.db.prepare("UPDATE users SET username=?,password_hash=?,role='user' WHERE id=? AND role='guest'").run(username,hash,user.id);
      this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      const upgraded=this.store.user(user.id),session=this.session(upgraded);
      this.store.audit(user.id,'guest-account-bound',user.id);return {user:upgraded,...session};
    });
    res.setHeader('Set-Cookie',[this.cookie(result.token,result.age),this.cookie('',0,'wxplatform_guest')]);return result.user;
  }
  current(req){const token=this.token(req);if(!token)return null;const row=this.store.db.prepare('SELECT user_id FROM sessions WHERE hash=? AND expires_at>?').get(digest(token),Date.now());return row?this.store.user(row.user_id):null;}
  logout(req,res){const token=this.token(req);if(token)this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token));res.setHeader('Set-Cookie',this.cookie(''));}
  async changePassword(user,oldPassword,newPassword){if(user.role==='guest')throw new AppError(400,'请先绑定账号并设置密码');const u=this.store.userByName(user.username);if(!await verifyPassword(oldPassword,u.password_hash))throw new AppError(400,'原密码不正确');const hash=await hashPassword(newPassword);this.store.tx(()=>{this.store.db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,user.id);this.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);});}
}
