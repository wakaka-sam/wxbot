# wxbot · ClawBot Local

在本机运行的微信 ClawBot 消息台。微信扫码连接后，发给 ClawBot 的消息实时显示在浏览器中。

**微信 → iLink 消息接口 → Node.js 本地服务 → SSE → 浏览器**

基础消息收发无需 OpenClaw 或模型 API Key。开启 Codex 自动回复后，微信新消息会通过本机已登录的 Codex CLI 执行，并将最终回复发回微信。

## 快速安装

当前版本：[v1.0.0](https://github.com/wakaka-sam/wxbot/releases/tag/v1.0.0) · [所有 Releases](https://github.com/wakaka-sam/wxbot/releases)。

需要 [Node.js](https://nodejs.org/) **22.13+**（推荐 24，包含 npm）。Release 是跨平台源码包，无前端构建步骤；不包含 Node.js、Codex CLI 或 npm 依赖，首次安装需要网络。消息台可在 macOS / Linux / Windows 上运行；Codex 的平台要求以其[官方安装说明](https://github.com/openai/codex#installing-and-running-codex-cli)为准。

### 1. 安装并登录 Codex（需要自动回复时）

```bash
npm install -g @openai/codex
codex login
codex login status
```

已有可用且已登录的 Codex CLI 可跳过。启动前确保 `codex --version` 可运行；可用 `CLAWBOT_CODEX_BIN` 指定可执行文件。只使用微信收发时不需要安装 Codex，启动后、扫码前先在页面暂停自动回复（默认开启）。

### 2. 下载并启动

macOS / Linux（在准备存放项目的目录运行）：

```bash
curl -fL https://github.com/wakaka-sam/wxbot/releases/download/v1.0.0/wxbot-v1.0.0.tar.gz -o wxbot-v1.0.0.tar.gz
tar -xzf wxbot-v1.0.0.tar.gz
cd wxbot-v1.0.0
npm ci --omit=dev
npm start
```

Windows PowerShell：

```powershell
Invoke-WebRequest https://github.com/wakaka-sam/wxbot/releases/download/v1.0.0/wxbot-v1.0.0.zip -OutFile wxbot-v1.0.0.zip
Expand-Archive .\wxbot-v1.0.0.zip -DestinationPath .
Set-Location .\wxbot-v1.0.0
npm ci --omit=dev
npm start
```

也可以从 GitHub 克隆（需要 Git）：

```bash
git clone --branch v1.0.0 --depth 1 https://github.com/wakaka-sam/wxbot.git
cd wxbot
npm ci --omit=dev
npm start
```

### 3. 扫码连接微信

打开 **http://127.0.0.1:3210**：

1. 点击「生成登录二维码」，使用微信扫一扫。
2. 在微信中确认连接。如果微信要求数字配对码，在网页中输入手机显示的数字。
3. 给微信里的 ClawBot 发消息；内容会实时显示在网页右侧。自动回复默认开启，新消息进入当前 Codex 会话。
4. 在页面底部「发送到微信」输入文字，点击「发送消息」，消息会发给当前扫码绑定的微信账号。Enter 换行，⌘ / Ctrl + Enter 发送。

二维码过期后可以重新获取。扫码成功后自动开始接收；登录态有效且未暂停时，下次启动自动恢复。
不要让其他 OpenClaw / iLink 客户端同时轮询同一个 Bot，否则可能相互抢收消息。

终端按 `Ctrl+C` 停止。关闭浏览器不会停止服务，重新打开后可以看到离线期间服务收到的消息。

## 校验与升级

每个 Release 附带 `SHA256SUMS.txt`。下载后可计算压缩包 SHA-256，与该文件中的同名条目比较：macOS 使用 `shasum -a 256 wxbot-v1.0.0.tar.gz`，Linux 使用 `sha256sum wxbot-v1.0.0.tar.gz`，Windows 使用 `Get-FileHash .\wxbot-v1.0.0.zip -Algorithm SHA256`。

默认消息、登录态和会话设置保存在安装目录的 `data/`。升级前用 `Ctrl+C` 停止旧实例，并备份该目录；解压新版本到新目录，将旧 `data/` 复制进去，再运行 `npm ci --omit=dev`、`npm start`。不要同时启动新旧实例。也可以从首次安装起通过 `CLAWBOT_DATA_DIR` 指向安装目录之外的固定路径，升级时继续使用同一路径。Codex 历史还依赖本机 Codex 自身的数据目录；跨机器迁移仅复制 `data/` 不能保证续聊。

## 发布构建

维护者从已提交的源码生成包：

```bash
npm ci
npm run check
npm test
npm run release:pack -- HEAD
```

`dist/` 生成 `wxbot-v<版本>.tar.gz`、`wxbot-v<版本>.zip` 和 `SHA256SUMS.txt`。脚本从指定 Git 提交读取版本并按文件清单归档，不复制工作目录的登录态、附件、聊天记录、截图、依赖或环境配置。用户安装 Release 不需要 Git。

## 功能与边界

- 完整扫码状态：获取、等待扫码、手机确认、配对码、节点跳转、过期重试。
- 文字保留换行，按纯文本展示；语音有微信转写结果时显示转写。
- 图片预览，视频播放（取决于浏览器编码支持），文件下载。
- 原始语音以 SILK 附件保存，可下载；不做本地语音转写或 SILK 转码。
- 附件上限 20 MB。下载失败显示原因，消息文字仍然保留；当前没有附件自动重试功能。
- 网络故障自动退避重连，登录失效提示重新扫码；支持暂停接收与退出登录。
- SQLite 保存消息和同步游标，按账号和消息 ID 去重。完整保留超出 JavaScript 安全整数范围的消息 ID。
- 搜索、文字/附件筛选、复制、自动跟随、JSON 导出、清空本地记录。
- 页面显示最近 500 条；导出包含全部记录。历史消息不会自动过期。
- 清空时删除本地记录和附件，但保留去重回执，防止上游重放让已清空消息重新出现。
- 仅接收当前扫码绑定用户的完整入站消息；过滤机器人回复。主要面向个人 ClawBot 会话。

## ClawBot → Codex 持续会话

先确认本机 `codex --version` 可用，且 `codex login status` 显示已登录；未登录时先运行 `codex login`。沿用本机 Codex 的登录与默认模型，不需要在网页粘贴凭证。

```text
微信新消息 → SQLite 持久化队列 → codex app-server（stdio JSON-RPC）
          → thread/start 或 thread/resume → turn/start
          → 页面显示处理进度 → 最终回复分段发送到微信
```

- 默认开启自动回复；网页「Codex 持续会话」区域可暂停/开启、停止任务、新建会话、设置工作目录和模型。
- 默认工作目录是启动服务时的目录，页面显示完整路径；可在空闲时修改。更换工作目录会新建会话；留空模型沿用本机 Codex 配置。
- 每个扫码 Bot + 微信用户单独保存 Codex `threadId`。连续消息沿用同一会话；服务或 CLI 进程重启后通过 `thread/resume` 续聊。
- 新收到的消息和任务队列在同一 SQLite 事务中提交。每条消息只入队一次；历史消息、机器人回声、手工从网页发往微信的消息不会再次交给 Codex。
- 消息串行执行，任务期间发来的普通消息排队，不会混入当前轮次。过程说明在网页显示，最终回复自动回传微信。
- 图片作为 `localImage` 输入，文件使用已下载的本地路径；语音有转写时使用转写，否则作为原始文件附件。
- Codex 运行时获取微信 typing_ticket 并每 8 秒续期「正在输入」，完成、失败、停止或退出时取消；状态接口失败不会打断任务，页面会提示。该状态由微信客户端展示，接口成功不等于手机已确认显示。
- 在微信要求 Codex「生成文件并发给我」，Codex 可通过最终回复附件指令交付文件；系统暂存副本后上传微信 CDN，再发送真实媒体消息。每轮最多 5 个附件，每个最多 20 MB，仅允许当前工作目录中的文件，禁止读取 ClawBot 内部数据目录（已下载媒体除外）。文件路径不会自动触发发送，只有明确附件指令生效。
- 长回复自动分段，页面保存完整结果。微信发送失败不会重新执行 Codex 任务，可以从页面复制结果后手动发送。
- 运行中的任务如果因服务退出而中断，不自动重跑可能有副作用的操作；保留会话，收到下一条指令后继续。已经生成但未回传的结果会在重启后继续回传，按固定发送 ID 防重。
- 恢复旧会话失败时明确报错，不会悄悄切到空白会话。
- 默认 `workspace-write` 沙箱、`never` 提权审批：Codex 可以在指定工作目录内执行命令和改文件，额外权限请求不会自动放行。需要补充信息时通过下一条微信消息继续。不会修改本机全局 Codex 配置。
- 暂停自动回复会停止当前任务并取消排队；期间收到的消息仍展示，但重新开启后不会追溯执行。
- 清空页面记录会清理本地消息、处理记录和附件；Codex 自身的会话历史仍由本机 Codex 保存。要开始无旧上下文的对话，请使用「新建会话」或 `/new`。

微信控制指令：

| 指令 | 作用 |
| --- | --- |
| 直接发文字/图片/文件 | 在同一个 Codex 会话中继续 |
| `/new` | 停止当前任务、取消之前排队的消息，下一条消息创建新会话 |
| `/stop` | 停止当前任务、取消之前排队的消息，保留上下文 |
| `/status` | 查看会话 ID、工作目录和排队状态 |
| `/help` | 查看使用说明 |

自动回复暂停时，微信控制指令也只作为普通消息展示；可在本地页面重新开启。

## 发送消息

- 支持发送文字（每条最多 4000 个字符）、图片、文件和 MP4 视频（单个最多 20 MB）。在页面底部选择附件和发送方式；自动识别 PNG/JPEG/GIF/WebP 图片及 MP4 视频，其他格式按文件发送，也可以强制作为文件发送。文字和附件分别发送。
- 接收方固定为当前扫码绑定的微信账号，网页不能指定其他联系人。
- 微信发来消息时保存最新 `context_token`，发送时自动携带；按当前协议，没有会话凭证时也会尝试发送。如果微信提示会话失效，请先在微信向 ClawBot 发一条消息，再重试。
- 记录区区分本机发送与微信接收，并展示发送中、已发送、发送失败或结果待确认。「已发送」表示微信接口接受请求，不代表已读。
- 发送失败保留输入。网络中断不会自动重发；网页可以用同一请求标识查询结果，服务器不会重复提交。结果不明时先在手机微信确认，再决定是否重新发送。
- 服务在发送过程中退出，重启后将未完成记录标记为「结果待确认」。
- 暂停接收时仍可向已有账号发送文字和附件；退出登录后不能发送。
- 清空记录保留不含消息正文的发送去重回执（请求标识、正文哈希、状态），避免浏览器重试把已清空的消息重复发出。

## 本地数据

默认保存到项目的 `data/`，已加入 `.gitignore`：

```text
data/
  clawbot.sqlite      # 登录凭证、消息、游标、去重记录
  clawbot.sqlite-wal  # SQLite 运行时文件（如存在）
  clawbot.sqlite-shm
  media/             # 已解密附件，随机文件名
```

数据库包含登录 token，请勿分享或提交。POSIX 系统数据目录权限为 `0700`，数据库和附件为 `0600`；Windows 的访问范围以用户目录 ACL 为准。token 保存在本机数据库，未另行加密，也不会发送给网页。退出登录会移除活动凭证；历史消息仍可查看。

服务仅监听 `127.0.0.1`，校验 Host / Origin，禁止第三方网页跨站调用，不向局域网暴露。页面资源均在本地，无外部字体或统计。开启自动回复后，Codex CLI 会使用当前登录账号访问其配置的模型服务。消息按纯文本渲染，HTML 不会执行。

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `PORT` | `3210` | 本机 HTTP 端口 |
| `CLAWBOT_DATA_DIR` | 项目下 `data/` | 数据存储目录 |
| `WEIXIN_ROUTE_TAG` | 未设置 | 特定微信环境需要的路由标记 |
| `CLAWBOT_CODEX_BIN` | PATH 中的 `codex` | Codex 可执行文件路径 |
| `CLAWBOT_CODEX_CWD` | 启动时目录 | 首次启动的工作目录，保存网页设置后以设置为准 |

macOS / Linux：

```bash
PORT=3211 CLAWBOT_DATA_DIR="$HOME/.clawbot-local" npm start
```

Windows PowerShell：

```powershell
$env:PORT = "3211"
$env:CLAWBOT_DATA_DIR = "$env:USERPROFILE\.clawbot-local"
npm start
```

不要同时启动多个使用相同数据目录的实例。Node.js 的 `node:sqlite` 可能输出 ExperimentalWarning，这是运行时提示。

## 开发与验证

```bash
npm run dev     # 后端改动自动重启，前端改动刷新页面即可
npm run check   # 语法检查
npm test        # 使用临时目录与模拟微信接口，不访问个人微信
```

新增测试验证图片/视频/文件上传、AES 密文与 MD5、大小及类型校验、重复请求、上传失败与发送结果未知、typing 续期/取消/失败降级、Codex 附件回传与重复恢复、越界及凭证目录保护。

集成测试涵盖扫码、SSE 实时消息、64 位消息 ID、去重和消息过滤、游标持久化、暂停/恢复、重连、登录过期、跨站保护、附件解密和清空，以及发送载荷、上下文更新、重复请求、错误状态和发送中断恢复。

真实端到端验收：扫码确认 → 用微信发送一条包含换行的消息 → 网页即时出现 → 刷新网页仍在 → 重启服务后再次发送，确认自动恢复。测试中的模拟微信接口不能替代手机扫码后的真实验收。

## 项目结构

```text
src/server.js     本地 HTTP 服务、API、SSE、静态资源
src/weixin.js     微信 iLink 协议客户端
src/bridge.js     扫码、接收、重连与消息转换
src/store.js      SQLite 存储与事务
src/media.js      附件下载、大小限制、AES 解密、Codex 产物暂存
public/          原生 HTML / CSS / JavaScript 界面，无构建步骤
src/codex-client.js  Codex 子进程、JSON-RPC、轮次事件与取消
src/codex-manager.js 会话绑定、持久化队列、微信控制指令与回复回传
test/            Node.js 内置测试框架的集成测试
```

## 验证 Codex 上下文

1. 微信发送「记住验证词是松树灯塔731，只回复已记住」。
2. 收到回复后，再发送「刚才的验证词是什么」。
3. 重启服务，继续问同一问题。页面应显示相同的会话 ID。
4. 发送 `/new` 后再提问，页面应在下条普通消息到来时生成新的会话 ID。

`npm test` 不调用真实模型；另已用当前机器的真实 Codex CLI 验证进程重启后恢复上下文。运行自动回复会消耗当前 Codex 账号用量。

## 实现参考

参考 [yulate/weixin-clawbot-for-all](https://github.com/yulate/weixin-clawbot-for-all) 的协议流程（检视提交 `a1cf076690023ad7c49c12b03786bee2b23f065b`），并对照腾讯发布的 [`@tencent-weixin/openclaw-weixin`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin) **2.4.10** 源码核对扫码 POST、配对码、IDC 跳转、协议头和媒体字段。业务逻辑与界面独立实现，不依赖或运行上述项目。

协议版本兼容字段集中在 `src/weixin.js`；微信接口发生变化时可能需要更新适配。

持续会话参考本机 botmux（检视提交 `867f9ef4c220346bdd22faae14125fce5eb871b5`）的 `src/codex-app-runner.ts`、`src/adapters/cli/codex.ts` 和 `src/services/codex-bridge-queue.ts`：持久化 CLI 会话 ID、串行输入、只回传对应轮次的最终回复。协议按 [Codex app-server 文档](https://learn.chatgpt.com/docs/app-server) 和本机 CLI 生成的 JSON Schema 校验；不依赖或修改 botmux。


开发约定：Codex 仅在用户要求交付产物时，在最终回复中独立输出 `[[clawbot-send:/绝对路径]]`。桥接层移除该行并发送附件，普通 Markdown 链接不会上传文件。文字回复与每个附件各自使用稳定请求 ID；上传失败记为失败，消息提交后连接中断记为结果待确认，不自动重新提交。

媒体上传和输入状态实现对照 [腾讯上传源码](https://github.com/Tencent/openclaw-weixin/blob/main/src/cdn/upload.ts) 与 [API 源码](https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts)。20 MB 是本项目限制，并非声明微信平台最大上限。视频不转码；需要微信客户端支持对应 MP4 编码。
