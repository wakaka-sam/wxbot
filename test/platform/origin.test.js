import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { fixture, register, create } from './helpers.js';

const external = { Origin: 'https://external.example', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };

test('外站链接可打开公开首页和静态资源，Host 校验仍有效', async () => {
  const f = await fixture();
  try {
    for (const path of ['/?from=external', '/app.js', '/style.css', '/favicon.svg']) {
      const response = await fetch(f.base + path, { headers: external });
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      if (path.startsWith('/?')) assert.match(await response.text(), /id="auth-view"/);
    }
    const badHost = await new Promise((resolve, reject) => {
      get(f.base, { headers: { ...external, Host: 'untrusted.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(badHost, 403);
    assert.equal((await fetch(f.base, { method: 'POST', headers: external, body: '{}' })).status, 403);
  } finally { await f.close(); }
});

test('公开首页例外不放行跨站接口、历史、附件或写操作', async () => {
  const f = await fixture();
  try {
    const user = await register(f), id = await create(user);
    for (const headers of [{ Origin: external.Origin }, { 'Sec-Fetch-Site': 'cross-site' }, external]) {
      for (const path of ['/api/auth', '/api/assistants', `/api/assistants/${id}/messages`, `/api/assistants/${id}/events`, `/api/assistants/${id}/attachments/00000000-0000-0000-0000-000000000000`]) {
        const response = await user.request(path, undefined, headers);
        assert.equal(response.status, 403, path);
        assert.equal(response.data.error, '不允许跨站访问');
      }
      assert.equal((await user.request('/api/assistants', { name: 'blocked' }, headers)).status, 403);
      assert.equal((await user.request('/api/login', { username: 'alice', password: 'Test-password-731' }, headers)).status, 403);
    }
    const own = await user.request('/api/assistants', undefined, { Origin: f.base, 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(own.status, 200);
    assert.equal(own.data.assistants.length, 1);
  } finally { await f.close(); }
});
