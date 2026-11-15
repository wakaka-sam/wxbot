// All stored instants are UTC milliseconds. Calendar rules retain their IANA
// zone so changing the server's timezone cannot move a user's tasks.
const MINUTE=60000,DAY=86400000;
const formatters=new Map();
function formatter(zone){
 if(!formatters.has(zone)){
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  if(formatters.size>=100)formatters.clear();formatters.set(zone,f);
 }
 return formatters.get(zone);
}
function parts(at,zone){return Object.fromEntries(formatter(zone).formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));}
function wall(p){return Date.UTC(p.year,p.month-1,p.day,p.hour||0,p.minute||0);}
function exactKeys(value,keys){if(Object.keys(value).some(k=>!keys.includes(k)))throw new Error('时间规则包含不支持的字段');}
export function normalizeSchedule(value,now=Date.now()){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('缺少时间规则');
 if(value.type==='once'){
  exactKeys(value,['type','at']);
  if(typeof value.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.at))throw new Error('一次性时间须为包含时区的 ISO 时间');
  const calendar=value.at.slice(0,10),day=Date.parse(calendar+'T00:00:00Z');
  if(!Number.isFinite(day)||new Date(day).toISOString().slice(0,10)!==calendar)throw new Error('日期无效');
  const at=Date.parse(value.at);
  if(!Number.isFinite(at)||at<=now||at>now+366*DAY)throw new Error('一次性时间须在未来一年内');
  return {type:'once',at:new Date(at).toISOString()};
 }
 if(value.type==='interval'){
  exactKeys(value,['type','minutes']);
  if(!Number.isInteger(value.minutes)||value.minutes<1||value.minutes>525600)throw new Error('执行间隔须为 1–525600 整数分钟');
  return {type:'interval',minutes:value.minutes};
 }
 if(!['daily','weekly'].includes(value.type))throw new Error('支持 once、interval、daily、weekly 时间规则');
 exactKeys(value,value.type==='weekly'?['type','time','timezone','weekday']:['type','time','timezone']);
 if(typeof value.time!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time))throw new Error('时间须为 HH:mm（24 小时制）');
 const timezone=value.timezone??'Asia/Shanghai';
 if(typeof timezone!=='string'||timezone.length>80)throw new Error('时区无效');
 try{formatter(timezone);}catch{throw new Error('请使用有效 IANA 时区，例如 Asia/Shanghai');}
 const spec={type:value.type,time:value.time,timezone};
 if(value.type==='weekly'){
  if(!Number.isInteger(value.weekday)||value.weekday<0||value.weekday>6)throw new Error('星期须为 0–6（0 为周日）');
  spec.weekday=value.weekday;
 }
 return spec;
}
export function nextSchedule(spec,after,anchor=after){
 if(spec.type==='once')return Date.parse(spec.at);
 if(spec.type==='interval'){
  const step=spec.minutes*MINUTE;
  return anchor+(Math.max(0,Math.floor((after-anchor)/step))+1)*step;
 }
 const local=parts(after,spec.timezone),day=Date.UTC(local.year,local.month-1,local.day),[hour,minute]=spec.time.split(':').map(Number);
 for(let i=0;i<(spec.type==='weekly'?16:9);i++){
  const date=new Date(day+i*DAY);
  if(spec.type==='weekly'&&date.getUTCDay()!==spec.weekday)continue;
  const target=day+i*DAY+hour*3600000+minute*MINUTE;
  // Sample both sides of DST. Missing wall times are skipped; ambiguous wall
  // times fire only at the first occurrence, never twice on a fall-back day.
  const offsets=new Set([-36,0,36].map(h=>{const t=target+h*3600000;return wall(parts(t,spec.timezone))-t;}));
  const candidates=[...offsets].map(offset=>target-offset).filter(t=>wall(parts(t,spec.timezone))===target).sort((a,b)=>a-b);
  if(candidates.length&&candidates[0]>after)return candidates[0];
 }
 throw new Error('无法计算下次执行时间');
}
