import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// Codex CLI's stdio app-server protocol; no shell/TUI keystrokes are involved.
export class CodexClient extends EventEmitter {
  constructor({ command = process.env.CLAWBOT_CODEX_BIN || 'codex', cwd, args = [], requestTimeout = 30000,
    turnTimeout = 15 * 60 * 1000, env = process.env } = {}) {
    super();
    Object.assign(this, { requestTimeout, turnTimeout });
    this.pending = new Map(); this.nextId = 1; this.active = null; this.dead = false;
    this.child = spawn(command, [...args, 'app-server', '--listen', 'stdio://'], {
      cwd, env: { ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try { this.handle(JSON.parse(line)); } catch { /* Ignore non-protocol stdout. */ }
    });
    // Drain stderr without forwarding credentials or unrelated local configuration to the webpage.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(new Error(`Codex 通信失败：${error.code || '管道已关闭'}`)));
    this.child.on('error', error => this.fail(new Error(error.code === 'ENOENT'
      ? '未找到 Codex CLI，请安装并执行 codex login，或配置 CLAWBOT_CODEX_BIN' : `Codex 启动失败：${error.code || error.message}`)));
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.once('exit', (code, signal) => this.fail(new Error(`Codex 进程已退出（${signal || code}）`)));
  }
  write(payload) {
    if (this.dead) throw new Error('Codex 进程未连接');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }
  request(method, params) {
    if (this.dead) return Promise.reject(new Error('Codex 进程未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(`Codex ${method} 响应超时`));
      }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'clawbot-local', title: 'ClawBot Local', version: '1.0.0' },
      capabilities: { experimentalApi: false } });
    this.write({ method: 'initialized' });
  }
  handle(message) {
    if (message.id != null && message.method) {
      const method = message.method;
      let result;
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) result = { decision: 'decline' };
      else if (['execCommandApproval', 'applyPatchApproval'].includes(method)) result = { decision: 'denied' };
      else if (method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
      else if (method === 'item/tool/requestUserInput') result = { answers: {} };
      else if (method === 'mcpServer/elicitation/request') result = { action: 'cancel', content: null };
      else if (method === 'item/tool/call') result = { contentItems: [], success: false };
      if (result) this.write({ id: message.id, result });
      else this.write({ id: message.id, error: { code: -32601, message: 'This bridge does not support this interactive request' } });
      this.active?.onProgress?.({ activity: 'Codex 请求了额外交互；请在后续消息补充信息。权限申请未自动放行。' });
      return;
    }
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'Codex 请求失败'));
      else pending.resolve(message.result || {});
      return;
    }
    const active = this.active, p = message.params || {};
    if (!active || p.threadId !== active.threadId || (active.turnId && p.turnId && active.turnId !== p.turnId)) return;
    if (message.method === 'turn/started') { active.turnId = p.turn?.id || p.turnId; active.onEvent?.({ type: 'started', turnId: active.turnId }); }
    if (message.method === 'item/agentMessage/delta') {
      const item = active.items.get(p.itemId) || { text: '' };
      item.text += p.delta || ''; active.items.set(p.itemId, item);
      active.onEvent?.({ type: 'delta', itemId: p.itemId, delta: p.delta || '', phase: item.phase });
      active.onProgress?.({ draft: item.text.slice(-20000), activity: 'Codex 正在回复…', turnId: active.turnId });
    }
    if (message.method === 'item/started') {
      if (p.item?.type === 'agentMessage') active.items.set(p.item.id, { text: p.item.text || '', phase: p.item.phase });
      if (p.item?.type === 'commandExecution') active.onProgress?.({ activity: `执行命令：${p.item.command || ''}`.slice(0, 1000) });
      if (p.item?.type === 'fileChange') active.onProgress?.({ activity: '正在修改工作目录中的文件…' });
      const activity={commandExecution:'正在执行命令…',fileChange:'正在修改工作文件…',webSearch:'正在查询网页…',subAgentActivity:'正在与子代理协作…',mcpToolCall:'正在调用工具…'}[p.item?.type];
      if(activity)active.onEvent?.({type:'activity',itemId:p.item.id,text:activity});
    }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') {
      active.items.set(p.item.id, { text: p.item.text || '', phase: p.item.phase });
      active.onEvent?.({ type: 'message', itemId: p.item.id, text: p.item.text || '', phase: p.item.phase });
    }
    if (message.method === 'turn/completed') {
      if (active.turnId && p.turn?.id && p.turn.id !== active.turnId) return;
      const items = [...active.items.values()];
      const finals = items.filter(i => i.phase === 'final_answer');
      const text = (finals.length ? finals.map(i => i.text).join('\n\n') : items.at(-1)?.text || '').trim();
      if (p.turn?.status !== 'completed') active.reject(Object.assign(new Error(p.turn?.status === 'interrupted' ? 'Codex 本轮已停止' : p.turn?.error?.message || 'Codex 本轮执行失败'), { code: p.turn?.status }));
      else active.resolve({ text, turnId: p.turn.id });
    }
  }
  async run({ threadId, input, cwd, onProgress, onEvent, turnOptions = {} }) {
    if (this.active) throw new Error('当前 Codex 轮次尚未结束');
    let timer;
    const done = new Promise((resolve, reject) => {
      this.active = { threadId, items: new Map(), onProgress, onEvent, resolve, reject };
      timer = setTimeout(() => reject(new Error('Codex 本轮执行超时，请检查任务后重试')), this.turnTimeout);
    });
    // Attach rejection handling before awaiting turn/start, since completion can race the RPC reply.
    done.catch(() => {});
    try {
      const result = await this.request('turn/start', { ...turnOptions, threadId, cwd, input, approvalPolicy: 'never' });
      this.active.turnId ||= result.turn?.id;
      onEvent?.({ type: 'started', turnId: this.active.turnId });
      onProgress?.({ turnId: this.active.turnId, activity: 'Codex 正在处理…' });
      return await done;
    } finally { clearTimeout(timer); this.active = null; }
  }
  async interrupt() {
    if (this.active?.turnId && !this.dead) await this.request('turn/interrupt', { threadId: this.active.threadId, turnId: this.active.turnId });
  }
  fail(error) {
    this.dead = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.active?.reject(error);
  }
  async close() {
    if (this.active?.turnId && !this.dead) {
      // Send interruption before closing the transport so Codex can persist the interrupted turn.
      try { this.write({ id: this.nextId++, method: 'turn/interrupt', params: { threadId: this.active.threadId, turnId: this.active.turnId } }); } catch {}
    }
    this.fail(new Error('Codex 执行已停止'));
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    try { await this.exited; } finally { clearTimeout(timer); this.lines.close(); }
  }
}
