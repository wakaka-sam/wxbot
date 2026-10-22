import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

async function until(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(10); }
  assert.fail('Codex state did not settle');
}
function harness() {
  const queue = [], sent = [], calls = [], runs = [], holds = [];
  let threadCounter = 0, failSend = false;
  const api = {
    async updates(account, cursor, signal) {
      if (queue.length) return { msgs: queue.shift(), get_updates_buf: `cursor-${Date.now()}` };
      await delay(15, undefined, { signal }); return { msgs: [] };
    },
    async sendText(account, text, clientId) {
      sent.push({ account, text, clientId });
      if (failSend) { const error = new Error('微信暂时拒绝'); error.code = -1; throw error; }
      return { ret: 0 };
    },
  };
  function clientFactory() {
    const client = {
      dead: false, pending: null,
      async initialize() { calls.push(['initialize']); },
      async request(method, params) {
        calls.push([method, params]);
        if (method === 'thread/start') return { thread: { id: `thread-${++threadCounter}` } };
        if (method === 'thread/resume' && params.threadId === 'bad-thread') throw new Error('thread not found');
        return { thread: { id: params.threadId } };
      },
      async run(options) {
        runs.push(options); options.onProgress({ activity: '模拟处理中', draft: '过程说明' });
        const text = options.input.find(i => i.type === 'text').text;
        if (text.includes('HOLD')) {
          await new Promise((resolve, reject) => { client.pending = { resolve, reject }; holds.push(client.pending); });
        }
        return { text: text.includes('LONG') ? '长'.repeat(3500) : `回复：${text}`, turnId: `turn-${runs.length}` };
      },
      async close() { client.dead = true; client.pending?.reject(new Error('已中断')); client.pending = null; },
    };
    return client;
  }
  const msg = (id, text, extra = {}) => ({ message_id: id, message_type: 1, message_state: 2,
    from_user_id: 'owner', context_token: 'private-context', item_list: [{ type: 1, text_item: { text } }], ...extra });
  return { api, queue, sent, calls, runs, holds, clientFactory, msg, failSends() { failSend = true; } };
}
async function setup(h, dir) {
  const app = await createApp({ dir, api: h.api, bridgeOptions: { pollDelay: 5, retryDelay: 5 },
    codexOptions: { cwd: dir, clientFactory: h.clientFactory } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  app.base = `http://127.0.0.1:${app.server.address().port}`;
  app.post = async (path, body) => {
    const result = await fetch(`${app.base}/api/${path}`, { method: 'POST', headers: { 'X-Clawbot-Local': '1' }, body: body ? JSON.stringify(body) : undefined });
    return { status: result.status, body: await result.json() };
  };
  return app;
}
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'clawbot-codex-'));
  const store = new Store(dir);
  store.set('account', { id: 'bot', userId: 'owner', token: 'private-token', baseUrl: 'https://ilinkai.weixin.qq.com' });
  store.close(); return dir;
}

