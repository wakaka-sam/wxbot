import { randomUUID,createHash } from 'node:crypto';
import { AppError } from './store.js';
import { COMMANDS,COMMAND_ALIASES,parseCommand } from './command-catalog.js';
import { RUNTIME_LIMITS } from './runtime-limits.js';
import {searchMessages,messageContext} from './history-search.js';
import {notificationPreferences,updateNotifications} from './notification-preferences.js';
import {TASK_TEMPLATES,templateDraft} from './task-templates.js';
import {normalizeSchedule,nextSchedule} from './schedule-time.js';
import { MAX_MEDIA_SIZE } from '../media.js';
export {parseCommand};
const states={active:'启用',paused:'暂停',queued:'等待执行',completed:'结束',cancelled:'取消',pending:'排队',running:'执行中',done:'完成',failed:'失败',interrupted:'中断'};
const deliveryStates={pending:'待发送',sending:'发送中',sent:'微信已接收',failed:'发送失败',unknown:'结果未确认',skipped:'已跳过'};
const time=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'short',hour12:false}).format(new Date(value)):'无';
const short=(text,max=80)=>{text=String(text).replace(/[\x00-\x1f\x7f]/g,' ');return text.length>max?text.slice(0,max)+'…':text;};
const invalid=message=>{throw new AppError(400,message);};
function help(name=''){
 name=name.replace(/^\//,'').toLowerCase();name=COMMAND_ALIASES[name]||name;
 if(name){const c=COMMANDS.find(c=>c.name===name);if(!c)invalid('没有这个命令。发送 /help 查看全部命令。');return `${c.summary}\n用法：${c.usage}\n示例：${c.example}`+(name==='task'?'\nID 支持至少 8 位的唯一前缀，先用 /tasks 查询。run 会真实执行并发送结果，不改变原计划；cancel 取消整个规则，pause 暂停后可恢复。history 返回最近 3 次执行，带游标可翻页。':name==='stop'?'\n保留会话和文件；周期规则仍启用，暂停周期请用 /task ID pause。已经产生的外部操作不会撤销。':name==='remind'?'\n默认北京时间。m=分钟，h=小时，d=天。workdays 仅周一至周五，不判断法定节假日。正文原样发送，不调用模型。':name==='settings'?'\n参数只读，不能通过命令更改部署模型或资源限制。':'');}
 return '快捷命令\n'+COMMANDS.map(c=>`/${c.name} — ${c.summary}`).join('\n')+'\n\n/help 命令名 查看示例；例如 /help remind。\n命令请单独发送，不携带附件。查询不会打断当前回复。\n如需把 / 开头的内容当普通聊天，使用双斜杠，例如 //status。';
}
function resolveTask(engine,id,ref){
 if(!/^[a-f0-9-]{8,36}$/i.test(ref||''))invalid('任务 ID 无效；请先 /tasks，复制完整 ID 或至少 8 位唯一前缀。');
 const rows=engine.store.db.prepare('SELECT * FROM schedules WHERE assistant_id=? AND id LIKE ? LIMIT 2').all(id,ref.toLowerCase()+'%');
 if(!rows.length)throw new AppError(404,'找不到自己的这个任务，请用 /tasks 查看。');
 if(rows.length>1)invalid('任务 ID 前缀不唯一，请使用完整 ID。');return rows[0];
}
function rule(spec){
 if(spec.type==='once')return `${time(spec.at)}（北京时间）`;
 if(spec.type==='interval')return `每 ${spec.minutes} 分钟`+(spec.until?`，截止 ${time(spec.until)}（北京时间）`:'');
 return `${spec.type==='weekly'?'每周'+'日一二三四五六'[spec.weekday]:spec.type==='workdays'?'周一至周五':spec.type==='monthly'?`每月 ${spec.day} 号`:'每天'} ${spec.time}（${spec.timezone}）`+(spec.until?`，截止 ${time(spec.until)}（北京时间）`:'');
}
function taskView(task){return `任务：${short(task.name)}\nID：${task.id}\n状态：${states[task.status]||task.status} · ${task.mode==='reminder'?'轻量提醒':'智能任务'}\n规则：${rule(JSON.parse(task.spec))}\n下次：${time(task.next_run_at)}（北京时间）\n内容：${short(task.prompt,600)}`;}
function duration(value){const m=value.match(/^(\d+)(m|h|d|分钟|小时|天)$/i);if(!m)invalid('时间请使用 30m、2h、1d 等格式。');const minutes=Number(m[1])*({m:1,h:60,d:1440,'分钟':1,'小时':60,'天':1440}[m[2].toLowerCase()]);if(!Number.isSafeInteger(minutes)||minutes<1||minutes>525600)invalid('提醒时间范围为 1 分钟到 1 年。');return minutes;}
function perform(engine,id,command,requestId,now){
 const {name,args}=command,words=args?args.split(/\s+/):[];
 const a=engine.store.assistant(id),runtime=engine.runtimes.get(id),connection=runtime?.channel.snapshot();
 if(name==='help')return {text:help(args)};
 if(name==='search'){
  const m=args.match(/^(?:before:(\d+)\s+)?([\s\S]+)$/);if(!m)invalid('用法：/search 关键词');
  const h=searchMessages(engine.store,id,{q:m[2],before:m[1]?Number(m[1]):Number.MAX_SAFE_INTEGER,limit:5});
  return {text:h.results.length?h.results.map(r=>`${time(r.created_at)} · ${r.role==='user'?'你':'助手/系统'} · #${r.seq}\n${r.excerpt}\n原文：/message ${r.seq}`).join('\n\n')+(h.nextBefore?`\n下一页：/search before:${h.nextBefore} ${h.q}`:''):'未找到匹配消息。搜索普通对话和任务结果，不包含快捷命令回执。'};
 }
 if(name==='message'){
  const h=messageContext(engine.store,id,Number(args)),m=h.messages.find(m=>m.seq===h.seq);
  return {text:`#${m.seq} · ${time(m.created_at)}\n${m.text.slice(0,4000)}${m.text.length>4000?'\n内容较长，请在网页历史搜索查看全文。':''}${m.attachments?.length?'\n附件请在网页原消息中查看。':''}`};
 }
 if(name==='notify'){
  let patch;
  if(args){
   if(args==='quiet off')patch={quiet:null};
   else if(/^quiet ([01]\d|2[0-3]):[0-5]\d ([01]\d|2[0-3]):[0-5]\d$/.test(args))patch={quiet:{start:words[1],end:words[2]}};
   else if(/^final (on|off)$/.test(args))patch={finalOnly:words[1]==='on'};
   else if(/^digest (off|[0-9]+)$/.test(args))patch={digestMinutes:words[1]==='off'?0:Number(words[1])};
   else invalid('用法：/notify；/notify quiet 23:00 08:00；/notify quiet off；/notify final on|off；/notify digest 30|off');
  }
  const p=patch?updateNotifications(engine.store,id,patch):notificationPreferences(engine.store,id);
  return {text:`通知偏好${patch?'已保存':''}\n免打扰：${p.quiet?p.quiet.start+'–'+p.quiet.end+'（北京时间）':'关闭'}\n只推最终回复：${p.finalOnly?'开启':'关闭'}\n任务文字摘要：${p.digestMinutes?p.digestMinutes+' 分钟合并一次':'关闭'}\n免打扰仅延后自动回复和任务通知，网页照常显示；命令回执与主动发送不受影响。附件不合并，轻量提醒也受免打扰和摘要设置影响。`};
 }
 if(name==='templates'){
  if(args)invalid('用法：/templates');
  return {text:'任务模板\n'+TASK_TEMPLATES.map(t=>`${t.id} — ${t.name}\n/template ${t.id} preview ${t.time} ${t.topic}`).join('\n\n')+'\n先 preview 预览，改为 create 才会创建。网页“自动任务”也可选择模板。'};
 }
 if(name==='template'){
  const m=args.match(/^(\w+)\s+(preview|create)\s+(\S+)\s+([\s\S]+)$/);if(!m)invalid('用法：/template morning preview 09:00 科技动态；把 preview 改为 create 创建');
  let draft,spec;try{draft=templateDraft(m[1],m[4],m[3]);spec=normalizeSchedule(draft.spec,now);}catch(e){invalid(e.message);}
  const next=nextSchedule(spec,now);
  if(m[2]==='preview')return {text:`模板：${draft.name}\n规则：${rule(spec)}\n下次：${time(next)}（北京时间）\n内容：${draft.prompt}\n尚未创建。创建：/template ${m[1]} create ${m[3]} ${m[4]}`};
  const task=engine.schedules.request(id,{action:'add',requestId,...draft,spec},now).task;
  return {text:`已创建：${task.name}\nID：${task.id}\n下次：${time(task.next_run_at)}（北京时间）\n/task ${task.id} 查看或管理。`};
 }

 if(['status','settings','whoami','stop'].includes(name)&&args)invalid(help(name));
 if(name==='whoami')return {text:`账号：${engine.store.user(a.user_id).username}\n助手：${a.name}\n角色：${engine.store.user(a.user_id).role==='admin'?'管理员':'普通用户'}\n仅操作当前账号自己的任务、会话和文件。`};
 if(name==='settings')return {text:`当前参数（只读）\n模型：${runtime?.harness.model||process.env.PLATFORM_MODEL||'gpt-6-astra'}\n默认时区：Asia/Shanghai（北京时间）\n自动任务：最多 20 个未结束，间隔最短 1 分钟\n附件：每条最多 10 个，网页总量 ${MAX_MEDIA_SIZE/1024/1024} MB\n智能执行：单轮最多 ${RUNTIME_LIMITS.turnTimeout/60000} 分钟，无活动 ${RUNTIME_LIMITS.stallTimeout/60000} 分钟停止\n工具错误：连续 ${RUNTIME_LIMITS.maxToolFailures} 次失败或任务工具同错 ${RUNTIME_LIMITS.sameScheduleErrors} 次停止\n微信：每次新微信输入后最多 ${connection?.replyBudget?.limit||10} 条回复，网页输入不刷新额度\n轻量提醒到点不调用模型；/status 查看实时状态。`};
 if(name==='status'){
  const counts=engine.store.db.prepare('SELECT state,COUNT(*) n FROM outbox WHERE assistant_id=? GROUP BY state').all(id),count=state=>counts.find(r=>r.state===state)?.n||0;
  const budget=connection?.replyBudget,active=runtime?.active;
  return {text:`助手：${a.name}\n微信：${engine.connected(id)?'已连接':'未连接'}${connection?.waitingForFirstMessage?'，等待第一条微信消息':''}\n执行：${active?active.interrupted?'正在停止':active.scheduled?'自动任务执行中':'正在回复':'空闲'}\n等待作业：${engine.store.pending(id).length}\n微信投递：待发送 ${count('pending')}，发送中 ${count('sending')}；历史失败 ${count('failed')}，结果未确认 ${count('unknown')}\n微信剩余额度：${budget?`${budget.remaining}/${budget.limit}（本条回复发送前）`:'暂无'}\n当前时间：${time(now)}（北京时间）\n额度不足时在微信再发一条消息；/tasks 查看任务，/stop 停止执行。`};
 }
 if(name==='tasks'){
  if(words.length>1||args&&!/^[1-9]\d*$/.test(args))invalid('用法：/tasks [页码]，例如 /tasks 2');const page=args?Number(args):1;if(!Number.isSafeInteger(page))invalid('页码无效');
  const total=engine.store.db.prepare('SELECT COUNT(*) n FROM schedules WHERE assistant_id=?').get(id).n,pages=Math.max(1,Math.ceil(total/5));if(page>pages)invalid(`仅有 ${pages} 页，请用 /tasks ${pages}`);
  const tasks=engine.store.db.prepare("SELECT * FROM schedules WHERE assistant_id=? ORDER BY CASE WHEN status IN ('active','paused','queued') THEN 0 ELSE 1 END,created_at DESC,id LIMIT 5 OFFSET ?").all(id,(page-1)*5);
  return {text:tasks.length?`我的自动任务 · 第 ${page}/${pages} 页\n`+tasks.map(t=>`${short(t.name,40)} [${states[t.status]||t.status}]\n${t.id}\n下次 ${time(t.next_run_at)}（北京时间）`).join('\n\n')+`\n\n/task ID 查看详情；/help task 查看管理命令。${page<pages?`下一页 /tasks ${page+1}`:''}`:'还没有自动任务。\n试试 /remind 30m 该喝水了，或 /help remind。'};
 }
 if(name==='task'){
  const [ref,action='show',cursor]=words;if(words.length>3||!['show','history','pause','resume','cancel','run'].includes(action)||(cursor&&action!=='history'))invalid(help('task'));
  const task=resolveTask(engine,id,ref);
  if(action==='show')return {text:taskView(task)};
  if(action==='history'){
   if(cursor&&!/^[1-9]\d*$/.test(cursor))invalid('历史游标无效，请使用上次返回的下一页命令。');
   const h=engine.schedules.history(id,task.id,{limit:3,...(cursor?{before:Number(cursor)}:{})});
   return {text:h.runs.length?`${short(task.name)} · 执行记录\n`+h.runs.map(r=>`${time(r.created_at)} ${r.manual?'试运行':'计划'}：${states[r.state]||r.state}\n微信：${r.deliveries.length?r.deliveries.map(d=>deliveryStates[d.state]||d.state).join('、'):'尚无投递记录'}${r.error?'\n原因：'+short(r.error,160):''}${r.messages.length?'\n结果：'+short(r.messages.at(-1).text,200):''}`).join('\n\n')+(h.nextBefore?`\n下一页：/task ${task.id} history ${h.nextBefore}`:'')+'\n完整内容请看网页任务执行记录。':`${short(task.name)}：还没有执行记录。`};
  }
  const result=engine.schedules.request(id,{action:action==='cancel'?'remove':action,id:task.id,...(action==='run'?{requestId}:{})},now);
  return {text:action==='run'?`已加入真实执行队列：${short(task.name)}\n原计划不变，结果会发送至微信并保存在网页。\n/task ${task.id} history 查看结果。`:`任务「${short(task.name)}」已${{pause:'暂停',resume:'恢复',cancel:'取消'}[action]}。\nID：${task.id}\n${action==='resume'?`下次：${time(result.task.next_run_at)}（北京时间）`:'已经运行的任务允许完成；/stop 可请求停止当前执行。'}`,event:result.message,wake:Boolean(result.jobId)};
 }
 if(name==='remind'){
  const match=args.match(/^(daily|workdays|every|at)\s+(\S+)\s+([\s\S]+)$|^(\S+)\s+([\s\S]+)$/i);if(!match)invalid(help('remind'));
  const type=match[1]?.toLowerCase(),value=match[2]||match[4],prompt=(match[3]||match[5]).trim();let spec;
  if(type==='daily'||type==='workdays')spec={type,time:value,timezone:'Asia/Shanghai'};
  else if(type==='every')spec={type:'interval',minutes:duration(value)};
  else spec={type:'once',at:type==='at'?value:new Date(now+duration(value)*60000).toISOString()};
  const task=engine.schedules.request(id,{action:'add',requestId,name:short(prompt,40),prompt,mode:'reminder',spec},now).task;
  return {text:`已创建轻量提醒：${short(task.name)}\nID：${task.id}\n下次：${time(task.next_run_at)}（北京时间）\n内容：${short(task.prompt,600)}\n/task ${task.id} 查看或管理。微信离线或额度不足时会等待。`};
 }
 if(name==='stop'){
  const count=engine.store.pending(id).length;engine.store.cancelPending(id);engine.schedules.settle();
  return {text:`${runtime?.active?'已请求停止当前执行':'当前没有正在执行的任务'}，已取消 ${count} 个排队作业。\n会话和文件保留，周期规则仍按计划运行；暂停规则请用 /task ID pause。`,stop:runtime?.active||null};
 }
 invalid(`未知命令 /${command.original}。发送 /help 查看支持的命令；如果这是普通文本，请改用 /${'/'+command.original}${args?' '+short(args,80):''}。`);
}
// Input, command mutation, receipt and optional WeChat outbox commit together.
// Savepoints in store.tx let schedule operations participate in this transaction.
export function submitCommand(engine,id,text,source,key,command,attachments=[],preparedOutcome=null){
 const store=engine.store,sourceKey=`${source}:${key}`,requestId=createHash('sha256').update(`${id}:${sourceKey}`).digest('hex');
 const result=store.tx(()=>{
  const prior=store.db.prepare('SELECT id FROM messages WHERE assistant_id=? AND source_key=?').get(id,sourceKey);
  if(prior){const receipt=store.db.prepare('SELECT id FROM messages WHERE assistant_id=? AND source_key=?').get(id,'command-reply:'+sourceKey);return {message:store.message(prior.id),...(receipt?{reply:store.message(receipt.id)}:{}),duplicate:true};}
  const message=store.addMessage(id,{id:randomUUID(),role:'user',kind:'command',text,source,sourceKey,attachments});
  if(source==='web')engine.uploads?.claim(id,attachments);
  let outcome;
  try{if(attachments.length)invalid('快捷命令请单独发送，不要携带附件。附件已保留在本条消息；如要分析附件，请用普通文字重新发送。');outcome=preparedOutcome||perform(engine,id,command,requestId,Date.now());}
  catch(error){if(!(error instanceof AppError))throw error;outcome={text:`命令未执行：${error.message}`,error:true};}
  // WeChat folds soft line breaks; separate command rows as paragraphs.
  const reply=store.addMessage(id,{role:'system',kind:'command',source:'command',sourceKey:'command-reply:'+sourceKey,text:outcome.text.replace(/\n+/g,'\n\n'),state:outcome.error?'error':'complete'});
  if(source==='wechat')for(const d of engine.textDeliveries(id,reply.text,`command:${reply.id}`))store.queueDelivery(d.id,id,d.payload);
  store.audit(store.assistant(id).user_id,'command-'+command.name,message.id);
  return {message,reply,duplicate:false,...outcome};
 });
 if(result.duplicate)return result;
 engine.publish(id,'message',result.message);engine.publish(id,'message',result.reply);if(result.event)engine.publish(id,'message',result.event);
 const runtime=engine.runtimes.get(id),run=result.stop;
 if(run&&runtime?.active===run){run.interrupted=true;run.superseded=false;run.inputAbort.abort();void runtime.harness.interrupt().catch(()=>{if(runtime.active===run)return runtime.harness.close();}).catch(error=>engine.publish(id,'error',{message:`停止执行失败：${error.message}`}));}
 engine.publish(id,'assistant',engine.snapshot(id));if(result.wake)engine.wake(id);engine.deliver(id);
 return {message:result.message,reply:result.reply,duplicate:false,command:true};
}
