import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

async function until(fn) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await fn()) return; await delay(10); }
  assert.fail('多用户状态未及时完成');
}
function fixture() {
  const queues = new Map(), sent = [], calls = [], holds = [];
  let nextBot = 'a', slowQr = null, thread = 0;
  const account = bot => ({ id: bot, userId: `owner-${bot}`, token: `secret-${bot}`, baseUrl: 'https://ilinkai.weixin.qq.com' });
  const api = {
    baseUrl: 'https://ilinkai.weixin.qq.com',
    async qr() {
      const bot = nextBot;
      if (slowQr) await slowQr;
      return { qrcode: bot, qrcode_img_content: `https://example.test/${bot}` };
    },
    async status(base, qr) { const a = account(qr); return { status: 'confirmed', bot_token: a.token, ilink_bot_id: a.id, ilink_user_id: a.userId }; },
    async updates(a, cursor, signal) {
      const queue = queues.get(a.id) || [];
      if (queue.length) return { msgs: [queue.shift()], get_updates_buf: `${a.id}-cursor` };
      await delay(10, undefined, { signal }); return { msgs: [] };
    },
    async sendText(a, text) { sent.push({ bot: a.id, text }); return {}; },
  };
  const clientFactory = () => {
    let rejectHold;
    return {
      async initialize() {},
      async request(method, params) {
        const id = params.threadId || `thread-${++thread}`;
        calls.push({ method, ...params, id }); return { thread: { id } };
      },
      async run({ input, threadId }) {
        const text = input[0].text;
        if (text.includes('HOLD')) await new Promise((resolve, reject) => { holds.push(resolve); rejectHold = reject; });
        return { text: `${threadId}: ${text}`, turnId: 'turn' };
      },
      async close() { rejectHold?.(new Error('stopped')); },
    };
  };
  return { api, account, sent, calls, holds, clientFactory,
    bot(id) { nextBot = id; }, slow(promise) { slowQr = promise; },
    enqueue(bot, id, text) {
      if (!queues.has(bot)) queues.set(bot, []);
      queues.get(bot).push({ message_id: id, from_user_id: `owner-${bot}`, message_type: 1, message_state: 2,
        item_list: [{ type: 1, text_item: { text } }] });
    },
  };
}
async function start(dir, h) {
  const app = await createApp({ dir, api: h.api, bridgeOptions: { pollDelay: 5, retryDelay: 5 },
    codexOptions: { clientFactory: h.clientFactory, cwd: dir } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  app.url = (path, id = 'default') => `http://127.0.0.1:${app.server.address().port}${path}?profile=${encodeURIComponent(id)}`;
  app.post = async (path, id = 'default', body) => {
    const r = await fetch(app.url(path, id), { method: 'POST', headers: { 'X-Clawbot-Local': '1' }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  app.state = async (id = 'default') => (await fetch(app.url('/api/state', id))).json();
  return app;
}
async function add(app, name) {
  const { status, data } = await app.post('/api/profiles', 'default', { name });
  assert.equal(status, 201); return data.profile.id;
}
async function login(app, h, profile, bot) {
  h.bot(bot); assert.equal((await app.post('/api/login', profile)).status, 200);
  await until(async () => (await app.state(profile)).phase === 'connected');
}

test('多个微信用户独立扫码、并行执行、回复不串号，历史和会话在重启后保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-profiles-')), h = fixture();
  // Seed an existing installation to exercise the no-copy upgrade path.
  const legacy = new Store(dir);
  legacy.set('account', h.account('a'));
  legacy.set('codex-session:a:owner-a', { threadId: 'legacy-thread', cwd: dir });
  legacy.ingest([{ id: 'old', text: 'legacy', receivedAt: new Date().toISOString(), attachments: [] }], 'cursor:a', 'old-cursor');
  legacy.close();
  let app = await start(dir, h);
  try {
    assert.equal((await app.state()).total, 1);
    const b = await add(app, '用户乙');
    assert.equal((await app.state(b)).total, 0);
    await login(app, h, b, 'b');
    const stream = await fetch(app.url('/api/events', b));
    const reader = stream.body.getReader();
    const event = new TextDecoder().decode((await reader.read()).value);
    assert.ok(!event.includes('legacy-thread')); assert.ok(!event.includes('secret-'));
    await reader.cancel();
    h.enqueue('a', 'same-id', 'HOLD 甲');
    await until(() => h.holds.length === 1);
    h.enqueue('b', 'same-id', '乙的消息');
    await until(() => h.sent.some(s => s.bot === 'b' && s.text.includes('乙的消息')));
    assert.equal(h.sent.some(s => s.bot === 'a'), false);
    assert.equal((await app.state(b)).messages.some(m => m.text.includes('HOLD')), false);
    h.holds[0]();
    await until(() => h.sent.some(s => s.bot === 'a' && s.text.includes('HOLD')));
    const aState = await app.state(), bState = await app.state(b);
    assert.equal(aState.codex.threadId, 'legacy-thread');
    assert.notEqual(aState.codex.threadId, bState.codex.threadId);
    assert.notEqual(aState.codex.cwd, bState.codex.cwd);
    const aCall = h.calls.find(c => c.method === 'thread/resume');
    const bCall = h.calls.find(c => c.method === 'thread/start');
    assert.notEqual(aCall.cwd, bCall.cwd);
    assert.equal((await app.post('/api/send', b, { text: 'wrong target', requestId: randomUUID(), accountId: 'a' })).status, 400);
    await app.post('/api/profile', b, { name: '乙的新名称' });
    await app.close(); app = await start(dir, h);
    const restored = await app.state(b);
    assert.equal(restored.profile.name, '乙的新名称');
    assert.equal(restored.account.id, 'b'); assert.equal(restored.codex.threadId, bState.codex.threadId);
    assert.equal(restored.total, bState.total);
    h.enqueue('b', 'second', '续聊');
    await until(() => h.sent.some(s => s.bot === 'b' && s.text.includes('续聊')));
    assert.equal((await app.state(b)).codex.threadId, bState.codex.threadId);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('导出、附件、清空、暂停和退出仅作用于选中用户', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-profiles-')), h = fixture(), app = await start(dir, h);
  try {
    const b = await add(app, '乙');
    await login(app, h, 'default', 'a'); await login(app, h, b, 'b');
    await app.post('/api/codex/config', 'default', { enabled: false });
    await app.post('/api/codex/config', b, { enabled: false });
    h.enqueue('a', '1', '甲的消息'); h.enqueue('b', '1', '乙的消息');
    await until(async () => (await app.state()).total === 1 && (await app.state(b)).total === 1);
    const p = app.profiles.items.get(b), id = randomUUID();
    await mkdir(join(p.dir, 'media'), { recursive: true });
    await writeFile(join(p.dir, 'media', id), 'private-b');
    p.store.ingest([{ id: 'attachment', text: '', receivedAt: new Date().toISOString(),
      attachments: [{ id, name: 'b.txt', mime: 'text/plain', size: 9 }] }], 'media', '');
    assert.equal((await fetch(app.url(`/media/${id}`))).status, 404);
    assert.equal(await (await fetch(app.url(`/media/${id}`, b))).text(), 'private-b');
    const exported = await (await fetch(app.url('/api/export', b))).json();
    assert.ok(!JSON.stringify(exported).includes('甲的消息'));
    await app.post('/api/clear');
    assert.equal((await app.state()).total, 0); assert.equal((await app.state(b)).total, 2);
    assert.equal((await fetch(app.url(`/media/${id}`, b))).status, 200);
    await app.post('/api/pause');
    assert.equal((await app.state()).phase, 'paused'); assert.equal((await app.state(b)).phase, 'connected');
    await app.post('/api/logout');
    assert.equal((await app.state()).account, null); assert.equal((await app.state(b)).account.id, 'b');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('重复绑定与换号被拒绝，非法用户不能回落到默认账号，用户管理保留跨站保护', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-profiles-')), h = fixture(), app = await start(dir, h);
  try {
    const b = await add(app, '乙'); await login(app, h, 'default', 'a');
    h.bot('a'); await app.post('/api/login', b);
    await until(async () => (await app.state(b)).phase === 'error');
    assert.equal((await app.state(b)).account, null);
    assert.match((await app.state(b)).detail, /已在/);
    assert.equal((await app.state()).phase, 'connected');
    await app.post('/api/logout'); h.bot('b'); await app.post('/api/login');
    await until(async () => (await app.state()).phase === 'error');
    assert.match((await app.state()).detail, /新增用户/);
    assert.equal((await app.state()).account, null);
    await login(app, h, 'default', 'a');
    for (const id of ['missing', '../../default', '']) assert.equal((await fetch(app.url('/api/state', id))).status, 404);
    assert.equal((await app.post('/api/profiles', 'default', { name: ' ' })).status, 400);
    const response = await fetch(app.url('/api/profiles'), { method: 'POST', headers: { 'X-Clawbot-Local': '1', Origin: 'https://evil.example' }, body: '{"name":"bad"}' });
    assert.equal(response.status, 403);
    assert.equal(app.profiles.items.size, 2);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('一个用户获取二维码缓慢时不阻塞另一用户的操作', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-profiles-')), h = fixture(), app = await start(dir, h);
  let release;
  try {
    const b = await add(app, '乙');
    h.slow(new Promise(resolve => { release = resolve; }));
    const pending = app.post('/api/login', b);
    await until(async () => (await app.state(b)).phase === 'loading');
    const response = await fetch(app.url('/api/codex/config'), { method: 'POST', signal: AbortSignal.timeout(1000),
      headers: { 'X-Clawbot-Local': '1' }, body: '{"enabled":false}' });
    assert.equal(response.status, 200);
    release(); await pending;
  } finally { release?.(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
