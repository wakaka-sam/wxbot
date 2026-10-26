import { EventEmitter } from 'node:events';
import { Store } from '../../store.js';
import { Bridge } from '../../bridge.js';
import { Weixin } from '../../weixin.js';
import { normalizeAttachments, readChannelAttachment } from '../attachments.js';

const inputMessage=m=>({id:m.id,text:m.text||((m.attachments||[]).length?'':'[空消息]'),attachments:normalizeAttachments(m.attachments)});

// Channel contract: start/stop/login/verify/disconnect/send/snapshot/history/close.
// Events: input {id,text}, paired, state. No harness or platform users here.
export class WechatChannel extends EventEmitter {
  constructor({dir,validateBinding,api=new Weixin(),bridgeOptions={}}){
    super();this.dir=dir;this.store=new Store(dir);this.bridge=new Bridge(this.store,api,dir,{...bridgeOptions,replyLimit:10,validateAccount:validateBinding});
    this.bridge.on('change',()=>this.emit('state',this.snapshot()));
    this.bridge.on('paired',()=>this.emit('paired'));
    this.bridge.on('messages',messages=>{for(const m of messages)this.emit('input',inputMessage(m));});
  }
  snapshot(){const s=this.bridge.state,a=this.store.get('account');
    const budget=a?this.store.replyBudget(a,10):null;
    const replyBudget=budget?{epoch:budget.epoch,used:budget.used,remaining:budget.remaining,limit:budget.limit}:null;
    return {phase:s.phase,detail:replyBudget?.remaining===0?'已达微信连续回复上限，请在微信里再发一条消息以接收后续回复':s.detail,qr:s.qr,account:a?{id:a.id,userId:a.userId}:null,replyBudget};}
  history(){return this.store.messages(-1).filter(m=>m.direction!=='outbound').map(inputMessage);}
  async readAttachment(attachment){return readChannelAttachment(this.dir,attachment.id);}
  async start(){this.store.set('paused',false);await this.bridge.init();}
  async stop(){this.bridge.pause();await this.bridge.close();}
  async login(){await this.bridge.login();}
  async verify(code){this.bridge.verify(code);}
  async disconnect(){this.bridge.logout();await this.bridge.close();}
  async send(text,id,binding){return this.bridge.send(text,id,binding);}
  async close(){await this.bridge.close();this.store.close();}
}
