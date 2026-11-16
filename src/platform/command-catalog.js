// Shared, public command vocabulary. Contains no account/runtime configuration.
export const COMMANDS=[
 {name:'help',summary:'查看全部命令和用法',usage:'/help [命令名]',example:'/help task'},
 {name:'status',summary:'查看连接、执行、队列和微信额度',usage:'/status',example:'/status'},
 {name:'settings',summary:'查看模型、时区和功能限制',usage:'/settings',example:'/settings'},
 {name:'whoami',summary:'查看自己的账号与助手',usage:'/whoami',example:'/whoami'},
 {name:'tasks',summary:'分页查看自动任务和任务 ID',usage:'/tasks [页码]',example:'/tasks 1'},
 {name:'task',summary:'查看或管理一个任务',usage:'/task <ID> [show|history|pause|resume|cancel|run] [历史游标]',example:'/task 任务ID history'},
 {name:'remind',summary:'直接创建轻量提醒',usage:'/remind <30m|2h|1d> <正文>；或 /remind <daily|workdays> <HH:mm> <正文>；或 /remind every <间隔> <正文>；或 /remind at <含时区ISO时间> <正文>',example:'/remind 30m 该喝水了'},
 {name:'stop',summary:'停止当前执行，取消已排队作业',usage:'/stop',example:'/stop'},
 {name:'search',summary:'搜索自己的历史对话和任务结果',usage:'/search [before:游标] 关键词',example:'/search 项目计划'},
 {name:'message',summary:'查看搜索结果的原始消息',usage:'/message 消息编号',example:'/message 123'},
 {name:'notify',summary:'设置免打扰、最终回复和任务摘要',usage:'/notify；/notify quiet 23:00 08:00|off；/notify final on|off；/notify digest 30|off',example:'/notify quiet 23:00 08:00'},
 {name:'memory',summary:'查看、添加和删除快捷记忆',usage:'/memory [list 页码|show 文件路径|add 内容|delete 记忆ID]',example:'/memory add 回复简短'},
 {name:'templates',summary:'查看可用任务模板',usage:'/templates',example:'/templates'},
 {name:'template',summary:'预览或创建模板任务',usage:'/template 模板ID preview|create HH:mm 主题',example:'/template morning preview 09:00 科技动态'},
];
export const COMMAND_ALIASES={config:'settings',schedule:'tasks','?':'help'};
export function parseCommand(text){
 if(typeof text!=='string')return null;
 const match=text.trim().match(/^\/([a-z][a-z0-9_-]*|\?)(?:\s+([\s\S]*))?$/i);
 if(!match)return null;
 const name=match[1].toLowerCase();return {name:COMMAND_ALIASES[name]||name,args:(match[2]||'').trim(),original:name};
}
