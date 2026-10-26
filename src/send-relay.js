import { mkdir, open, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UUID, sendHash, validateSend, RELAY_LIMIT } from './send-client.js';

// One directory and callback per active turn. No caller-controlled recipient,
// profile, URL or host file path crosses this boundary.
export async function createSendRelay(root, onSend) {
  const turn = randomUUID(), dir = join(root, turn);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let closed = false, running = null;
  const completed = new Map();
  async function drain() {
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.req.json')).slice(0, 32)) {
      if (closed) break;
      const stem = name.slice(0, -9), [id, attempt, ...extra] = stem.split('.');
      if (!UUID.test(id) || !UUID.test(attempt || '') || extra.length) continue;
      let file, response;
      try {
        file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const info = await file.stat();
        if (!info.isFile() || info.size > RELAY_LIMIT) throw new Error('发送请求过大或不是普通文件');
        const bytes = Buffer.alloc(info.size+1);let bytesRead=0;
        while(bytesRead<bytes.length){const part=await file.read(bytes,bytesRead,bytes.length-bytesRead,null);if(!part.bytesRead)break;bytesRead+=part.bytesRead;}
        if (bytesRead !== info.size) throw new Error('发送请求在读取时发生变化');
        const request = JSON.parse(bytes.subarray(0, bytesRead).toString());
        if (request.turn !== turn || request.requestId !== id || Object.keys(request).some(k => !['turn', 'requestId', 'text','attachment'].includes(k))) throw new Error('发送上下文无效');
        validateSend(request.text,request.attachment);
        const hash = sendHash(request.text,request.attachment), prior = completed.get(id);
        if (prior && prior.hash !== hash) throw new Error('同一 request-id 不能修改正文');
        if (!prior && completed.size >= 100) throw new Error('每轮最多主动发送 100 条消息');
        response = prior && ['sent', 'failed'].includes(prior.delivery.status)
          ? prior : { hash, delivery: await onSend(request) };
        completed.set(id, response);
      } catch (error) { response = completed.get(id) || { delivery: { status: 'failed', error: error.message } }; }
      finally { await file?.close(); }
      const tmp = join(dir, `${stem}.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(response), { mode: 0o600, flag: 'wx' });
      await rename(tmp, join(dir, `${stem}.res.json`));
      await rm(join(dir, name), { force: true });
    }
  }
  const timer = setInterval(() => {
    if (!running && !closed) running = drain().catch(() => {}).finally(() => { running = null; });
  }, 50);
  timer.unref();
  return { dir, turn, root, async close() { closed = true; clearInterval(timer); await running; await rm(dir, { recursive: true, force: true }); } };
}
