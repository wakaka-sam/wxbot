import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { CodexClient } from '../../codex-client.js';

const INSTRUCTIONS=`你是用户创建的私人助手。网页与微信共用同一会话，直接用中文帮助用户。
每条 agentMessage 都会实时展示给用户，包括简短进度和最终回复。请分成清晰段落，不要重复发送整段最终答案。
用户的新输入会中断当前轮次并在同一会话继续，以最新意图为准，保留此前上下文。
当前执行器用于对话，不执行本机命令，不访问服务器或其他用户的数据。不要声称已执行未执行的操作。`;

// Harness contract: prepare({threadId,onThread}), run({text,onEvent}), interrupt(), close().
// Events only contain public assistant content: delta/message/started. Never reasoning/tool stdout.
export class CodexHarness {
  constructor({dir,model=process.env.PLATFORM_MODEL||'gpt-6-astra',command=process.env.PLATFORM_CODEX_BIN||'/usr/bin/codex',authFile=process.env.PLATFORM_CODEX_AUTH||'/root/.codex/auth.json',isolated=true}){
    Object.assign(this,{dir,model,command,authFile,isolated});this.client=null;this.threadId=null;this.interrupted=false;
  }
  async prepare({threadId,onThread}){
    if(this.client&&!this.client.dead&&this.threadId===threadId)return;
    await this.close();
    const home=join(this.dir,'home'),workspace=join(this.dir,'workspace');
    await mkdir(join(home,'.codex'),{recursive:true,mode:0o700});await mkdir(workspace,{recursive:true,mode:0o700});
    await writeFile(join(home,'.codex','auth.json'),await readFile(this.authFile),{mode:0o600});
    await writeFile(join(home,'.codex','config.toml'),`model = ${JSON.stringify(this.model)}\nmodel_reasoning_effort = "medium"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nproject_doc_max_bytes = 0\n[features]\nshell_tool = false\nunified_exec = false\ncode_mode = false\ncode_mode_host = false\nmulti_agent = false\napps = false\nskill_search = false\nskip_host_skill_discovery = true\n`,{mode:0o600});
    let command=this.command,args=[],cwd=workspace,env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,CODEX_HOME:join(home,'.codex'),LANG:'C.UTF-8'};
    if(this.isolated){
      command=process.env.PLATFORM_BWRAP||'/root/.local/bin/bwrap';
      if(!existsSync(command))throw new Error('平台需要 bubblewrap 隔离执行器；未启动不隔离的替代进程');
      args=['--die-with-parent','--new-session','--unshare-pid','--unshare-ipc','--unshare-uts','--cap-drop','ALL','--ro-bind','/usr','/usr','--ro-bind','/bin','/bin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev','--tmpfs','/tmp'];
      for(const file of ['/etc/ssl','/etc/resolv.conf','/etc/hosts','/etc/nsswitch.conf'])if(existsSync(file))args.push('--ro-bind',file,file);
      if(this.command.startsWith('/root/.local/share/wxbot-platform-tools/'))args.push('--ro-bind','/root/.local/share/wxbot-platform-tools','/root/.local/share/wxbot-platform-tools');
      args.push('--bind',home,'/home/assistant','--bind',workspace,'/workspace','--chdir','/workspace','--setenv','HOME','/home/assistant','--setenv','CODEX_HOME','/home/assistant/.codex',this.command);
      this.cwd='/workspace';
    }else this.cwd=workspace;
    this.client=new CodexClient({command,args,cwd,env});await this.client.initialize();
    const params={cwd:this.cwd,model:this.model,approvalPolicy:'never',sandbox:'read-only',developerInstructions:INSTRUCTIONS};
    const result=threadId?await this.client.request('thread/resume',{...params,threadId,excludeTurns:true}):await this.client.request('thread/start',{...params,ephemeral:false});
    this.threadId=result.thread?.id||threadId;if(!this.threadId)throw new Error('Codex 未返回会话 ID');onThread(this.threadId);
  }
  async run({text,onEvent}){
    this.interrupted=false;
    return this.client.run({threadId:this.threadId,cwd:this.cwd,input:[{type:'text',text,text_elements:[]}],turnOptions:{sandboxPolicy:{type:'readOnly',networkAccess:false}},onEvent:e=>{
      if(e.type==='started'&&this.interrupted)void this.client.interrupt().catch(()=>{});
      if(e.phase==='analysis')return;onEvent(e);
    }});
  }
  async interrupt(){this.interrupted=true;await this.client?.interrupt();}
  async close(){if(this.client){const client=this.client;this.client=null;await client.close();}}
}
