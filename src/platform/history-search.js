import {AppError} from './store.js';
export function searchMessages(store,id,{q='',before=Number.MAX_SAFE_INTEGER,limit=10}={}){
 q=typeof q==='string'?q.trim():'';
 if(!q||q.length>100)throw new AppError(400,'搜索关键词须为 1–100 个字符');
 if(!Number.isSafeInteger(before)||before<1||!Number.isInteger(limit)||limit<1||limit>20)throw new AppError(400,'搜索分页参数无效');
 const rows=store.db.prepare("SELECT seq,role,kind,text,created_at FROM messages WHERE assistant_id=? AND seq<? AND kind!='command' AND instr(lower(text),lower(?))>0 ORDER BY seq DESC LIMIT ?").all(id,before,q,limit+1);
 const more=rows.length>limit;rows.length=Math.min(rows.length,limit);
 return {q,results:rows.map(m=>{const at=m.text.toLowerCase().indexOf(q.toLowerCase()),start=Math.max(0,at-60);return {...m,text:undefined,excerpt:(start?'…':'')+m.text.slice(start,start+260)+(m.text.length>start+260?'…':'')};}),nextBefore:more?rows.at(-1).seq:null};
}
export function messageContext(store,id,seq){
 if(!Number.isSafeInteger(seq)||seq<1)throw new AppError(400,'消息编号无效');
 if(!store.db.prepare('SELECT seq FROM messages WHERE assistant_id=? AND seq=?').get(id,seq))throw new AppError(404,'找不到自己的这条消息');
 const before=store.db.prepare('SELECT seq FROM messages WHERE assistant_id=? AND seq<=? ORDER BY seq DESC LIMIT 6').all(id,seq).at(-1).seq;
 return {seq,messages:store.db.prepare('SELECT id FROM messages WHERE assistant_id=? AND seq>=? ORDER BY seq LIMIT 11').all(id,before).map(r=>store.message(r.id))};
}
