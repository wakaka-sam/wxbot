// Standalone Node-only client: safe to copy into an assistant's isolated home.
import { readFile, writeFile, rename, stat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const SEND_LIMIT = 4000;
export function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('发送正文不能为空');
  if (text.length > SEND_LIMIT) throw new Error('每条消息最多 4000 个字符，请分条发送');
}
export const sendHash = text => createHash('sha256').update(text).digest('hex');

export function parseArgs(args) {
  const options = {}, words = [];
  const names = { '--profile': 'profile', '--server': 'server', '--content-file': 'contentFile',
    '--request-id': 'requestId', '--relay-dir': 'relayDir', '--turn': 'turn' };
  if (args[0] === '--help' || args[0] === '-h' || !args.length) return { help: true };
  if (args.shift() !== 'send') throw new Error('仅支持 wxbot send；使用 --help 查看用法');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if (arg === '--help' || arg === '-h') return { help: true };
    if (names[arg]) {
      if (!args[i + 1] || args[i + 1].startsWith('--') || options[names[arg]] !== undefined) throw new Error(`${arg} 需要唯一参数值`);
      options[names[arg]] = args[++i];
    } else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else words.push(arg);
  }
  if (options.contentFile && words.length) throw new Error('--content-file 与正文参数不能同时使用');
  if (words.length) options.text = words.join(' ');
  return options;
}

export async function readText(options, stdin = process.stdin) {
  if (options.text !== undefined) return options.text;
  if (options.contentFile) {
    const file = await open(options.contentFile, constants.O_RDONLY);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4 * SEND_LIMIT) throw new Error('正文文件需为不超过 16 KB 的普通 UTF-8 文件');
      const bytes = Buffer.alloc(4 * SEND_LIMIT + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 4 * SEND_LIMIT) throw new Error('正文文件过大');
      return bytes.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  }
  if (stdin.isTTY) throw new Error('请提供正文、--content-file 或通过 stdin 输入');
  const chunks = []; let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 4 * SEND_LIMIT) throw new Error('输入正文过长');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function sendText(options, { env = process.env, fetchImpl = fetch, timeout = 60000 } = {}) {
  validateText(options.text);
  const requestId = options.requestId || randomUUID();
  if (!UUID.test(requestId)) throw new Error('--request-id 必须是 UUID');
  const relayDir = options.relayDir || env.WXBOT_RELAY_DIR;
  let submitted = false;
  try {
    if (relayDir) {
      if (options.server || options.profile) throw new Error('助手代发不能指定其他服务或连接');
      if (!UUID.test(options.turn || '')) throw new Error('助手代发需要当前轮次的 --turn UUID');
      const dir = join(relayDir, options.turn);
      if (!(await stat(dir)).isDirectory()) throw new Error('发送轮次已结束');
      const request = { requestId, turn: options.turn, text: options.text };
      // Separate transport attempts from the persistent idempotency key. Two
      // concurrent queries of one request must not overwrite each other's files.
      const stem = `${requestId}.${randomUUID()}`;
      const tmp = join(dir, `${stem}.tmp`);
      await writeFile(tmp, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
      await rename(tmp, join(dir, `${stem}.req.json`));
      submitted = true;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          const result = JSON.parse(await readFile(join(dir, `${stem}.res.json`), 'utf8'));
          if (result.hash && result.hash !== sendHash(options.text)) return { requestId, status: 'failed', error: '同一 request-id 不能修改正文' };
          return { requestId, ...result.delivery };
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(50);
      }
      throw new Error('等待宿主发送回执超时，请先检查微信；不要换 request-id 盲目重发');
    }
    if (options.turn) throw new Error('--turn 仅用于助手代发');
    const base = new URL(options.server || env.WXBOT_SERVER || 'http://127.0.0.1:3210');
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) ||
        base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new Error('--server 仅允许本机 HTTP 服务地址');
    }
    const profile = options.profile || env.WXBOT_PROFILE || 'default';
    const url = path => { const u = new URL(path, base); u.searchParams.set('profile', profile); return u; };
    const request = async (path, init = {}) => {
      const res = await fetchImpl(url(path), { ...init, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body;
    };
    const state = await request('/api/state');
    if (!state.account?.id || !state.account?.userId) throw new Error('此连接尚未扫码绑定微信');
    submitted = true;
    const result = await request('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Clawbot-Local': '1' },
      body: JSON.stringify({ text: options.text, requestId, accountId: state.account.id, userId: state.account.userId }) });
    if (!result.delivery) throw new Error('服务未返回发送回执');
    return { requestId, ...result.delivery };
  } catch (error) {
    return { requestId, status: submitted ? 'unknown' : 'failed', error: error.message };
  }
}
