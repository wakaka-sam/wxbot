import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/server.js';
import { Weixin, trustedBase } from '../src/weixin.js';
import { downloadMedia, decodeKey } from '../src/media.js';

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await delay(15); }
  assert.fail('状态未在限定时间内完成');
}
function incoming(id, text) {
  return { message_id: id, from_user_id: 'owner', message_type: 1, message_state: 2,
    item_list: [{ type: 1, text_item: { text } }] };
}
function fakeAPI() {
  const queue = [];
  const sendQueue = [];
  let qrStatus = 'wait';
  const requests = [];
  const api = new Weixin({ fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    const path = url.pathname;
    if (path.endsWith('sendmessage')) {
      const result = sendQueue.shift() ?? { ret: 0 };
      if (result instanceof Error) throw result;
      return Response.json(result);
    }
    if (path.endsWith('get_bot_qrcode')) return Response.json({ qrcode: 'qr-token', qrcode_img_content: 'https://example.test/scan' });
    if (path.endsWith('get_qrcode_status')) return Response.json({ status: qrStatus,
      ...(qrStatus === 'confirmed' ? { bot_token: 'secret-bot-token', ilink_bot_id: 'bot', ilink_user_id: 'owner' } : {}) });
    if (path.endsWith('getupdates')) {
      if (queue.length) {
        const value = queue.shift();
        if (value instanceof Error) throw value;
        return typeof value === 'string' ? new Response(value) : Response.json(value);
      }
      await delay(15, undefined, { signal: options.signal });
      return Response.json({ msgs: [] });
    }
    throw new Error('Unexpected upstream request');
  } });
  return { api, queue, sendQueue, requests, confirm() { qrStatus = 'confirmed'; }, expire() { qrStatus = 'expired'; } };
}
async function sendFromPage(app, text, requestId = randomUUID(), extra = {}) {
  const response = await fetch(`${app.base}/api/send`, { method: 'POST',
    headers: { 'X-Clawbot-Local': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, requestId, ...extra }),
  });
  return { httpStatus: response.status, ...await response.json() };
}
async function start(dir, api) {
  const app = await createApp({ dir, api, bridgeOptions: { pollDelay: 10, retryDelay: 10 } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base,
    state: async () => (await fetch(`${base}/api/state`)).json(),
    post: async path => {
      const r = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'X-Clawbot-Local': '1' } });
      assert.equal(r.status, 200); return r.json();
    },
  };
}

