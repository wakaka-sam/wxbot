# Grok 订阅视频生成

`grok-video` Skill 使用官方 Grok Build CLI 的 `image_gen` 与 `image_to_video` 工具。文字先生成首帧再生成视频；用户提供参考图时直接图生视频。该路径使用已登录账号的订阅额度，不调用需要 API Key 的视频接口。

## 助手使用

对 wxbot 助手说“用 Grok 生成一段纸船漂流的视频”，或发送 PNG/JPEG 并要求制作视频。助手会读取 [Skill](../skills/grok-video/SKILL.md)，提交任务、查询状态、下载真实 MP4，再通过 `wxbot send --file` 回传。当前支持 6/10 秒、480p/720p，参考图和回传文件均不超过 20 MB。微信接收的是文件；尚未增加视频卡片预览。

每轮分别提供视频调用标识和微信发送标识，不能混用。视频任务 ID 跨聊天轮次保留，同 ID、同参数不会重复生成；用户打断聊天后可以继续查询。平台进程重启或执行器关闭时，不自动重提未完成任务，以免重复消费额度。状态 `unknown` 必须先核实，不能声称生成成功。

## SG 配置

在 `/etc/wxbot-platform.env` 配置：

```dotenv
PLATFORM_GROK_BIN=/usr/local/bin/grok
PLATFORM_GROK_AUTH=/root/.config/wxbot-platform/grok/auth.json
```

登录文件必须来自用户授权使用的 Grok CLI 订阅登录，保存在宿主专用目录，目录 0700、文件 0600；不得写入仓库或助手可读目录。需要重新登录时，用单独的运维 HOME 执行 `grok login --device-auth`，然后把其 `.grok/auth.json` 原子更新到上述路径。不要在助手会话里索要密码或令牌，也不要覆盖其他用途的 Grok 登录和配置。

任务串行执行，避免并发刷新共享订阅登录；每个助手最多两个未完成任务。所有助手共用该订阅的额度。Grok CLI 刷新后的登录会保存在宿主配置中。当前实际验证版本为 Grok Build 1.0.13。

## 隔离与持久化

- Codex 助手只接触任务请求及视频字节，通过当前轮次的文件 relay 调用；不读取 Grok 凭据。relay 使用目录文件描述符和拒绝符号链接的文件打开方式，防止助手路径指向宿主文件。
- 每个助手的任务保存在其宿主 `harness/video-jobs/<UUID>`，不同助手只能查询自己的任务。登录副本、Grok 会话及生成文件不挂载到 Codex 工作区。
- Grok 工作进程用 bubblewrap 隔离，只挂载系统运行库、独立 HOME、独立工作目录；不加载助手的项目配置。只开放图像/视频生成工具，禁用子代理和网页工具。systemd 限制 1 GB 内存、1 CPU、192 个任务；10 分钟超时。
- 不转发 Grok 的内部推理或原始工具输出。只返回任务状态和下载结果，任务完成后可下载到 Codex `/workspace`。

## 验证

```bash
node --test test/platform/grok-video.test.js
PLATFORM_AGENT_TEST=1 node --env-file=/etc/wxbot-platform.env scripts/test-platform-grok-video.mjs
# 额外消费一次订阅生成额度，运行真实生成验收：
PLATFORM_AGENT_TEST=1 PLATFORM_GROK_GENERATION_TEST=1 \
  node --env-file=/etc/wxbot-platform.env scripts/test-platform-grok-video.mjs
```

后两项需在 SG 执行，创建临时隔离助手，不读取生产会话、不实际给微信发送测试消息。第一项真实 CLI 沙箱验收使用模拟视频生成器；第二项实际调用 Grok 生成视频，并经过助手命令、跨轮查询、下载和发送 relay 验证。

官方说明：[Grok Build 媒体命令](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/04-slash-commands.md)、[Headless CLI](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/14-headless-mode.md)。
