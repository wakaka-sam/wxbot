import { createDecipheriv, randomUUID } from 'node:crypto';
import { mkdir, writeFile, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, basename, relative, isAbsolute, sep } from 'node:path';

export const MAX_MEDIA_SIZE = 20 * 1024 * 1024;

export function describeMedia(bytes, name, requested = 'auto') {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw new Error('不能发送空文件');
  if (bytes.length > MAX_MEDIA_SIZE) throw new Error('每个附件最多 20 MB');
  if (!['auto', 'image', 'video', 'file'].includes(requested)) throw new Error('附件类型无效');
  if (typeof name !== 'string' || !name.trim() || name.length > 240 || /[\x00-\x1f]/.test(name)) throw new Error('附件名称无效');
  name = basename(name.replaceAll('\\', '/'));
  const imageMime = imageType(bytes);
  const mp4 = bytes.subarray(4, 8).toString() === 'ftyp' && /^(isom|iso[2-9]|mp4[12]|avc1|M4V )$/.test(bytes.subarray(8, 12).toString());
  const kind = requested === 'auto' ? imageMime.startsWith('image/') ? 'image' : mp4 ? 'video' : 'file' : requested;
  if (kind === 'image' && !imageMime.startsWith('image/')) throw new Error('图片需为 PNG、JPEG、GIF 或 WebP，也可以选择作为文件发送');
  if (kind === 'video' && !mp4) throw new Error('视频消息需为 MP4，其他格式可作为文件发送');
  return { kind, name, size: bytes.length, mime: kind === 'image' ? imageMime : kind === 'video' ? 'video/mp4' : 'application/octet-stream' };
}
export async function saveMedia(bytes, description, dir) {
  const id = randomUUID();
  await mkdir(join(dir, 'media'), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'media', id), bytes, { mode: 0o600 });
  return { ...description, id };
}

// Only explicit final-answer directives produce attachments; ordinary links do not.
export async function prepareReply(text, cwd, dir) {
  const attachments = [], errors = [];
  const paths = [];
  const reply = text.replace(/^\[\[clawbot-send:(.+)\]\]\s*$/gm, (_, path) => { paths.push(path.trim()); return ''; }).trim();
  const root = await realpath(cwd);
  const privateRoot = await realpath(dir);
  const inside = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
  for (const path of [...new Set(paths)].slice(0, 5)) {
    let file;
    try {
      if (!isAbsolute(path)) throw new Error('需要绝对路径');
      const resolved = await realpath(path);
      if (!inside(root, resolved) || (inside(privateRoot, resolved) && !inside(join(privateRoot, 'media'), resolved))) {
        throw new Error('只允许发送工作目录中的文件，不允许发送登录态或内部数据');
      }
      file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_MEDIA_SIZE) throw new Error('需为不超过 20 MB 的普通文件');
      const bytes = Buffer.alloc(MAX_MEDIA_SIZE + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const content = bytes.subarray(0, length);
      attachments.push(await saveMedia(content, describeMedia(content, basename(path)), dir));
    } catch (error) { errors.push(`附件 ${basename(path)} 未发送：${error.message}`); }
    finally { await file?.close(); }
  }
  if (paths.length > 5) errors.push('每轮最多发送 5 个附件，其余未发送。');
  return { reply: [reply, ...errors].filter(Boolean).join('\n\n'), replyAttachments: attachments };
}

export function decodeKey(encoded) {
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length === 16) return raw;
  if (raw.length === 32 && /^[a-f0-9]{32}$/i.test(raw.toString())) return Buffer.from(raw.toString(), 'hex');
  throw new Error('媒体解密密钥格式不正确');
}
function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}
export async function downloadMedia(item, dir, signal, fetchImpl = fetch) {
  const types = { 2: ['image', '图片', 'image_item'], 3: ['voice', '语音.silk', 'voice_item'],
    4: ['file', '文件', 'file_item'], 5: ['video', '视频.mp4', 'video_item'] };
  const [kind, defaultName, field] = types[item.type];
  const value = item[field] || {};
  const result = { kind, name: basename(value.file_name || defaultName) };
  try {
    const media = value.media;
    if (!media?.encrypt_query_param && !media?.full_url) throw new Error('此消息未提供可下载的媒体');
    const url = new URL(media.full_url || 'https://novac2c.cdn.weixin.qq.com/c2c/download');
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.cdn.weixin.qq.com') ||
        url.username || url.password || (url.port && url.port !== '443')) throw new Error('媒体地址不受信任');
    if (!media.full_url) url.searchParams.set('encrypted_query_param', media.encrypt_query_param);
    const response = await fetchImpl(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]), redirect: 'error',
    });
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
    const limit = 20 * 1024 * 1024;
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('附件超过 20 MB，请在微信中查看');
      chunks.push(chunk);
    }
    let bytes = Buffer.concat(chunks);
    const encodedKey = value.aeskey ? Buffer.from(value.aeskey, 'hex').toString('base64') : media.aes_key;
    if (encodedKey) {
      const decipher = createDecipheriv('aes-128-ecb', decodeKey(encodedKey), null);
      bytes = Buffer.concat([decipher.update(bytes), decipher.final()]);
    }
    const id = randomUUID();
    await mkdir(join(dir, 'media'), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'media', id), bytes, { mode: 0o600 });
    return { ...result, id, size: bytes.length, mime: kind === 'image' ? imageType(bytes) :
      kind === 'video' ? 'video/mp4' : 'application/octet-stream' };
  } catch (error) {
    if (signal.aborted) throw error;
    return { ...result, error: error.message };
  }
}
