import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createDecipheriv, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Weixin } from '../src/weixin.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { describeMedia, decodeKey, prepareReply, MAX_MEDIA_SIZE } from '../src/media.js';

const account = { id: 'bot', userId: 'owner', token: 'PRIVATE', baseUrl: 'https://ilinkai.weixin.qq.com' };
const png = Buffer.from('89504e470d0a1a0a0000000049454e44ae426082', 'hex');
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
async function until(fn) { for (let i = 0; i < 100; i++) { if (fn()) return; await delay(10); } assert.fail('timeout'); }
function fake() {
  const calls = [], items = [], typing = [];
  let uploadError = false, sendError = false, configError = false, fullUrl = null;
  const api = new Weixin({ fetchImpl: async (url, options) => {
    const body = options.headers['Content-Type'] === 'application/json' ? JSON.parse(options.body) : options.body;
    calls.push({ url, options, body });
    if (url.pathname.endsWith('/getuploadurl')) {
      if (uploadError) throw new Error('upload unavailable');
      return Response.json(fullUrl ? { upload_full_url: fullUrl } : { upload_param: 'upload-param' });
    }
    if (url.pathname.endsWith('/upload')) return new Response('', { headers: { 'x-encrypted-param': 'download-param' } });
    if (url.pathname.endsWith('/sendmessage')) {
      items.push(body.msg.item_list[0]);
      if (sendError) throw new Error('timeout after submit');
      return Response.json({ ret: 0 });
    }
    if (url.pathname.endsWith('/getconfig')) {
      if (configError) throw new Error('typing unavailable');
      return Response.json({ typing_ticket: 'PRIVATE-TICKET' });
    }
    if (url.pathname.endsWith('/sendtyping')) { typing.push(body.status); return new Response(''); }
    throw new Error('unexpected endpoint');
  } });
  return { api, calls, items, typing, failUpload() { uploadError = true; }, failSend() { sendError = true; },
    failConfig() { configError = true; }, setUrl(url) { fullUrl = url; } };
}
async function setup(clientFactory) {
  const root = await mkdtemp(join(tmpdir(), 'clawbot-media-')), dir = join(root, 'data');
  const store = new Store(dir); store.set('account', account); store.set('paused', true); store.set('context:bot:owner', 'CTX'); store.close();
  const h = fake(), app = await createApp({ dir, api: h.api, codexOptions: clientFactory ? { cwd: root, clientFactory } : false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const send = async (bytes, name, kind = 'auto', id = randomUUID(), extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/send-media`, { method: 'POST',
      headers: { 'X-Clawbot-Local': '1', 'X-File-Name': encodeURIComponent(name), 'X-File-Kind': kind, 'X-Request-Id': id, ...extra }, body: bytes });
    return { status: response.status, data: await response.json() };
  };
  return { root, dir, app, h, send, async close() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('图片/文件/视频从 HTTP 上传，加密字节、MD5、大小、消息类型及重试去重正确', async () => {
  const t = await setup();
  try {
    for (const [bytes, name, type, mediaType] of [[png, '图片.png', 2, 1], [Buffer.from('中文文件'), '报告.txt', 4, 3], [mp4, '视频.mp4', 5, 2]]) {
      const id = randomUUID(), before = t.h.items.length;
      const response = await t.send(bytes, name, 'auto', id);
      assert.equal(response.data.delivery.status, 'sent');
      assert.equal(t.h.items.at(-1).type, type);
      const req = t.h.calls.findLast(c => c.url.pathname.endsWith('/getuploadurl')).body;
      const upload = t.h.calls.findLast(c => c.url.pathname.endsWith('/upload'));
      assert.equal(req.media_type, mediaType); assert.equal(req.rawsize, bytes.length);
      assert.equal(req.rawfilemd5, createHash('md5').update(bytes).digest('hex'));
      assert.equal(req.filesize, upload.body.length); assert.equal(upload.options.headers.Authorization, undefined);
      const item = t.h.items.at(-1), value = item.image_item || item.video_item || item.file_item;
      const decipher = createDecipheriv('aes-128-ecb', decodeKey(value.media.aes_key), null);
      assert.deepEqual(Buffer.concat([decipher.update(upload.body), decipher.final()]), bytes);
      const msg = t.h.calls.findLast(c => c.url.pathname.endsWith('/sendmessage')).body.msg;
      assert.equal(msg.context_token, 'CTX'); assert.equal(msg.to_user_id, 'owner');
      assert.equal((await t.send(bytes, name, 'auto', id)).data.delivery.status, 'sent');
      assert.equal(t.h.items.length, before + 1);
      assert.equal((await t.send(Buffer.from('changed'), name, 'file', id)).status, 400);
      const attachment = t.app.store.messages().at(-1).attachments[0];
      assert.deepEqual(await readFile(join(t.dir, 'media', attachment.id)), bytes);
    }
    assert.ok(!JSON.stringify(t.app.bridge.snapshot()).includes('PRIVATE'));
    assert.equal((await t.send(png, 'a.png', 'auto', randomUUID(), { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await t.send(png, 'a.png', 'auto', randomUUID(), { 'X-Account-Id': 'changed' })).status, 400);
    assert.equal((await t.send(Buffer.alloc(0), 'empty')).status, 400);
    assert.equal((await t.send(Buffer.from('not an image'), 'a.png', 'image')).status, 400);
    assert.throws(() => describeMedia(Buffer.alloc(MAX_MEDIA_SIZE + 1), 'too-big'), /20 MB/);
  } finally { await t.close(); }
});

test('上传失败未发消息，提交后超时标为 unknown 且不重复发送；CDN 拒绝不可信 URL', async () => {
  const t = await setup();
  try {
    t.h.setUrl('http://127.0.0.1/private');
    assert.equal((await t.send(png, 'a.png')).data.delivery.status, 'failed');
    assert.equal(t.h.items.length, 0);
    t.h.setUrl('https://novac2c.cdn.weixin.qq.com/c2c/upload?opaque=1');
    t.h.failSend(); const id = randomUUID();
    assert.equal((await t.send(png, 'a.png', 'auto', id)).data.delivery.status, 'unknown');
    assert.equal((await t.send(png, 'a.png', 'auto', id)).data.delivery.status, 'unknown');
    assert.equal(t.h.items.length, 1);
    t.h.failUpload();
    assert.equal((await t.send(png, 'a.png')).data.delivery.status, 'failed');
    assert.equal(t.h.items.length, 1);
  } finally { await t.close(); }
});

test('输入状态续期、停止、失败降级以及账号变更不会串号', async () => {
  const t = await setup();
  try {
    const states = []; t.app.bridge.typingInterval = 10;
    const stop = t.app.bridge.startTyping({ accountId: 'bot', userId: 'owner' }, s => states.push(s));
    await until(() => t.h.typing.length >= 2); await stop();
    assert.equal(t.h.typing.at(-1), 2); const count = t.h.typing.length;
    await delay(40); assert.equal(t.h.typing.length, count); assert.equal(states.at(-1).typing, false);
    const second = t.app.bridge.startTyping({ accountId: 'bot', userId: 'owner' });
    await until(() => t.h.typing.length > count);
    t.app.store.set('account', { ...account, userId: 'different' });
    const changed = t.h.typing.length; await second(); await delay(30);
    assert.equal(t.h.typing.length, changed);
    t.app.store.set('account', account); t.h.failConfig();
    const failed = t.app.bridge.startTyping({ accountId: 'bot', userId: 'owner' }, s => states.push(s));
    await until(() => states.at(-1).typingError); await failed();
    assert.ok(states.some(s => s.typingError));
  } finally { await t.close(); }
});

test('Codex 附件显式提取、持久化副本、目录越界及内部凭证保护', async () => {
  const t = await setup();
  try {
    await writeFile(join(t.root, 'report.txt'), '产物');
    await symlink(join(t.dir, 'clawbot.sqlite'), join(t.root, 'secret-link'));
    const prepared = await prepareReply(`完成\n[[clawbot-send:${t.root}/report.txt]]\n[[clawbot-send:${t.root}/secret-link]]\n[[clawbot-send:/etc/hosts]]`, t.root, t.dir);
    assert.equal(prepared.replyAttachments.length, 1);
    assert.equal(prepared.replyAttachments[0].name, 'report.txt');
    assert.match(prepared.reply, /secret-link 未发送/); assert.match(prepared.reply, /hosts 未发送/);
    assert.ok(!prepared.reply.includes('[[clawbot-send:'));
    await writeFile(join(t.root, 'report.txt'), '修改后');
    assert.equal(await readFile(join(t.dir, 'media', prepared.replyAttachments[0].id), 'utf8'), '产物');
    assert.equal((await prepareReply(`[普通链接](${t.root}/report.txt)`, t.root, t.dir)).replyAttachments.length, 0);
  } finally { await t.close(); }
});


test('Codex 运行触发 typing，最终附件实际回传、恢复不重复发送，停止和异常取消 typing', async () => {
  let release, reject, output, mode = 'hold';
  const t = await setup(() => ({
    dead: false, async initialize() {},
    async request() { return { thread: { id: 'persistent-thread' } }; },
    async run() {
      if (mode === 'error') throw new Error('模拟执行失败');
      await new Promise((resolve, fail) => { release = resolve; reject = fail; });
      return { text: output, turnId: 'turn' };
    },
    async close() { this.dead = true; reject?.(new Error('cancelled')); },
  }));
  const enqueue = id => {
    t.app.store.addCodexJob({ id, scope: 'bot:owner', accountId: 'bot', userId: 'owner', status: 'queued', text: '交付文件' });
    t.app.codex.wake();
  };
  try {
    await writeFile(join(t.root, 'answer.txt'), 'Codex 生成的文件');
    output = `已完成\n[[clawbot-send:${t.root}/answer.txt]]`;
    enqueue('with-file'); await until(() => release && t.h.typing.includes(1));
    release(); await until(() => !t.app.codex.draining);
    assert.equal(t.h.typing.at(-1), 2);
    assert.deepEqual(t.h.items.map(i => i.type), [1, 4]);
    assert.equal(t.app.store.codexJob('with-file').deliveryError, null);
    await t.app.codex.deliver(t.app.store.codexJob('with-file'));
    assert.equal(t.h.items.length, 2);
    const before = t.h.typing.length; release = null;
    enqueue('stop'); await until(() => release && t.h.typing.length > before);
    await t.app.codex.stop(); assert.equal(t.h.typing.at(-1), 2);
    assert.equal(t.app.store.codexJob('stop').outcome, 'interrupted');
    mode = 'error'; enqueue('fail'); await until(() => !t.app.codex.draining);
    assert.equal(t.app.store.codexJob('fail').outcome, 'failed');
    assert.equal(t.h.typing.at(-1), 2);
  } finally { await t.close(); }
});