test('扫码→SSE消息→持久化重启；精准去重、过滤回声、断线恢复、清空不重放', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clawbot-test-'));
  const upstream = fakeAPI();
  let app = await start(dir, upstream.api);
  try {
    const qr = await app.post('login');
    assert.equal(qr.phase, 'waiting'); assert.match(qr.qr, /^data:image\/png;base64,/);
    assert.equal(qr.account, null);
    upstream.confirm();
    await until(async () => (await app.state()).phase === 'connected');
    const sseAbort = new AbortController();
    const sse = await fetch(`${app.base}/api/events`, { signal: sseAbort.signal });
    const reader = sse.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
    // Adjacent 64-bit integer IDs must not collapse through JS floating point parsing.
    const msg = incoming('BIG_ID', '第一条\n<script>alert(1)</script>');
    upstream.queue.push(`{"msgs":[${JSON.stringify(msg).replace('"BIG_ID"', '9007199254740992')},${JSON.stringify(msg).replace('"BIG_ID"', '9007199254740993')}],"get_updates_buf":"cursor-1"}`);
    await until(async () => (await app.state()).total === 2);
    let seenEvent = '';
    while (!seenEvent.includes('9007199254740993')) seenEvent += new TextDecoder().decode((await reader.read()).value);
    assert.ok(seenEvent.includes('第一条')); sseAbort.abort();
    assert.equal(app.store.get('cursor:bot'), 'cursor-1');
    upstream.queue.push({ msgs: [incoming('9007199254740992', '重复'),
      { ...incoming('echo', 'BOT ECHO'), message_type: 2 },
      { ...incoming('stranger', '陌生人'), from_user_id: 'other' },
      { ...incoming('partial', '未完成'), message_state: 1 }], get_updates_buf: 'cursor-2' });
    await until(() => app.store.get('cursor:bot') === 'cursor-2');
    assert.equal((await app.state()).total, 2);
    assert.ok(!JSON.stringify(await app.state()).includes('secret-bot-token'));
    upstream.queue.push(new Error('网络暂时不可用'), { msgs: [incoming('3', '重连后的消息')], get_updates_buf: 'cursor-3' });
    await until(async () => (await app.state()).total === 3);
    const request = upstream.requests.find(r => r.url.endsWith('getupdates'));
    assert.equal(request.options.headers.Authorization, 'Bearer secret-bot-token');
    await app.post('pause');
    assert.equal((await app.state()).phase, 'paused');
    await app.close();
    app = await start(dir, upstream.api);
    assert.equal((await app.state()).phase, 'paused');
    assert.equal((await app.state()).total, 3);
    upstream.queue.push({ msgs: [incoming('3', '重放'), incoming('4', '新消息')], get_updates_buf: 'cursor-4' });
    await app.post('resume');
    await until(async () => (await app.state()).total === 4);
    const exported = await (await fetch(`${app.base}/api/export`)).json();
    assert.equal(exported.messages.length, 4);
    await app.post('clear');
    upstream.queue.push({ msgs: [incoming('4', '重放')], get_updates_buf: 'cursor-5' });
    await until(() => app.store.get('cursor:bot') === 'cursor-5');
    assert.equal((await app.state()).total, 0);
    await app.post('logout');
    assert.equal(app.store.get('account'), null);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('二维码过期与凭证失效允许重新扫码', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clawbot-expired-'));
  const upstream = fakeAPI(); const app = await start(dir, upstream.api);
  try {
    upstream.expire(); await app.post('login');
    await until(async () => (await app.state()).phase === 'expired');
    upstream.confirm(); await app.post('login');
    await until(async () => (await app.state()).phase === 'connected');
    upstream.queue.push({ ret: -14 });
    await until(async () => (await app.state()).phase === 'expired');
    assert.equal(app.store.get('account'), null);
    await app.post('login');
    await until(async () => (await app.state()).phase === 'connected');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('新版扫码 POST、IDC 节点跳转与数字配对码完成登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clawbot-pairing-'));
  const requests = [];
  let redirected = false;
  const api = new Weixin({ fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    if (url.pathname.endsWith('get_bot_qrcode')) {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { local_token_list: [] });
      return Response.json({ qrcode: 'pairing-qr', qrcode_img_content: 'https://example.test/qr' });
    }
    if (url.pathname.endsWith('get_qrcode_status')) {
      if (!redirected) { redirected = true; return Response.json({ status: 'scaned_but_redirect', redirect_host: 'sh.ilinkai.weixin.qq.com' }); }
      assert.equal(url.hostname, 'sh.ilinkai.weixin.qq.com');
      if (url.searchParams.get('verify_code') !== '123456') return Response.json({ status: 'need_verifycode' });
      return Response.json({ status: 'confirmed', bot_token: 'pairing-secret', ilink_bot_id: 'bot', ilink_user_id: 'owner' });
    }
    await delay(15, undefined, { signal: options.signal });
    return Response.json({ msgs: [] });
  } });
  const app = await start(dir, api);
  try {
    await app.post('login');
    await until(async () => (await app.state()).phase === 'verifying');
    assert.equal((await fetch(`${app.base}/api/verify`, { method: 'POST', headers: { 'X-Clawbot-Local': '1' }, body: JSON.stringify({ code: 'abc' }) })).status, 400);
    const response = await fetch(`${app.base}/api/verify`, { method: 'POST', headers: { 'X-Clawbot-Local': '1' }, body: JSON.stringify({ code: '123456' }) });
    assert.equal(response.status, 200);
    await until(async () => (await app.state()).phase === 'connected');
    assert.equal(app.store.get('account').baseUrl, 'https://sh.ilinkai.weixin.qq.com');
    assert.ok(requests.some(r => r.url.includes('verify_code=123456')));
    assert.ok(!JSON.stringify(await app.state()).includes('123456'));
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('本机接口拒绝跨站访问、非法 Host 和无操作头的写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clawbot-security-'));
  const app = await start(dir, fakeAPI().api);
  try {
    assert.equal((await fetch(`${app.base}/api/logout`, { method: 'POST' })).status, 403);
    assert.equal((await fetch(`${app.base}/api/state`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    const status = await new Promise((resolve, reject) => {
      http.get(`${app.base}/api/state`, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
    assert.equal((await fetch(`${app.base}/data/clawbot.sqlite`)).status, 404);
    assert.equal((await fetch(`${app.base}/`)).status, 200);
    assert.throws(() => trustedBase('https://evil.example'));
    assert.throws(() => trustedBase('http://ilinkai.weixin.qq.com'));
    assert.throws(() => trustedBase('https://ilinkai.weixin.qq.com.evil.example'));
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('附件解密支持两种密钥格式，失败不会丢失文字', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clawbot-media-'));
  try {
    const key = randomBytes(16);
    const raw = Buffer.from('89504e470d0a1a0a00000000', 'hex');
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
    const encoded = Buffer.from(key.toString('hex')).toString('base64');
    assert.deepEqual(decodeKey(key.toString('base64')), key);
    assert.deepEqual(decodeKey(encoded), key);
    const item = { type: 2, image_item: { media: { encrypt_query_param: 'query', aes_key: encoded } } };
    const result = await downloadMedia(item, dir, new AbortController().signal, async () => new Response(encrypted));
    assert.equal(result.mime, 'image/png');
    assert.deepEqual(await readFile(join(dir, 'media', result.id)), raw);
    const failure = await downloadMedia(item, dir, new AbortController().signal, async () => new Response('', { status: 500 }));
    assert.match(failure.error, /500/);
    const app = await start(dir, fakeAPI().api);
    try {
      app.store.ingest([{ id: 'media', sender: 'owner', text: '包含附件', receivedAt: new Date().toISOString(), attachments: [result] }], 'cursor:test', 'c');
      const response = await fetch(`${app.base}/media/${result.id}`);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), raw);
      await app.post('clear');
      assert.equal((await fetch(`${app.base}/media/${result.id}`)).status, 404);
    } finally { await app.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('网页发送使用绑定账号和最新会话凭证，幂等提交与重启恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clawbot-send-'));
  const upstream = fakeAPI();
  let app = await start(dir, upstream.api);
  const sentRequests = () => upstream.requests.filter(r => r.url.endsWith('sendmessage'));
  try {
    assert.equal((await sendFromPage(app, '尚未登录')).httpStatus, 400);
    upstream.confirm(); await app.post('login');
    await until(async () => (await app.state()).canSend);
    upstream.queue.push({ msgs: [{ ...incoming('ctx', '来自微信'), context_token: 'private-context-1' }], get_updates_buf: 'context-1' });
    await until(async () => (await app.state()).hasReplyContext);
    upstream.queue.push({ msgs: [{ ...incoming('ctx', '来自微信'), context_token: 'private-context-2' }], get_updates_buf: 'context-2' });
    await until(() => app.store.get('cursor:bot') === 'context-2');
    const id = randomUUID(); const text = '你好 👋\n完整保留换行与中文';
    const [first, second] = await Promise.all([
      sendFromPage(app, text, id, { to_user_id: 'spoofed-recipient' }), sendFromPage(app, text, id),
    ]);
    assert.equal(first.delivery.status, 'sent'); assert.equal(second.delivery.status, 'sent');
    assert.equal(sentRequests().length, 1);
    const payload = JSON.parse(sentRequests()[0].options.body);
    assert.deepEqual(payload.msg, { from_user_id: '', to_user_id: 'owner', client_id: `clawbot-local-${id}`,
      message_type: 2, message_state: 2, context_token: 'private-context-2', item_list: [{ type: 1, text_item: { text } }] });
    assert.equal(first.messages.at(-1).direction, 'outbound');
    assert.equal(first.messages.at(-1).status, 'sent');
    assert.ok(!JSON.stringify(first).includes('private-context'));
    assert.equal((await sendFromPage(app, '替换内容', id)).httpStatus, 400);
    assert.equal((await sendFromPage(app, '  \n ')).httpStatus, 400);
    assert.equal((await sendFromPage(app, '字'.repeat(4001))).httpStatus, 400);
    assert.equal(sentRequests().length, 1);
    await app.post('pause'); await app.close(); app = await start(dir, upstream.api);
    assert.equal((await sendFromPage(app, text, id)).delivery.status, 'sent');
    assert.equal(sentRequests().length, 1);
    assert.equal((await app.state()).hasReplyContext, true);
    assert.equal((await sendFromPage(app, '暂停接收时仍可发送')).delivery.status, 'sent');
    assert.equal(sentRequests().length, 2);
    await app.post('clear');
    assert.equal((await sendFromPage(app, text, id)).delivery.status, 'sent');
    assert.equal(sentRequests().length, 2);
    assert.equal((await app.state()).total, 0);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('发送失败与结果不明不会自动重试；中断发送在重启后标记待确认', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clawbot-send-errors-'));
  const upstream = fakeAPI(); let app = await start(dir, upstream.api);
  try {
    upstream.confirm(); await app.post('login');
    await until(async () => (await app.state()).canSend);
    const failedId = randomUUID();
    upstream.sendQueue.push({ ret: -1 });
    const failed = await sendFromPage(app, '微信拒绝', failedId);
    assert.equal(failed.delivery.status, 'failed');
    assert.match(failed.delivery.error, /再发一条/);
    const unknownId = randomUUID();
    upstream.sendQueue.push(new TypeError('fetch failed'));
    assert.equal((await sendFromPage(app, '网络中断', unknownId)).delivery.status, 'unknown');
    assert.equal((await sendFromPage(app, '网络中断', unknownId)).delivery.status, 'unknown');
    assert.equal(upstream.requests.filter(r => r.url.endsWith('sendmessage')).length, 2);
    // The latest protocol permits a send without context; do not invent one.
    assert.equal(JSON.parse(upstream.requests.find(r => r.url.endsWith('sendmessage')).options.body).msg.context_token, undefined);
    await app.post('pause');
    const interruptedId = randomUUID(); const interruptedText = '模拟发送时进程中断';
    app.store.beginSend({ id: `out:bot:${interruptedId}`, text: interruptedText, direction: 'outbound', status: 'sending',
      sender: '本机', receivedAt: new Date().toISOString(), attachments: [], quotes: [] }, createHash('sha256').update(interruptedText).digest('hex'));
    await app.close(); app = await start(dir, upstream.api);
    const recovered = await sendFromPage(app, interruptedText, interruptedId);
    assert.equal(recovered.delivery.status, 'unknown');
    assert.equal(recovered.messages.at(-1).status, 'unknown');
    assert.equal(upstream.requests.filter(r => r.url.endsWith('sendmessage')).length, 2);
    upstream.sendQueue.push({ ret: -14 });
    assert.equal((await sendFromPage(app, '凭证过期')).delivery.status, 'failed');
    assert.equal((await app.state()).canSend, false);
    assert.equal(app.store.get('account'), null);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
