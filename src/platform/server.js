import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformStore, AppError } from './store.js';
import { Auth } from './auth.js';
import { Engine } from './engine.js';
import { MEDIA_ID } from './attachments.js';
import { describeMedia } from '../media.js';
import { Downloads, handleDownloads } from '../downloads.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const publicFiles={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/favicon.svg':['../favicon.svg','image/svg+xml']};
const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY',
 'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
export async function createPlatform({dir=resolve(process.env.PLATFORM_DATA_DIR||join(root,'platform-data')),publicUrl=process.env.PLATFORM_PUBLIC_URL,adminUsername=process.env.PLATFORM_ADMIN_USERNAME||'admin',adminPassword=process.env.PLATFORM_ADMIN_PASSWORD,engineOptions={},downloadTokenFile=process.env.WXBOT_DOWNLOAD_TOKEN_FILE}={}){
 const downloads=new Downloads(join(dir,'downloads'),{publicUrl});
 const store=new PlatformStore(dir),auth=new Auth(store,{secure:publicUrl?.startsWith('https://')}),engine=new Engine(store,dir,{publishDownload:(...args)=>downloads.publish(...args),...engineOptions});
 if(!store.users().some(u=>u.role==='admin')){if(!adminPassword){store.close();throw new Error('首次启动请设置 PLATFORM_ADMIN_PASSWORD（至少 10 位），用于初始化管理员');}await auth.register(adminUsername,adminPassword,'admin');}
 await engine.init();const clients=new Map();let closing=false;
 const sendEvent=(res,type,data)=>{if(res.writableLength>1024*1024)res.destroy();else res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);};
 engine.on('event',event=>{for(const[res,c]of clients){if(c.assistantId!==event.assistantId)continue;if(!auth.current(c.req)){res.end();clients.delete(res);continue;}sendEvent(res,'update',event);}});
 const heartbeat=setInterval(()=>{for(const[res,c]of clients){if(!auth.current(c.req)){res.end();clients.delete(res);}else res.write(': heartbeat\n\n');}},15000);heartbeat.unref();
 let cleaning=downloads.cleanup().catch(()=>{});
 const cleanup=setInterval(()=>{cleaning=cleaning.then(()=>downloads.cleanup()).catch(()=>{});},600000);cleanup.unref();
 const server=http.createServer(async(req,res)=>{
  const send=(status,data,type='application/json; charset=utf-8')=>{res.writeHead(status,{...headers,'Content-Type':type});res.end(type.startsWith('application/json')?JSON.stringify(data):data);};
  try{
   if(closing)return send(503,{error:'服务正在重启'});
   const port=server.address()?.port,origins=[`http://127.0.0.1:${port}`,`http://localhost:${port}`,...(publicUrl?[new URL(publicUrl).origin]:[])];
   if(!origins.some(o=>new URL(o).host===req.headers.host))return send(403,{error:'不允许此访问地址'});
   const url=new URL(req.url,origins[0]);let body={};
   if(await handleDownloads(req,res,url,downloads,downloadTokenFile))return;
   // External links may load the public shell. Never exempt API requests or writes.
   const publicGet=req.method==='GET'&&Object.hasOwn(publicFiles,url.pathname);
   if(!publicGet){
    if(req.headers.origin&&!origins.includes(req.headers.origin))return send(403,{error:'不允许跨站访问'});
    if(req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'不允许跨站访问'});
   }
   if(req.method==='POST'){
    if(req.headers['x-wxbot-platform']!=='1')return send(403,{error:'缺少操作校验标识'});
    const chunks=[];let length=0;for await(const c of req){length+=c.length;if(length>65536)throw new AppError(413,'请求过大');chunks.push(c);}try{body=length?JSON.parse(Buffer.concat(chunks).toString()):{};}catch{throw new AppError(400,'请求格式无效');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new AppError(400,'请求格式无效');
   }else if(req.method!=='GET')return send(405,{error:'请求方法不支持'});
   const path=url.pathname,user=auth.current(req),ip=req.socket.remoteAddress||'unknown';
   if(path==='/api/auth'&&req.method==='GET')return send(200,{user});
   if(path==='/api/register'&&req.method==='POST'){auth.rate(`register:${ip}`,10,3600000);const u=await auth.register(body.username,body.password);auth.issue(u,res);return send(201,{user:u});}
   if(path==='/api/login'&&req.method==='POST'){auth.rate(`login:${ip}`,30);const u=await auth.login(body.username,body.password);auth.issue(u,res);return send(200,{user:u});}
   if(path==='/api/logout'&&req.method==='POST'){auth.logout(req,res);for(const[r,c]of clients)if(!auth.current(c.req)){r.end();clients.delete(r);}return send(200,{ok:true});}
   if(path==='/health')return send(200,{ok:true});
   if(!path.startsWith('/api/')){
    if(req.method!=='GET')throw new AppError(405,'请求方法不支持');
    const file=publicGet?publicFiles[path]:null;if(!file)throw new AppError(404,'页面不存在');return send(200,await readFile(join(root,'public/platform',file[0])),file[1]);
   }
   if(!user)throw new AppError(401,'请先登录');
   if(path==='/api/password'&&req.method==='POST'){await auth.changePassword(user,body.oldPassword,body.newPassword);auth.issue(user,res);return send(200,{ok:true});}
   if(path==='/api/assistants'){
    if(req.method==='GET'){const a=store.assistants(user.id)[0];if(a&&!engine.runtimes.has(a.id))await engine.activate(a.id,user);return send(200,{assistants:engine.list(user.id),activeLimit:1});}
    throw new AppError(409,'默认助手已创建，不支持新增助手','SINGLE_ASSISTANT');
   }
   if(path.startsWith('/api/admin/')){
    if(user.role!=='admin')throw new AppError(403,'需要管理员权限');
    if(req.method!=='GET')throw new AppError(405,'管理员视图只读');
    if(path==='/api/admin/users')return send(200,{users:store.users()});
    const match=path.match(/^\/api\/admin\/users\/([a-f0-9-]+)\/assistants$/);
    if(match){store.audit(user.id,'view-user',match[1]);return send(200,{user:store.user(match[1]),assistants:engine.list(match[1])});}
    throw new AppError(404,'接口不存在');
   }
   const match=path.match(/^\/api\/assistants\/([a-f0-9-]+)(?:\/(.+))?$/);if(!match)throw new AppError(404,'接口不存在');
   const[,id,action='']=match,a=store.owned(id,user,req.method==='GET'),readOnly=a.user_id!==user.id;
   if(req.method==='GET'){
    if(action==='')return send(200,{assistant:engine.snapshot(id),readOnly});
    if(action.startsWith('attachments/')){
      const mediaId=action.slice('attachments/'.length);
      if(!MEDIA_ID.test(mediaId))throw new AppError(404,'附件不存在');
      const attachment=store.attachment(id,mediaId);
      if(!attachment||attachment.error)throw new AppError(404,'附件不存在或下载失败');
      const runtime=await engine.runtime(a);
      let bytes;try{bytes=await runtime.channel.readAttachment(attachment);}catch{throw new AppError(404,'附件文件已不可用');}
      const description=describeMedia(bytes,attachment.name);
      if(readOnly)store.audit(user.id,'view-attachment',id);
      const inline=description.kind==='image'&&url.searchParams.get('download')!=='1';
      res.setHeader('Content-Disposition',`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name.toWellFormed())}`);
      res.setHeader('Content-Length',bytes.length);
      return send(200,bytes,inline?description.mime:'application/octet-stream');
    }
    if(action==='messages'){
      const before=Number(url.searchParams.get('before')||Number.MAX_SAFE_INTEGER),limit=Number(url.searchParams.get('limit')||100);
      if(!Number.isSafeInteger(before)||before<1||!Number.isInteger(limit)||limit<1||limit>200)throw new AppError(400,'分页参数无效');
      if(readOnly)store.audit(user.id,'view-history',id);
      const messages=store.messages(id,{before,limit});return send(200,{messages,hasMore:messages.length===limit});
    }
    if(action==='events'){
      if([...clients.values()].filter(c=>c.userId===user.id).length>=20)throw new AppError(429,'打开的实时页面过多');
      res.writeHead(200,{...headers,'Content-Type':'text/event-stream',Connection:'keep-alive','X-Accel-Buffering':'no'});
      clients.set(res,{req,userId:user.id,assistantId:id});req.on('close',()=>clients.delete(res));sendEvent(res,'snapshot',{assistant:engine.snapshot(id),messages:store.messages(id),readOnly});return;
    }
    throw new AppError(404,'接口不存在');
   }
   if(action==='activate'||action==='deactivate')throw new AppError(410,'默认助手无需激活或停止，请使用微信连接管理');
   if(action==='rename'){store.rename(id,user,body.name);return send(200,{assistant:engine.snapshot(id)});}
   if(action==='messages'){auth.rate(`message:${user.id}`,120,60000);return send(202,engine.submit(id,body.text,'web',body.requestId));}
   if(action==='interrupt'){await engine.interrupt(id);return send(200,{assistant:engine.snapshot(id)});}
   if(action.startsWith('channel/'))return send(200,{assistant:await engine.channelCommand(id,action.slice(8),body)});
   throw new AppError(404,'接口不存在');
  }catch(error){if(!res.headersSent)send(error.status||400,{error:error.message,code:error.code||'ERROR',details:error.details});else res.end();}
 });
 return{server,store,auth,engine,downloads,async close(){closing=true;clearInterval(heartbeat);clearInterval(cleanup);for(const res of clients.keys())res.end();clients.clear();await new Promise(resolveClose=>server.close(resolveClose));await engine.close();await cleaning;await downloads.close();store.close();}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const port=Number(process.env.PLATFORM_PORT||3211);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PLATFORM_PORT 无效');
 const app=await createPlatform();app.server.listen(port,process.env.PLATFORM_HOST||'127.0.0.1',()=>console.log(`ClawBot Platform → http://127.0.0.1:${port}`));
 let closing=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();});
}
