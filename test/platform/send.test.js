import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, register, create, until } from './helpers.js';
import { CodexHarness } from '../../src/platform/adapters/codex.js';
import { installSendTools } from '../../src/send-tools.js';

const exec = promisify(execFile);

test('平台真实发送命令经过 Harness relay 与持久 outbox，重复请求及最终正文不重复发微信', async () => {
  const f = await fixture();
  try {
    const user = await register(f), id = await create(user);
    await user.request(`/api/assistants/${id}/activate`, {});
    const r = f.app.engine.runtimes.get(id);
    await r.channel.pair();
    const tools = await installSendTools(join(f.dir, 'tool-home'));
    let receipt;
    r.harness.run = async args => {
      const h = Object.create(CodexHarness.prototype);
      Object.assign(h, { sendTools: tools, dir: join(f.dir, 'harness'), cwd: f.dir, threadId: 'test-thread', client: {
        async run({ input, onEvent }) {
          const turn = input[0].text.match(/--turn ([a-f0-9-]{36})/)[1], requestId = randomUUID();
          const command = [tools.visibleCli, 'send', '--relay-dir', tools.relayRoot, '--turn', turn, '--request-id', requestId, '命令已经发送'];
          receipt = JSON.parse((await exec(process.execPath, command)).stdout);
          assert.equal(receipt.status, 'sent');
          assert.equal(JSON.parse((await exec(process.execPath, command)).stdout).id, receipt.id);
          onEvent({ type: 'delta', itemId: 'final', delta: '命令已经', phase: 'final_answer' });
          onEvent({ type: 'delta', itemId: 'final', delta: '发送', phase: 'final_answer' });
          onEvent({ type: 'message', itemId: 'final', text: '命令已经发送', phase: 'final_answer' });
          return { text: '命令已经发送' };
        },
      } });
      return h.run(args);
    };
    r.channel.input('执行发送');
    await until(() => receipt && !r.draining);
    assert.equal(f.fake.sent.filter(s => s.text === '命令已经发送').length, 1);
    assert.equal(f.app.store.delivery(receipt.id).state, 'sent');
    assert.equal(f.app.store.message(receipt.id).source, 'wxbot-send');
    const binding = f.fake.sent.find(s => s.id === receipt.id).binding;
    assert.deepEqual(binding, { accountId: r.channel.snapshot().account.id, userId: 'owner' });
    await f.restart();
    assert.equal(f.app.store.delivery(receipt.id).state, 'sent');
    assert.equal(f.fake.sent.filter(s => s.text === '命令已经发送').length, 1);
  } finally { await f.close(); }
});

test('发送工具拒绝旧轮次与微信身份变更；发送失败仍保留自动最终回复', async () => {
  const f = await fixture();
  try {
    const c = await register(f), id = await create(c);
    await c.request(`/api/assistants/${id}/activate`, {});
    const r = f.app.engine.runtimes.get(id); await r.channel.pair();
    let oldSend, checked = false;
    r.harness.run = async ({ onSend, onEvent }) => {
      oldSend = onSend;
      const prior = r.channel.state.account;
      r.channel.state.account = { id: 'another-bot', userId: 'another-owner' };
      await assert.rejects(onSend({ requestId: randomUUID(), text: '不得串号' }), /绑定/);
      r.channel.state.account = prior;
      const original = r.channel.send;
      r.channel.send = async () => ({ status: 'failed', error: 'upstream rejected' });
      const request = { requestId: randomUUID(), text: '可见最终答复' };
      const failed = await onSend(request); assert.equal(failed.status, 'failed');
      await assert.rejects(onSend({ ...request, text: '同一标识改写' }), /request-id/);
      r.channel.send = original;
      onEvent({ type: 'message', itemId: 'final', text: '可见最终答复', phase: 'final_answer' });
      checked = true; return { text: '可见最终答复' };
    };
    r.channel.input('发一次'); await until(() => checked && !r.draining);
    await assert.rejects(oldSend({ requestId: randomUUID(), text: '旧任务后台进程' }), /轮次/);
    await until(() => f.fake.sent.some(s => s.text === '可见最终答复'));
    assert(!f.fake.sent.some(s => s.text === '不得串号' || s.text === '旧任务后台进程'));
  } finally { await f.close(); }
});

test('平台未知发送结果不会以自动最终回复重新发送', async () => {
  const f = await fixture();
  try {
    const c = await register(f), id = await create(c);
    await c.request(`/api/assistants/${id}/activate`, {});
    const r = f.app.engine.runtimes.get(id); await r.channel.pair();
    let attempts = 0, finished = false;
    r.harness.run = async ({ onSend, onEvent }) => {
      r.channel.send = async () => { attempts++; return { status: 'unknown', error: 'connection lost' }; };
      assert.equal((await onSend({ requestId: randomUUID(), text: '结果待核实' })).status, 'unknown');
      onEvent({ type: 'message', itemId: 'final', text: '结果待核实', phase: 'final_answer' });
      finished = true; return { text: '结果待核实' };
    };
    r.channel.input('执行发送'); await until(() => finished && !r.draining);
    assert.equal(attempts, 1);
  } finally { await f.close(); }
});
