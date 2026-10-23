// Opt-in Linux sandbox smoke test. No WeChat credentials, conversations or sends.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexHarness } from '../src/platform/adapters/codex.js';

if (process.env.PLATFORM_AGENT_TEST !== '1') throw new Error('Set PLATFORM_AGENT_TEST=1 for this isolated CLI smoke test');
const dir = await mkdtemp(join(tmpdir(), 'wxbot-send-smoke-'));
const harness = new CodexHarness({ dir });
const sent = [];
try {
  await harness.prepare({ onThread() {} });
  // Exercise the real tool sandbox without spending a model turn: replace only
  // model generation, leaving the real app-server and command/exec intact.
  const command = argv => harness.client.request('command/exec', { command: argv, cwd: '/workspace', timeoutMs: 20000 });
  const found = await command(['/bin/sh', '-c', 'command -v wxbot']);
  assert.equal(found.exitCode, 0, found.stderr);
  assert.equal(found.stdout.trim(), '/home/assistant/.local/bin/wxbot');
  const skills = await harness.client.request('skills/list', { cwds: ['/workspace'], forceReload: true });
  assert.match(JSON.stringify(skills), /wxbot-send/);
  const skill = await command(['/bin/cat', '/home/assistant/.agents/skills/wxbot-send/SKILL.md']);
  assert.equal(skill.exitCode, 0, skill.stderr); assert.match(skill.stdout, /--turn/);
  harness.client.run = async ({ input }) => {
    const turn = input[0].text.match(/--turn ([a-f0-9-]{36})/)[1];
    const result = await command(['/home/assistant/.local/bin/wxbot', 'send', '--turn', turn, 'SYNTHETIC-SEND-731']);
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'sent');
    const stale = await command(['/home/assistant/.local/bin/wxbot', 'send', '--turn', '00000000-0000-0000-0000-000000000000', 'must fail']);
    assert.notEqual(stale.exitCode, 0);
    const denied = await command(['/home/assistant/.local/bin/wxbot', 'send', '--turn', turn, '--profile', 'other', 'must fail']);
    assert.notEqual(denied.exitCode, 0);
    return { text: 'synthetic test complete' };
  };
  await harness.run({ text: 'synthetic', onEvent() {}, onSend: async r => { sent.push(r.text); return { status: 'sent', id: r.requestId }; } });
  assert.deepEqual(sent, ['SYNTHETIC-SEND-731']);
  console.log(JSON.stringify({ sandboxSend: 'passed', staleTurn: 'rejected', otherProfile: 'rejected', realWechatSends: 0 }));
} finally { await harness.close(); await rm(dir, { recursive: true, force: true }); }
