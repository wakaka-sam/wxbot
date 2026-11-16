import {AppError} from './store.js';
import {organizerTime} from './organizer.js';
const invalid=message=>{throw new AppError(400,message);};
const priority={high:'高',normal:'普通',low:'低'};
export const todoView=t=>`${t.status==='done'?'已完成':'待办'}：${t.title}\n优先级：${priority[t.priority]}\n截止：${organizerTime(t.due_at)}${t.due_at?'（北京时间）':''}\nID：${t.id}`;
export const collectionView=t=>`收藏：${t.title}\n${t.status==='read'?'已读':'稍后读'} · ${t.kind==='link'?'链接':t.kind==='file'?'文件':'消息'}\n标签：${t.tags.join('、')||'无'}\nID：${t.id}\n${t.content.slice(0,2000)}${t.content.length>2000?'\n完整内容见网页收藏箱':''}${t.attachments.length?'\n包含附件，请在网页收藏箱下载。':''}`;
export function organizerCommand(engine,id,{name,args},requestId,now){
 const call=r=>engine.organizer.request(id,r,now),words=args.split(/\s+/),action=words[0];
 if(name==='todo'){
  if(!args||['list','today','done-list','all'].includes(action)){
   if(words.length>2||words[1]&&!/^[1-9]\d*$/.test(words[1]))invalid('用法：/todo [list|today|done-list|all] [页码]');
   const filter={list:'open',today:'today','done-list':'done',all:'all'}[action]||'open',r=call({kind:'todo',action:'list',filter,page:Number(words[1]||1)});
   return {text:(filter==='today'?'今日待办（含逾期）':'我的待办')+` · ${r.page}/${r.pages} 页\n`+(r.items.map(todoView).join('\n\n')||'暂无记录。')+`\n/todo add 30m high 提交方案 创建；/todo done ID 完成。${r.page<r.pages?`\n下一页：/todo ${action||'list'} ${r.page+1}`:''}`};
  }
  let r;
  if(action==='add'){const m=args.match(/^add\s+(\S+)\s+(high|normal|low)\s+([\s\S]+)$/);if(!m)invalid('用法：/todo add 30m|含时区ISO时间|none high|normal|low 标题');r=call({kind:'todo',action:'add',requestId,dueAt:m[1],priority:m[2],title:m[3]});}
  else if(['show','done','delete'].includes(action)&&words.length===2)r=call({kind:'todo',action:{show:'get',done:'done',delete:'remove'}[action],id:words[1],...(action==='show'?{}:{requestId})});
  else if(action==='edit'){const m=args.match(/^edit\s+(\S+)\s+(title|due|priority)\s+([\s\S]+)$/);if(!m)invalid('用法：/todo edit ID title|due|priority 新值');r=call({kind:'todo',action:'update',id:m[1],requestId,[{title:'title',due:'dueAt',priority:'priority'}[m[2]]]:m[3]});}
  else invalid('用法：/todo；/todo today；/todo add 30m high 标题；/todo done ID；/todo edit ID due 2h；/todo delete ID');
  return {text:r.removed?'待办已删除，尚未发送的提醒已取消。':todoView(r.item)+(r.item.status==='done'?'\n尚未发送的提醒已取消。':'\n有截止时间的待办到点提醒一次；/todo done ID 标记完成。')};
 }
 if(name==='save'){
  const m=args.match(/^(link|message|file)\s+(\S+)(?:\s+([\s\S]+))?$/);if(!m)invalid('用法：/save link URL [标题]；/save message 消息编号 [标题]；/save file 附件ID [标题]');
  const r=call({kind:'collection',action:'add',requestId,type:m[1],...({link:{url:m[2]},message:{messageSeq:Number(m[2])},file:{attachmentId:m[2]}}[m[1]]),...(m[3]?{title:m[3]}:{})});return {text:'已加入收藏箱。\n'+collectionView(r.item)};
 }
 if(name==='collection'){
  if(!args||['list','unread','read-list'].includes(action)&&(!words[1]||/^\d+$/.test(words[1]))||['search','tag'].includes(action)){
   let r;if(action==='search'||action==='tag'){if(!args.slice(action.length).trim())invalid('请填写关键词或标签');r=call({kind:'collection',action:'list',[action==='search'?'q':'tag']:args.slice(action.length).trim()});}
   else{if(words.length>2)invalid('用法：/collection [list|unread|read-list] [页码]');r=call({kind:'collection',action:'list',filter:action==='unread'?'unread':action==='read-list'?'read':'all',page:Number(words[1]||1)});}
   return {text:`我的收藏 · ${r.page}/${r.pages} 页\n`+(r.items.map(t=>`${t.title} [${t.status==='read'?'已读':'稍后读'}]\n${t.id}\n标签：${t.tags.join('、')||'无'}`).join('\n\n')||'暂无记录。')+'\n/collection show ID 查看；/collection read ID 标为已读；网页可筛选和导出。'+(r.page<r.pages?`\n${['search','tag'].includes(action)?'更多结果请在网页收藏箱翻页。':`下一页：/collection ${action||'list'} ${r.page+1}`}`:'')};
  }
  if(action==='export')return {text:'在网页侧栏打开“收藏箱”，点击“导出 JSON”，即可下载全部收藏、标签和消息正文；附件保留引用，不打包文件内容。'};
  let r;if(['show','read','unread','delete'].includes(action)&&words.length===2)r=call({kind:'collection',action:{show:'get',read:'read',unread:'unread',delete:'remove'}[action],id:words[1],...(action==='show'?{}:{requestId})});
  else if(action==='tags'&&words.length>=2)r=call({kind:'collection',action:'update',requestId,id:words[1],tags:words.slice(2).join(' ').split(',').map(s=>s.trim()).filter(Boolean)});
  else invalid('用法：/collection [list|unread]；/collection show|read|unread|delete ID；/collection tags ID 工作,资料；/collection search 关键词；/collection tag 标签；/collection export');
  return {text:r.removed?'收藏已删除。':collectionView(r.item)};
 }
 return null;
}