test('微信新消息原子入队、串行多轮、自动回复、去重与重启恢复同一 thread', async () => {
  const dir = await directory(), h = harness(); let app = await setup(h, dir);
  try {
    h.queue.push([h.msg('1', 'HOLD 第一轮'), h.msg('2', '第二轮')]);
    await until(() => h.holds.length === 1);
    assert.equal(h.runs.length, 1);
    assert.equal(app.codex.snapshot().queued, 1);
    h.holds[0].resolve();
    await until(() => h.sent.length === 2 && !app.codex.draining);
    assert.equal(h.runs[0].threadId, h.runs[1].threadId);
    assert.match(h.sent[0].text, /第一轮/); assert.match(h.sent[1].text, /第二轮/);
    assert.ok(h.sent.every(m => m.account.userId === 'owner'));
    assert.ok(!JSON.stringify(app.bridge.snapshot()).includes('private-context'));
    assert.equal(app.store.messages().filter(m => m.source === 'codex').length, 2);
    const tid = app.codex.snapshot().threadId;
    await app.close(); app = await setup(h, dir);
    h.queue.push([h.msg('2', '重复第二轮'), h.msg('3', '第三轮')]);
    await until(() => h.sent.length === 3 && !app.codex.draining);
    assert.equal(h.runs.length, 3); assert.equal(h.runs[2].threadId, tid);
    assert.ok(h.calls.some(([method, params]) => method === 'thread/resume' && params.threadId === tid));
    assert.ok(h.calls.filter(([method]) => method === 'thread/start').every(([,p]) => p.sandbox === 'workspace-write' && p.approvalPolicy === 'never'));
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('/status 不阻塞、/new 停止旧任务并取消旧队列，后续消息创建新会话', async () => {
  const dir = await directory(), h = harness(); const app = await setup(h, dir);
  try {
    h.queue.push([h.msg('1', 'HOLD 旧任务'), h.msg('2', '不应执行')]);
    await until(() => h.holds.length === 1);
    h.queue.push([h.msg('3', '/status')]);
    await until(() => h.sent.some(s => s.text.includes('正在处理')));
    assert.equal(h.runs.length, 1);
    h.queue.push([h.msg('4', '/new'), h.msg('5', '新任务')]);
    await until(() => h.sent.some(s => s.text.includes('回复：新任务')) && !app.codex.draining);
    assert.equal(h.runs.length, 2);
    assert.notEqual(h.runs[0].threadId, h.runs[1].threadId);
    assert.equal(app.store.codexJob('bot:owner:2').status, 'cancelled');
    h.queue.push([h.msg('6', 'HOLD 再次执行'), h.msg('7', '也不应执行')]);
    await until(() => h.holds.length === 2);
    h.queue.push([h.msg('8', '/stop')]);
    await until(() => !app.codex.active && app.store.codexJob('bot:owner:8')?.status === 'completed');
    assert.equal(app.store.codexJob('bot:owner:7').status, 'cancelled');
    assert.equal(h.runs.length, 3);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('暂停自动回复只展示新消息；长回复分段，回传失败保留结果且不重跑任务', async () => {
  const dir = await directory(), h = harness(); const app = await setup(h, dir);
  try {
    assert.equal((await app.post('codex/config', { enabled: false, cwd: dir, model: '' })).status, 200);
    h.queue.push([h.msg('1', '只展示')]);
    await until(() => app.store.count() === 1);
    assert.equal(h.runs.length, 0); assert.equal(app.store.codexJobs('bot:owner').length, 0);
    await app.post('codex/config', { enabled: true, cwd: dir, model: '' });
    h.queue.push([h.msg('2', 'LONG')]);
    await until(() => h.sent.length === 3 && !app.codex.draining);
    assert.equal(h.sent.map(s => s.text.replace(/^\[\d+\/\d+\] /, '')).join(''), '长'.repeat(3500));
    assert.equal(h.runs.length, 1);
    h.failSends(); h.queue.push([h.msg('3', '回复失败')]);
    await until(() => Boolean(app.store.codexJob('bot:owner:3')?.deliveryError));
    assert.match(app.store.codexJob('bot:owner:3').reply, /回复失败/);
    app.codex.wake(); await delay(50);
    assert.equal(h.runs.length, 2);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('附件作为 Codex 输入，恢复失败不会静默新建会话，错误账号不会收到回复', async () => {
  const dir = await directory(), h = harness(); const app = await setup(h, dir);
  try {
    app.store.addCodexJob({ id: 'image-job', scope:'bot:owner', accountId:'bot',userId:'owner',status:'queued',text:'分析图片',
      attachments:[{id:'12345678-1234-1234-1234-123456789012',mime:'image/png',name:'图片'}] });
    app.codex.wake(); await until(() => h.sent.length === 1 && !app.codex.draining);
    assert.equal(h.runs[0].input[1].type, 'localImage');
    assert.ok(h.runs[0].input[1].path.startsWith(dir));
    app.store.set('codex-session:bot:owner', {threadId:'bad-thread',cwd:dir});
    h.queue.push([h.msg('2', '继续会话')]);
    await until(() => h.sent.length === 2 && !app.codex.draining);
    assert.match(h.sent[1].text, /恢复 Codex 会话失败/);
    assert.equal(h.runs.length, 1);
    assert.equal(app.codex.snapshot().threadId, 'bad-thread');
    const before = h.sent.length;
    await app.codex.deliver({id:'wrong',scope:'other:other',accountId:'other',userId:'other',reply:'不得串号'});
    assert.equal(h.sent.length, before);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('已执行但未回传的结果重启后仅回传；中断任务不自动重复执行', async () => {
  const dir = await directory(), h = harness();
  const store = new Store(dir);
  store.addCodexJob({ id:'saved-result',scope:'bot:owner',accountId:'bot',userId:'owner',status:'replying',outcome:'completed',reply:'已保存的结果',text:'旧任务' });
  store.addCodexJob({ id:'crashed',scope:'bot:owner',accountId:'bot',userId:'owner',status:'running',text:'崩溃任务' });
  store.close();
  const app = await setup(h, dir);
  try {
    await until(() => h.sent.length === 2 && !app.codex.draining);
    assert.equal(h.runs.length, 0);
    assert.equal(h.sent[0].text, '已保存的结果');
    assert.match(h.sent[1].text, /中断/);
    assert.equal(app.store.codexJob('crashed').status, 'interrupted');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
