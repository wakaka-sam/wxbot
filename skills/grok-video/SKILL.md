---
name: grok-video
description: 使用已登录订阅的 Grok Build CLI 生成视频或让 PNG/JPEG 图片动起来，下载真实 MP4 并通过 wxbot 回传。用于用户明确要求视频生成、图生视频或 Grok Imagine 视频的任务。
---

# Grok 视频生成

使用 `grok-video` 命令，平台在独立执行环境调用订阅版 Grok CLI。无需 xAI API Key；不要切换到付费 API、读取宿主登录文件或要求用户把密码/令牌发进会话。

每轮输入会提供 `Grok 视频调用标识：grok-video --turn <UUID>`。该标识与 `wxbot send` 的标识不同；每条命令使用当前轮次的对应标识。

## 生成并查询

将视频描述写入 `/workspace` 的 UTF-8 文件，用新的 UUID 标识一次生成意图，并把任务 ID 留在上下文中：

```bash
cat > /workspace/video-prompt.txt <<'EOF'
纸船在平静的湖面缓缓漂动，柔和晨光，横屏，无字幕。
EOF
grok-video generate --turn <视频调用标识> --request-id <任务UUID> --prompt-file /workspace/video-prompt.txt --duration 6 --resolution 480p
grok-video status <任务UUID> --turn <本轮视频调用标识>
```

- 默认 6 秒、480p；CLI 支持 6/10 秒和 480p/720p，用户明确要求更长或更清晰时再调整。横竖屏、声音、镜头要求写入描述，不承诺接口未支持的精确参数。
- 图生视频在生成命令追加 `--image /workspace/参考图.png`，支持 PNG/JPEG，最多 20 MB。只传用户指定的参考图。
- 状态为 `queued` / `running` 时，每隔约 10 秒查询同一任务；不要用新 ID 重复生成。用户中断当前聊天后，可在下一轮用新调用标识查询原任务 ID。
- `complete` 才表示已经取得真实 MP4。`failed` / `unknown` / `cancelled` 应据实告知；超时、结果未知、重启后不自动重提任务，以免重复消耗订阅额度。
- 同一任务 ID、相同描述和参数是幂等的；不同助手不能查询对方的任务。生成任务共用平台配置的 Grok 订阅额度，并在服务器串行执行。

## 下载和回传

```bash
grok-video download <任务UUID> --turn <本轮视频调用标识> --output /workspace/result.mp4
wxbot send --turn <本轮微信发送标识> --file /workspace/result.mp4
```

下载路径必须尚不存在。下载后可用 `ffprobe` 检查时长与编码；只有实际下载并验证后才能说视频已生成。回传受现有 20 MB 文件限制及微信每轮 10 条回复额度约束。视频目前按文件发送，不承诺微信内的视频卡片预览；投递状态不明时查询原回执，不换发送 ID 盲目重发。未连接微信时保留工作区文件并说明状态，不编造下载链接。
