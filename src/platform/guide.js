import {randomBytes} from 'node:crypto';
import {AppError} from './store.js';
import {dueTime,organizerTime} from './organizer.js';
import {normalizeSchedule,nextSchedule} from './schedule-time.js';
import {updateNotifications} from './notification-preferences.js';
const menu='操作向导\n1. 新建待办\n2. 新建轻量提醒\n3. 收藏链接\n4. 通知设置\n发送 /guide 1 选择；每一步按提示回复 /guide 内容。\n/guide cancel 退出；/guide back 返回；普通聊天不受影响。';
const fail=m=>{throw new AppError(400,m);};
const steps={todo:['title','due','priority'],reminder:['title','when'],collection:['url','title','tags'],notify:['quiet','final','digest']};
const prompts={title:'请输入标题或提醒正文（最多 300 字）：/guide 内容',due:'截止时间：/guide 30m 或 /guide 2026-12-01T18:00:00+08:00\n不设截止：/guide none；默认北京时间。',priority:'优先级：/guide 1 高；/guide 2 普通；/guide 3 低',when:'提醒时间：/guide 30m；/guide daily 09:00；或 /guide 含时区ISO时间',url:'请输入链接：/guide https://example.com',tags:'请输入标签，以逗号分隔：/guide 工作,资料；不加标签：/guide none',quiet:'免打扰时段（北京时间）：/guide 23:00 08:00；关闭：/guide off',final:'是否只推最终回复：/guide 1 是；/guide 2 否',digest:'任务摘要合并间隔（分钟，1–1440）：/guide 30；关闭：/guide 0'};
function preview(s,now){
 const d=s.data;let body;
 if(s.flow==='todo')body=`新建待办：${d.title}\n截止：${organizerTime(d.dueAt)}${d.dueAt?'（北京时间）':''}\n优先级：${{high:'高',normal:'普通',low:'低'}[d.priority]}`;
 if(s.flow==='reminder')body=`新建提醒：${d.title}\n下次：${organizerTime(nextSchedule(normalizeSchedule(d.spec,now),now))}（北京时间）\n${d.spec.type==='daily'?'每天重复':'仅一次'}`;
 if(s.flow==='collection')body=`收藏链接：${d.title}\n${d.url}\n标签：${d.tags.join('、')||'无'}`;
 if(s.flow==='notify')body=`通知偏好\n免打扰：${d.quiet?d.quiet.start+'–'+d.quiet.end+'（北京时间）':'关闭'}\n只推最终回复：${d.finalOnly?'是':'否'}\n任务摘要：${d.digestMinutes?d.digestMinutes+' 分钟':'关闭'}`;
 return body+`\n尚未提交。确认：/guide confirm ${s.token}\n修改：/guide back；取消：/guide cancel`;
}
export function guideCommand(engine,id,args,source,requestId,now){
 const db=engine.store.db,load=()=>{const row=db.prepare('SELECT state FROM guide_sessions WHERE assistant_id=? AND source=?').get(id,source);return row?JSON.parse(row.state):null;},clear=()=>db.prepare('DELETE FROM guide_sessions WHERE assistant_id=? AND source=?').run(id,source);
 let s=load();if(s&&s.expires<now){clear();s=null;}
 const save=()=>db.prepare('INSERT INTO guide_sessions VALUES(?,?,?) ON CONFLICT(assistant_id,source) DO UPDATE SET state=excluded.state').run(id,source,JSON.stringify({...s,expires:now+1800000}));
 if(args==='cancel'){clear();return {text:'向导已退出；未提交的设置没有生效。'};}
 if(!args||args==='start'){s={step:-1,data:{}};save();return {text:menu};}
 if(!s)fail('向导未开始或已超过 30 分钟。发送 /guide 重新开始。');
 if(args==='back'){if(s.step<=0){s={step:-1,data:{}};save();return {text:menu};}s.step--;delete s.token;save();return {text:prompts[steps[s.flow][s.step]]};}
 if(s.step===-1){const flow={'1':'todo','2':'reminder','3':'collection','4':'notify'}[args];if(!flow)fail('请选择 /guide 1、2、3 或 4');s={flow,step:0,data:{}};save();return {text:prompts[steps[s.flow][0]]};}
 if(s.step===steps[s.flow].length){
  if(args!==`confirm ${s.token}`)fail(`请使用本次预览的 /guide confirm ${s.token}，或 /guide back 修改。`);
  let result;const d=s.data;
  if(s.flow==='todo'){if(d.dueAt)dueTime(d.dueAt,now);result=engine.organizer.request(id,{kind:'todo',action:'add',requestId,...d},now);}
  if(s.flow==='collection')result=engine.organizer.request(id,{kind:'collection',action:'add',requestId,type:'link',...d},now);
  if(s.flow==='notify')result=updateNotifications(engine.store,id,d);
  if(s.flow==='reminder')result=engine.schedules.request(id,{action:'add',requestId,name:d.title.slice(0,80),prompt:d.title,mode:'reminder',spec:d.spec},now);
  clear();return {text:`已${s.flow==='notify'?'保存通知偏好':'创建'}。${result.item?'\nID：'+result.item.id:result.task?'\nID：'+result.task.id:''}\n${{todo:'/todo 查看待办',reminder:'/tasks 查看提醒',collection:'/collection 查看收藏',notify:'/notify 查看设置'}[s.flow]}`};
 }
 const field=steps[s.flow][s.step],d=s.data;
 if(field==='title'){if(!args.trim()||args.length>300)fail('标题或正文须为 1–300 字');d.title=args;}
 if(field==='due')d.dueAt=dueTime(args,now);
 if(field==='priority'){if(!['1','2','3'].includes(args))fail('优先级请选择 1、2、3');d.priority={1:'high',2:'normal',3:'low'}[args];}
 if(field==='when'){const spec=args.startsWith('daily ')?{type:'daily',time:args.slice(6),timezone:'Asia/Shanghai'}:{type:'once',at:dueTime(args,now)};d.spec=normalizeSchedule(spec,now);}
 if(field==='url'){let u;try{u=new URL(args);}catch{fail('链接格式无效');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password||args.length>2000)fail('请填写不带账号密码的 HTTP/HTTPS 链接');d.url=u.href;}
 if(field==='tags'){const t=args==='none'?[]:args.split(',').map(x=>x.trim()).filter(Boolean);if(t.length>10||t.some(x=>x.length>30))fail('最多 10 个标签，每个最多 30 字');d.tags=t;}
 if(field==='quiet'){if(args==='off')d.quiet=null;else{const m=args.match(/^((?:[01]\d|2[0-3]):[0-5]\d) ((?:[01]\d|2[0-3]):[0-5]\d)$/);if(!m||m[1]===m[2])fail('填写不同的开始和结束时间，如 23:00 08:00');d.quiet={start:m[1],end:m[2]};}}
 if(field==='final'){if(!['1','2'].includes(args))fail('请选择 1 是，或 2 否');d.finalOnly=args==='1';}
 if(field==='digest'){if(!/^\d+$/.test(args)||Number(args)>1440)fail('请输入 0–1440 的分钟数');d.digestMinutes=Number(args);}
 s.step++;if(s.step===steps[s.flow].length)s.token=randomBytes(3).toString('hex');
 const reply=s.token?preview(s,now):prompts[steps[s.flow][s.step]];save();return {text:reply};
}
