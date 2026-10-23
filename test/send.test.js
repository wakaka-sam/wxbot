import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sendText, parseArgs } from '../src/send-client.js';
import { createSendRelay } from '../src/send-relay.js';
import { installSendTools } from '../src/send-tools.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function command(args, input = '', env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, WXBOT_RELAY_DIR: '', WXBOT_PROFILE: '', WXBOT_SERVER: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
async function until(fn) { for (let i = 0; i < 100; i++) { if (await fn()) return; await delay(20); } assert.fail('timeout'); }

test('wxbot send 实际子进程经本机服务发送：多行、profile、幂等、未知连接与结果不明', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-send-')), sent = [];
  const seed = new Store(dir);
  seed.set('account', { id: 'bot', userId: 'owner', token: 'DO-NOT-EXPOSE' }); seed.set('paused', true); seed.close();
  let unknown = false;
  const app = await createApp({ dir, api: { async sendText(a, text) { sent.push({ bot: a.id, text }); if (unknown) throw new Error('socket lost'); } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const server = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const requestId = randomUUID(), args = ['send', '--server', server, '--request-id', requestId];
    const first = await command(args, '你好\n第二行');
    assert.equal(first.code, 0, first.stderr); assert.equal(JSON.parse(first.stdout).status, 'sent');
    assert(!first.stdout.includes('DO-NOT-EXPOSE'));
    assert.equal((await command(args, '你好\n第二行')).code, 0); assert.equal(sent.length, 1);
    assert.notEqual((await command(args, '改写内容')).code, 0); assert.equal(sent.length, 1);
    assert.notEqual((await command(['send', '--server', server, '--profile', randomUUID(), '不能串号'])).code, 0);
    const p = await app.profiles.create('second'); p.store.set('account', { id: 'other', userId: 'other-owner' }); p.bridge.state.phase = 'paused';
    assert.equal((await command(['send', '--server', server, '--profile', p.id, '另一个账号'])).code, 0);
    assert.equal(sent.at(-1).bot, 'other');
    unknown = true;
    const result = await command(['send', '--server', server, '--request-id', randomUUID(), '连接断开']);
    assert.equal(result.code, 2); assert.equal(JSON.parse(result.stdout).status, 'unknown');
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('CLI 参数与目标限制：拒绝未知参数、远端地址、账号变更，正文文件保留换行', async () => {
  assert.throws(() => parseArgs(['send', '--file', 'secret']), /未知参数/);
  const denied = await sendText({ server: 'https://example.com', text: '不要泄漏' }, { fetchImpl: () => assert.fail('must not fetch') });
  assert.equal(denied.status, 'failed');
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-relay-')), sent = [];
  const relay = await createSendRelay(dir, async r => { sent.push(r); return { status: 'sent' }; });
  try {
    const file = join(dir, 'message.txt'); await writeFile(file, '文件正文\n第二行');
    const result = await command(['send', '--relay-dir', dir, '--turn', relay.turn, '--content-file', file]);
    assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(sent[0].text, '文件正文\n第二行');
    assert.notEqual((await command(['send', '--relay-dir', dir, '--turn', relay.turn, '--profile', 'other', '越界'])).code, 0);
  } finally { await relay.close(); await rm(dir, { recursive: true, force: true }); }
});

test('代发按轮次绑定、拒绝伪造目标及符号链接，重复请求仅发送一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-relay-')), sent = [];
  const relay = await createSendRelay(dir, async r => { sent.push(r); return { status: 'sent', id: r.requestId }; });
  const options = { relayDir: dir, turn: relay.turn, text: '一次', requestId: randomUUID() };
  try {
    const results = await Promise.all([sendText(options), sendText(options)]);
    assert(results.every(r => r.status === 'sent')); assert.equal(sent.length, 1);
    assert.equal((await sendText(options)).status, 'sent'); assert.equal(sent.length, 1);
    assert.notEqual((await sendText({ ...options, text: '改写' })).status, 'sent');
    const bad = randomUUID();
    await writeFile(join(relay.dir, `${bad}.${bad}.req.json`), JSON.stringify({ requestId: bad, turn: relay.turn, text: 'bad', profile: 'victim' }));
    await until(async () => { try { return JSON.parse(await readFile(join(relay.dir, `${bad}.${bad}.res.json`))).delivery.status === 'failed'; } catch { return false; } });
    const link = randomUUID(), outside = join(dir, 'outside');
    await writeFile(outside, JSON.stringify({ requestId: link, turn: relay.turn, text: 'secret' }));
    await symlink(outside, join(relay.dir, `${link}.${link}.req.json`));
    await until(async () => { try { return JSON.parse(await readFile(join(relay.dir, `${link}.${link}.res.json`))).delivery.status === 'failed'; } catch { return false; } });
    assert.equal(sent.length, 1);
    await relay.close();
    assert.equal((await sendText({ ...options, requestId: randomUUID() })).status, 'failed');
    assert.equal(sent.length, 1);
  } finally { await relay.close(); await rm(dir, { recursive: true, force: true }); }
});

test('安装助手专属 wxbot 命令与 skill，无需修改全局 Codex 配置', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wxbot-tools-'));
  try {
    const tools = await installSendTools(home);
    assert.match(await readFile(join(tools.bin, 'wxbot'), 'utf8'), /WXBOT_RELAY_DIR/);
    assert.match(await readFile(join(home, '.agents/skills/wxbot-send/SKILL.md'), 'utf8'), /--turn/);
    const relay = await createSendRelay(tools.relayRoot, async () => ({ status: 'sent' }));
    try {
      const result = await command(['send', '--turn', relay.turn, '已安装'], '', { WXBOT_RELAY_DIR: tools.relayRoot });
      assert.equal(result.code, 0, result.stdout + result.stderr);
    } finally { await relay.close(); }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('同一 request-id 可刷新尚未确认的回执，不读取上次查询的旧响应', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-query-'));
  let status = 'unknown', calls = 0;
  const relay = await createSendRelay(dir, async () => { calls++; return { status }; });
  const options = { relayDir: dir, turn: relay.turn, requestId: randomUUID(), text: '查询回执' };
  try {
    assert.equal((await sendText(options)).status, 'unknown');
    status = 'sent';
    assert.equal((await sendText(options)).status, 'sent');
    assert.equal((await sendText(options)).status, 'sent');
    assert.equal(calls, 2);
  } finally { await relay.close(); await rm(dir, { recursive: true, force: true }); }
});

test('本机 Codex 保持 RPC 持久会话并能执行发送工具，相同最终回复只发送一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-codex-send-')), sent = [], calls = [], turns = [];
  const seed = new Store(dir);
  const account = { id: 'bot', userId: 'owner', token: 'secret' };
  seed.set('account', account); seed.set('paused', true); seed.close();
  let receipt, env, ambiguous = false;
  const app = await createApp({ dir, api: { async sendText(a, text) { sent.push({ a, text }); if(ambiguous)throw new Error('connection lost after submit'); } }, codexOptions: { cwd: dir,
    clientFactory(options) {
      env = options.env;
      return { async initialize() {}, async close() {},
        async request(method, params) { calls.push({ method, params }); return { thread: { id: params.threadId || 'persistent-thread' } }; },
        async run({ input, turnOptions }) {
          turns.push(turnOptions);
          const turn = input.at(-1).text.match(/--turn ([a-f0-9-]{36})/)[1];
          const result = await command(['send', '--relay-dir', join(dir, 'agent-tools/.local/share/wxbot-send'), '--turn', turn, '主动发送完成']);
          assert.equal(result.code, ambiguous ? 2 : 0, result.stdout + result.stderr); receipt = JSON.parse(result.stdout);
          return { text: '主动发送完成', turnId: 'model-turn' };
        } };
    } } });
  try {
    for (const id of ['first', 'second']) {
      const jobs = app.codex.plan([{ id, sender: 'owner', text: '执行发送', attachments: [] }], account);
      app.store.addCodexJob(jobs[0]); app.codex.wake(); await until(() => !app.codex.draining);
    }
    assert.equal(receipt.status, 'sent'); assert.equal(sent.length, 2);
    assert.equal(calls[0].method, 'thread/start'); assert.equal(calls[1].method, 'thread/resume');
    assert.equal(calls[1].params.threadId, 'persistent-thread');
    assert(env.PATH.startsWith(join(dir, 'agent-tools/.local/bin')));
    assert(turns.every(t => t.sandboxPolicy.type === 'workspaceWrite' && t.sandboxPolicy.networkAccess === false));
    ambiguous = true;
    const [job] = app.codex.plan([{ id: 'ambiguous', sender: 'owner', text: '不要重复发送', attachments: [] }], account);
    app.store.addCodexJob(job); app.codex.wake(); await until(() => !app.codex.draining);
    assert.equal(receipt.status, 'unknown'); assert.equal(sent.length, 3);
    assert.match(app.store.codexJob(job.id).deliveryError, /确认/);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
