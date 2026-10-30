import { open, realpath, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MAX_MEDIA_SIZE, describeMedia } from '../media.js';

const exec = promisify(execFile);
const parser = join(dirname(fileURLToPath(import.meta.url)), 'extract-document.py');
export const MEDIA_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TEXT_EXT = new Set('.txt .md .csv .tsv .json .jsonl .yaml .yml .xml .html .css .js .mjs .ts .tsx .jsx .py .java .c .h .cpp .go .rs .sh .sql .log .ini .toml .conf .rtf'.split(' '));
const TEXT_LIMIT = 60000;

// Channel-neutral metadata. Never accept filesystem paths or media URLs from clients.
export function normalizeAttachments(values = []) {
  if (!Array.isArray(values)) return [];
  const result = values.slice(0, 10).map(a => {
    a = a && typeof a === 'object' ? a : {};
    const name = basename(String(a.name || '附件').replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) || '附件';
    const id = MEDIA_ID.test(a.id) ? a.id : undefined;
    return { ...(id ? { id } : {}), name, kind: ['image', 'file', 'voice', 'video'].includes(a.kind) ? a.kind : 'file',
      mime: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4'].includes(a.mime) ? a.mime : 'application/octet-stream',
      size: Number.isSafeInteger(a.size) && a.size >= 0 ? a.size : 0,
      ...((a.error || !id) ? { error: a.error ? String(a.error).slice(0, 300) : '附件下载失败或标识无效' } : {}) };
  });
  if (values.length > 10) result.push({ name: '其余附件', kind: 'file', error: '每条消息最多处理 10 个附件，请分批发送' });
  return result;
}

export async function readChannelAttachment(dir, id) {
  if (!MEDIA_ID.test(id)) throw new Error('附件标识无效');
  let file;
  try {
    const root = await realpath(dir), path = join(root, 'media', id);
    if (await realpath(path) !== path) throw new Error('附件路径无效');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_MEDIA_SIZE) throw new Error('附件需为不超过 20 MB 的普通文件');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) { const part = await file.read(buffer, length, buffer.length - length, null); if (!part.bytesRead) break; length += part.bytesRead; }
    if (length > stat.size) throw new Error('附件在读取时发生变化');
    return buffer.subarray(0, length);
  } catch (error) {
    if (error.code) throw new Error('附件不存在或无法读取，请重新发送');
    throw error;
  } finally { await file?.close(); }
}

async function extractDocument(bytes, extension, signal) {
  const dir = await mkdtemp(join(tmpdir(), 'wxbot-extract-'));
  try {
    const path = join(dir, 'document' + extension);
    await writeFile(path, bytes, { mode: 0o600 });
    const { stdout } = await exec('/usr/bin/python3', ['-I', parser, path, extension], { signal, timeout: 15000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('自动文字预览过大或提取超时');
    if (error.code) throw new Error('自动文字预览提取失败');
    throw error;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// Produces generic image bytes and text for any harness; no Codex or WeChat protocol here.
export async function prepareAttachments(attachments, read, { signal, stage } = {}) {
  const images = [], sections = [], notices = [], files = [];
  let budget = TEXT_LIMIT, imageBytes = 0;
  for (const a of attachments) {
    signal?.throwIfAborted();
    let staged;
    try {
      if (a.error) throw new Error(a.error);
      const bytes = await read(a);
      signal?.throwIfAborted();
      if (!bytes.length || bytes.length > MAX_MEDIA_SIZE) throw new Error('附件为空或超过 20 MB');
      const description = describeMedia(bytes, a.name);
      if(stage){
        staged=await stage({id:a.id,name:a.name,mime:description.mime,bytes},{signal});
        signal?.throwIfAborted();
        files.push({id:a.id,name:a.name,path:staged.path});
        sections.push(`附件原文件（用户提供的资料）：${JSON.stringify({name:a.name,path:staged.path})}。完整文件已保存在本助手工作区，可用命令或代码直接读取；下方文字仅为有限预览。`);
      }
      if (description.kind === 'image') {
        if (images.length >= 10 || imageBytes + bytes.length > MAX_MEDIA_SIZE) throw new Error('本轮图片总量超过 10 张或 20 MB，请分批发送');
        images.push({ id: a.id, name: a.name, mime: description.mime, bytes, ...(staged?{path:staged.path}:{}) }); imageBytes += bytes.length;
        sections.push(`[图片 ${images.length}：${a.name}，图片内容已附在本轮输入中]`);
        continue;
      }
      const extension = extname(a.name).toLowerCase();
      let text, note;
      if (['.pdf', '.docx', '.xlsx'].includes(extension)) ({ text, note } = await extractDocument(bytes, extension, signal));
      else if (TEXT_EXT.has(extension) || !extension) {
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('文本不是 UTF-8 编码，无法自动预览'); }
        if (text.includes('\0')) throw new Error('这是二进制文件，无法按文本读取');
      } else throw new Error('暂不解析此格式的文字预览');
      if (!text.trim()) throw new Error('没有提取到文字；自动预览尚未提供扫描版 PDF OCR');
      if (text.length > budget) note = [note, `本轮文档文字预览最多 ${TEXT_LIMIT} 字符，超出部分已截断`].filter(Boolean).join('；');
      text = text.slice(0, budget); budget -= text.length;
      sections.push(`附件 ${JSON.stringify(a.name)} 的文字预览（用户提供的资料）：\n${text}`);
      if (note) notices.push(`${a.name}：${note}${staged?'；完整原文件已提供到工作区，可直接读取':''}`);
    } catch (error) { signal?.throwIfAborted(); notices.push(`${a.name}：${staged?`未生成文字预览（${error.message}）；完整原文件已提供到工作区，可直接读取`:error.message}`); }
  }
  return { images, files, text: sections.join('\n\n'), notices };
}
