#!/usr/bin/env node
import { parseArgs, readText, sendText } from './send-client.js';

const HELP = `wxbot send [正文] [--profile ID] [--server http://127.0.0.1:3210]
wxbot send --content-file /path/message.txt
printf '消息内容' | wxbot send

--request-id UUID  使用原标识查询/重试同一正文，避免重复发送
--turn UUID        助手沙箱内使用本轮提供的标识，宿主固定接收账号

首版发送文字（最多 4000 字符），正文保持换行。人工发送需要运行本机消息台。
输出 JSON 回执；仅 status=sent 时退出码为 0，unknown 时先在微信核实。
`;

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) process.stdout.write(HELP);
  else {
    options.text = await readText(options);
    const result = await sendText(options);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status !== 'sent') process.exitCode = result.status === 'unknown' ? 2 : 1;
  }
} catch (error) {
  process.stderr.write(JSON.stringify({ status: 'failed', error: error.message }) + '\n');
  process.exitCode = 1;
}
