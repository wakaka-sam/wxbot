import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SEND_INSTRUCTIONS = `你可以执行 wxbot send 向当前绑定的微信用户发送文字、图片和文件，不需要微信凭证或接收者 ID。
每轮输入会提供唯一的 --turn 标识；只使用本轮标识，不得使用历史轮次或指定其他账号。
适合主动通知、进度更新、向用户提问。多行正文用 stdin/heredoc 或 --content-file；最多 4000 字符。
仅 status=sent 表示微信接口已接受；unknown 时先核实，不换 request-id 重发。
最终回复仍自动转发；已用 wxbot send 发送的正文不要改写后重复输出。完全相同的最终正文会去重。
图片使用 wxbot send --turn <本轮UUID> --image /workspace/chart.png；文件使用 --file /workspace/report.pdf。
每次只发送一张图片、一个文件或一条文字；附件最多 20 MB，图片支持 PNG/JPEG/GIF/WebP。说明文字另发。
只发送用户要求的产物；附件由当前执行环境读取并上传真实字节，不要用文件路径或文件内容冒充附件。
平台每次微信用户输入后最多回复 10 条（文字和附件共用）；额度不足时附件会排队，提示用户在微信发“继续”，不要更换 request-id 重发。`;

export async function installSendTools(home, { visibleHome = home, node = process.execPath } = {}) {
  const tools = join(home, '.local', 'share', 'wxbot-tools'), bin = join(home, '.local', 'bin');
  const relayRoot = join(home, '.local', 'share', 'wxbot-send');
  // Keep tool-readable instructions outside the denied CODEX_HOME containing
  // the shared model credential. Codex discovers this standard user skill root.
  const skill = join(home, '.agents', 'skills', 'wxbot-send');
  for (const dir of [tools, bin, relayRoot, skill]) await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ['cli.js', 'send-client.js', 'browser.cjs']) await writeFile(join(tools, name), await readFile(new URL(name, import.meta.url)), { mode: 0o600 });
  await writeFile(join(tools, 'package.json'), '{"type":"module"}\n', { mode: 0o600 });
  const visibleCli = join(visibleHome, '.local', 'share', 'wxbot-tools', 'cli.js');
  const visibleRelay = join(visibleHome, '.local', 'share', 'wxbot-send');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(join(bin, 'wxbot'), `#!/bin/sh\nexport WXBOT_RELAY_DIR=${quote(visibleRelay)}\nexec ${quote(node)} ${quote(visibleCli)} "$@"\n`, { mode: 0o700 });
  await writeFile(join(skill, 'SKILL.md'), `---\nname: wxbot-send\ndescription: 向当前 wxbot 会话绑定的微信用户主动发送文字、图片、文件、进度和问题。仅用于 wxbot 会话。\n---\n\n${SEND_INSTRUCTIONS}\n`, { mode: 0o600 });
  return { bin, relayRoot, visibleRelay, visibleCli };
}
