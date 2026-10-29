import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync, constants } from 'node:fs';
import { readFile, writeFile, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { describeMedia, MAX_MEDIA_SIZE } from './media.js';

const TOKEN = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });
export const downloadNotice = (name, link, uncertain = false) =>
  `${uncertain ? '附件发送结果未能确认' : '附件发送失败'}，可通过以下链接下载：\n${name}\n${link.url}\n有效期至 ${new Date(link.expiresAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}`;

// Opaque, expiring bearer links. Neither account IDs nor source paths are exposed.
export class Downloads {
  constructor(dir, { publicUrl, now = Date.now, ttl = 86400000 } = {}) {
    this.dir = dir; this.publicUrl = publicUrl; this.now = now; this.ttl = ttl; this.pending = Promise.resolve();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'downloads.sqlite'));
    chmodSync(join(dir, 'downloads.sqlite'), 0o600);
    this.db.exec('CREATE TABLE IF NOT EXISTS downloads (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  publish(bytes, name, id) {
    const next = this.pending.catch(() => {}).then(async () => {
      if (!this.publicUrl) throw fail(503, '下载域名尚未配置');
      if (!TOKEN.test(id)) throw fail(400, '下载请求标识无效');
      const description = describeMedia(bytes, name, 'file');
      const hash = digest(Buffer.concat([Buffer.from(JSON.stringify(description.name)), bytes]));
      let row = this.db.prepare('SELECT * FROM downloads WHERE id=?').get(id);
      if (row && row.hash !== hash) throw fail(409, '同一下载请求不能修改文件');
      if (row && row.expires <= this.now()) throw fail(410, '下载链接已过期，请重新发送文件');
      if (!row) {
        row = { token: randomBytes(32).toString('hex'), name: description.name, hash, expires: this.now() + this.ttl };
        const path = join(this.dir, row.token + '.bin');
        await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
        try { this.db.prepare('INSERT INTO downloads VALUES (?,?,?,?,?)').run(id, row.token, row.name, row.hash, row.expires); }
        catch (error) { await unlink(path).catch(() => {}); throw error; }
      }
      return { url: new URL('/downloads/' + row.token, this.publicUrl).href, expiresAt: row.expires };
    });
    this.pending = next; return next;
  }
  async read(token) {
    if (!TOKEN.test(token)) throw fail(404, '下载链接不存在或已过期');
    const row = this.db.prepare('SELECT * FROM downloads WHERE token=?').get(token);
    if (!row || row.expires <= this.now()) throw fail(404, '下载链接不存在或已过期');
    let file;
    try {
      file = await open(join(this.dir, token + '.bin'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_MEDIA_SIZE) throw new Error('invalid file');
      const bytes = await file.readFile();
      if (bytes.length !== stat.size || digest(Buffer.concat([Buffer.from(JSON.stringify(row.name)), bytes])) !== row.hash) throw new Error('changed file');
      return { name: row.name, bytes };
    } catch { throw fail(404, '下载文件已不可用'); }
    finally { await file?.close(); }
  }
  async cleanup() {
    for (const row of this.db.prepare('SELECT token FROM downloads WHERE expires<=?').all(this.now())) {
      await unlink(join(this.dir, row.token + '.bin')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async close() { await this.pending.catch(() => {}); this.db.close(); }
}

// Host-only credential; never installed into an assistant workspace.
export function remoteDownloadPublisher({ baseUrl = process.env.WXBOT_DOWNLOAD_URL, tokenFile = process.env.WXBOT_DOWNLOAD_TOKEN_FILE } = {}) {
  if (!baseUrl || !tokenFile) return undefined;
  const url = new URL('/internal/downloads', baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('下载发布地址必须使用 HTTPS');
  return async (bytes, name, id) => {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(name), 'X-Download-Id': id }, body: bytes });
    if (!response.ok) throw new Error(`备用下载发布失败（HTTP ${response.status}）`);
    const result = await response.json();
    const link = new URL(result.url);
    if (link.origin !== url.origin || !/^\/downloads\/[a-f0-9]{64}$/.test(link.pathname) || !Number.isFinite(result.expiresAt)) throw new Error('备用下载链接无效');
    return result;
  };
}

export async function handleDownloads(req, res, url, downloads, tokenFile) {
  const isRead = ['GET', 'HEAD'].includes(req.method) && /^\/downloads\/[a-f0-9]{64}$/.test(url.pathname);
  const isPublish = req.method === 'POST' && url.pathname === '/internal/downloads';
  if (!isRead && !isPublish) return false;
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Frame-Options': 'DENY' };
  try {
    if (isRead) {
      const file = await downloads.read(url.pathname.slice('/downloads/'.length));
      res.writeHead(200, { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': file.bytes.length,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name.toWellFormed())}` });
      res.end(req.method === 'HEAD' ? undefined : file.bytes);
    } else {
      const expected = tokenFile ? (await readFile(tokenFile, 'utf8')).trim() : '';
      const supplied = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!TOKEN.test(expected) || !timingSafeEqual(Buffer.from(digest(supplied)), Buffer.from(digest(expected)))) throw fail(403, '禁止发布下载');
      if (!TOKEN.test(req.headers['x-download-id'] || '')) throw fail(400, '下载请求标识无效');
      if (Number(req.headers['content-length']) > MAX_MEDIA_SIZE) throw fail(413, '文件超过 20 MB');
      const parts = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > MAX_MEDIA_SIZE) throw fail(413, '文件超过 20 MB'); parts.push(part); }
      const result = await downloads.publish(Buffer.concat(parts), decodeURIComponent(req.headers['x-file-name'] || ''), req.headers['x-download-id']);
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    }
  } catch (error) {
    req.resume();
    res.writeHead(error.status || 400, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.status ? error.message : '下载服务暂不可用' }));
  }
  return true;
}
