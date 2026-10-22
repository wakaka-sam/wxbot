import http from 'node:http';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Weixin } from './weixin.js';
import { Profiles } from './profiles.js';
import { MAX_MEDIA_SIZE } from './media.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export async function createApp({ dir = resolve(process.env.CLAWBOT_DATA_DIR || join(root, 'data')),
  api = new Weixin(), bridgeOptions, codexOptions = false } = {}) {
  const profiles = new Profiles(dir, api, bridgeOptions, codexOptions);
  await profiles.init();
  const initial = profiles.items.get('default');
  let closing = false, listStamp = '';
  function broadcast(changed) {
    const stamp = JSON.stringify(profiles.list());
    const listChanged = stamp !== listStamp;
    listStamp = stamp;
    for (const profile of profiles.items.values()) {
      if (profile !== changed && !listChanged) continue;
      if (!profile.clients.size) continue;
      const event = `event: snapshot\ndata: ${JSON.stringify(profiles.snapshot(profile))}\n\n`;
      for (const client of profile.clients) {
        if (client.writableLength > 1024 * 1024) client.destroy();
        else client.write(event);
      }
    }
  }
  profiles.on('change', broadcast);
  const heartbeat = setInterval(() => {
    for (const profile of profiles.items.values()) for (const client of profile.clients) client.write(': heartbeat\n\n');
  }, 15000);
  heartbeat.unref();
  const server = http.createServer(async (req, res) => {
    const send = (status, data, type = 'application/json; charset=utf-8', extra = {}) => {
      res.writeHead(status, { ...securityHeaders, 'Content-Type': type, ...extra });
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      // Loopback binding + Host validation prevent LAN exposure and DNS rebinding.
      const port = server.address()?.port;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) return send(403, { error: '仅允许通过本机地址访问' });
      if (req.headers.origin && !allowedHosts.map(h => `http://${h}`).includes(req.headers.origin)) {
        return send(403, { error: '不允许跨站访问本机消息' });
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: '不允许跨站访问' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const profile = profiles.items.get(url.searchParams.get('profile') ?? 'default');
      if (!profile) return send(404, { error: '用户不存在，请刷新用户列表' });
      const { store, bridge, codex, dir, clients } = profile;
      const snapshot = () => profiles.snapshot(profile);
      if (req.method === 'POST') {
        if (req.headers['x-clawbot-local'] !== '1') return send(403, { error: '请从本地页面操作' });
        if (url.pathname === '/api/send-media') {
          if (Number(req.headers['content-length']) > MAX_MEDIA_SIZE) { req.resume(); return send(413, { error: '每个附件最多 20 MB' }); }
          const chunks = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > MAX_MEDIA_SIZE) throw new Error('每个附件最多 20 MB');
            chunks.push(chunk);
          }
          const delivery = await bridge.sendMedia(Buffer.concat(chunks),
            decodeURIComponent(req.headers['x-file-name'] || ''), req.headers['x-file-kind'] || 'auto',
            req.headers['x-request-id'], { accountId: req.headers['x-account-id'] });
          return send(200, { ...snapshot(), delivery });
        }
        let body = {};
        if (['/api/verify', '/api/send', '/api/codex/config', '/api/profiles', '/api/profile'].includes(url.pathname)) {
          const chunks = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > (url.pathname === '/api/verify' ? 1024 : 32768)) throw new Error('请求内容过长');
            chunks.push(chunk);
          }
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } else req.resume();
        switch (url.pathname) {
          case '/api/profiles': return send(201, profiles.snapshot(await profiles.create(body.name)));
          case '/api/profile': profiles.rename(profile, body.name); break;
          case '/api/login': await bridge.login(); break;
          case '/api/verify': bridge.verify(body.code); break;
          case '/api/send': {
            const delivery = await bridge.send(body.text, body.requestId, { accountId: body.accountId });
            return send(200, { ...snapshot(), delivery });
          }
          case '/api/pause': bridge.pause(); break;
          case '/api/resume': bridge.resume(); break;
          case '/api/logout': await codex?.stop(); bridge.logout(); break;
          case '/api/codex/config':
            if (!codex) throw new Error('Codex 模块未启用');
            await codex.configure(body); break;
          case '/api/codex/stop': await codex?.stop(); break;
          case '/api/codex/new': await codex?.newSession(); break;
          case '/api/clear': {
            await codex?.stop();
            // Stop intake while clearing attachments, then restore prior receiving state.
            const shouldResume = ['connected', 'connecting', 'reconnecting'].includes(bridge.state.phase);
            bridge.pause();
            await bridge.close();
            store.clear();
            await rm(join(dir, 'media'), { recursive: true, force: true });
            await mkdir(join(dir, 'media'), { recursive: true, mode: 0o700 });
            if (shouldResume) bridge.resume();
            bridge.update({ lastReceived: null });
            break;
          }
          default: return send(404, { error: '接口不存在' });
        }
        return send(200, snapshot());
      }
      if (req.method !== 'GET') return send(405, { error: '不支持的请求方法' });
      if (url.pathname === '/api/profiles') return send(200, { profiles: profiles.list() });
      if (url.pathname === '/api/state') return send(200, snapshot());
      if (url.pathname === '/api/events') {
        res.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/event-stream',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/api/export') return send(200, {
        exportedAt: new Date().toISOString(), messages: store.messages(-1),
      }, 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="clawbot-messages.json"' });
      if (url.pathname.startsWith('/media/')) {
        const id = url.pathname.slice(7);
        if (!/^[0-9a-f-]{36}$/.test(id)) return send(404, { error: '附件不存在' });
        const attachment = store.messages(-1).flatMap(m => m.attachments).find(a => a.id === id);
        if (!attachment) return send(404, { error: '附件不存在' });
        const bytes = await readFile(join(dir, 'media', id));
        const inline = attachment.mime.startsWith('image/') || attachment.mime === 'video/mp4';
        return send(200, bytes, attachment.mime, {
          'Content-Disposition': `${inline && !url.searchParams.has('download') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`,
        });
      }
      const files = { '/': ['index.html', 'text/html; charset=utf-8'],
        '/connections': ['connections.html', 'text/html; charset=utf-8'],
        '/connections/': ['connections.html', 'text/html; charset=utf-8'],
        '/connections.js': ['connections.js', 'text/javascript; charset=utf-8'],
        '/connections.css': ['connections.css', 'text/css; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
        '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      if (!files[url.pathname]) return send(404, { error: '页面不存在' });
      const [file, type] = files[url.pathname];
      send(200, await readFile(join(root, 'public', file)), type);
    } catch (error) {
      if (!res.headersSent) send(400, { error: error.code === 'ENOENT' ? '文件不存在' : error.message });
      else res.end();
    }
  });
  // Serialize only within a profile. One user's QR request cannot block another user.
  const handler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    if (closing) { res.writeHead(503); res.end(); return; }
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); res.end(); return; }
    const profile = profiles.items.get(url.pathname === '/api/profiles' || url.pathname === '/api/profile'
      ? 'default' : url.searchParams.get('profile') ?? 'default');
    if (req.method === 'POST' && profile) profile.commands = profile.commands.then(() => handler(req, res)).catch(() => {});
    else void handler(req, res);
  });
  return { server, profiles, bridge: initial.bridge, store: initial.store, codex: initial.codex,
    async close() {
      closing = true;
      clearInterval(heartbeat);
      // Registry operations can create a profile, so settle those first.
      await initial.commands;
      await Promise.all([...profiles.items.values()].map(p => p.commands));
      await profiles.close();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须为 1–65535');
  const app = await createApp({ codexOptions: {} });
  app.server.on('error', async error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，可使用 PORT=3211 npm start` : error.message);
    await app.close();
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', () => console.log(`ClawBot Local 已启动 → http://127.0.0.1:${port}`));
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  });
}
