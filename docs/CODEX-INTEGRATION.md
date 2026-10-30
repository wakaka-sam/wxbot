# Codex 交互与 wxbot send

## 参考与取舍

参考 botmux `5020a2ef4`：发送能力通过 Skill + CLI 暴露；按会话/轮次确定回复目标；沙箱发送通过宿主代理；会话发送有持久 outbox。该版本已提供 `codex-rpc-engine.ts`，通过 app-server JSON-RPC 提交输入，远程 TUI 可作为查看器；旧的 PTY bracketed-paste、history.jsonl 提交确认路径仍用于终端适配场景。

wxbot 使用 Codex CLI 自带的 `app-server --listen stdio://`，无需增加 PTY/tmux。`CodexClient` 负责 initialize、请求 ID、超时、事件、thread/start、thread/resume、turn/start、turn/interrupt；thread ID 和任务状态由原有 Store 持久化。本机模式普通消息串行，平台模式新输入中断当前轮次后续聊。这次没有改变这些调度语义，也没有启用绕过审批/沙箱的参数。

## 命令与会话上下文

### 图片和文件

助手可使用 `wxbot send --turn <本轮UUID> --image /workspace/chart.png` 或 `wxbot send --turn <本轮UUID> --file /workspace/report.pdf`。每次一张图片、一个文件或一条文字，不混传说明文字；附件限非空、20 MB 以内的普通文件。图片支持 PNG/JPEG/GIF/WebP，其他格式作为文件发送。CLI 在自身执行环境读取字节，不把宿主文件路径交给 relay；宿主验证附件内容和元数据，固定本轮微信绑定。

附件内容与名称、类型一起参与 request-id 去重。平台先持久化附件并登记消息/outbox，再发送到微信；网页历史使用现有所有权校验提供预览和下载。排队附件不依赖原文件或临时 relay 目录，重启后仍可发送。文字和附件共享每次微信输入后的 10 条额度；若附件轮到最后一个额度，先发送第 10 条文字提醒，附件保持排队至下次微信输入。unknown 表示尚未确认发送，不得通过换 request-id 重发。

`package.json` 的 bin 指向 `src/cli.js`。CLI 和 `send-client.js` 仅依赖 Node 内置模块，可以复制到隔离助手中。支持参数正文、stdin、`--content-file`、`--image`、`--file`、`--request-id`。

人工本机调用：读取 `/api/state?profile=…` 的公开绑定身份，再向 `/api/send?profile=…` 提交正文或 `/api/send-media?profile=…` 提交附件字节，并携带 UUID、accountId 和 userId。Bridge 在实际发送前核对绑定并持久化去重回执。发送只针对当前扫码用户，不接受任意联系人。

模型调用：每轮生成一个独立 UUID 和 relay 目录，输入中明确提供 `wxbot send --turn UUID`。本机模式注入工具 PATH，并提供 Node + 绝对脚本路径作为备用入口；平台在助手 home 下安装包装命令（`/home/assistant/.local/bin/wxbot`）和专属 Skill（`/home/assistant/.agents/skills/wxbot-send`）。Skill 位于受保护的 `.codex` 凭据目录之外。不修改全局 Codex 配置或技能。

无需沿 PID 树猜测会话。由于每个执行器已属于确定的连接/助手，宿主持有绑定账号与当前轮次，CLI 仅提交 `{turn, requestId, text}`。拒绝外加账号、URL、profile、宿主文件路径及过期轮次。旧后台任务不能沿用旧标识向新轮次发送。

## 沙箱代发

```text
Codex shell → wxbot send --turn UUID
  → 原子写入 <relayRoot>/<turn>/<requestId>.<attemptId>.req.json
  → 宿主轮询并校验本轮上下文、长度、普通文件（禁止符号链接）
  → 当前连接 Bridge，或平台 Engine → SQLite outbox → Channel → Bridge
  → 写入 .res.json → CLI 返回 JSON 及退出码
```

工具只写自己的轮次目录，不持有微信 token；平台继续使用现有 bubblewrap、systemd 和 Codex 权限策略。本机 Codex 的 workspace-write 只额外允许写当前轮次 relay 目录，未开放命令网络权限。

请求文件只是跨沙箱传输。发送幂等最终依赖 Bridge 回执和平台 outbox。平台将网页消息和 outbox 在同一 SQLite 事务中写入；请求 ID 派生时包含助手和任务 ID，跨助手不会复用回执。CLI 不自动重试未知结果，服务重启后沿用已有投递恢复规则。

已发送、排队中或结果未知的正文按轮次登记，自动最终回复与它完全相同（去除首尾空白）时不再发微信，避免未知结果被新 ID 重发。明确失败时保留自动最终回复。进度消息不会抑制内容不同的最终答案；改写/概括不进行模糊去重。平台公开进度与最终正文均在各自消息完成后投递，避免按空行拆分或在判断重复前先发出半段；仅超出长度上限时分块，网页增量仍实时保存和推送。显式发送也在网页历史中可见。

## 验证与边界

```bash
npm run check
npm test
npm run test:platform
```

新增测试运行真实 CLI 子进程，微信服务和模型使用替身，覆盖多连接、绑定变化、幂等、结果不明、跨轮次拒绝、符号链接拒绝、平台 outbox 恢复和最终回复去重。

Linux 隔离执行器的可选验证脚本为 `scripts/test-platform-send.mjs`：使用临时合成数据和模拟发送回执，实际启动 Codex app-server 并通过 command/exec 在原有沙箱内执行命令；不连接生产微信账号或读取生产聊天历史。运行需要显式设置 `PLATFORM_AGENT_TEST=1` 及测试执行器路径/授权文件。

CLI 人工入口目前针对本机消息台，不能拿平台用户 Cookie 在外部冒充助手发送。平台入口由当前助手执行器持有。不提供任意联系人发送、媒体发送、定时发送或 PTY 接管。

平台不再将工具生命周期状态（查询网页、执行命令、修改文件、调用工具、子代理协作）写入聊天记录或推送网页/微信；旧版本排队中的同类固定提示也会跳过，不占用微信回复额度。助手正常输出的进度、正文以及执行失败和附件处理错误提示继续显示。
