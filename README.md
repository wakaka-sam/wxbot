# wxbot · ClawBot Workspace

微信 ClawBot 消息台与多用户 AI 助手平台。支持微信扫码接入、网页聊天、持久 Codex 会话和实时输出，无需运行 OpenClaw。

当前版本：[v1.0.1](https://github.com/wakaka-sam/wxbot/releases/tag/v1.0.1) · [更新记录](CHANGELOG.md) · [平台部署与适配器接口](docs/PLATFORM.md)

## 选择运行模式

| 模式 | 启动命令 / 默认端口 | 适合场景 | 系统要求 |
| --- | --- | --- | --- |
| 注册登录版助手平台 | `npm run platform` / `3211` | 多用户登录、助手管理、网页与微信续聊、管理员查看历史 | Linux + bubblewrap + Codex |
| 本机消息台 | `npm start` / `3210` | 单个部署者管理多个微信连接、收发附件、Codex 执行代码 | macOS / Linux / Windows；自动回复需 Codex |

两个入口使用独立数据目录，可以同时运行；同一个微信 Bot 不应同时交给两个入口轮询。本机消息台的「用户」是连接配置，不等于助手平台的注册账号。

基础微信消息收发无需模型 API Key；AI 功能使用部署方已登录的 Codex CLI 及其模型额度。

## 注册登录版助手平台

新增独立平台入口：`npm run platform`，默认端口 **3211**。提供账号注册登录、每人最多 3 个激活助手、网页与微信共享 Codex 会话、实时输出、中断续聊、扫码问候/最近十条总结，以及管理员用户与历史视图。微信 Channel 与 AI Harness 分别封装，方便替换。

- 每个助手拥有独立持久会话；网页输入、微信输入、历史记录与实时输出在同一会话中汇合。绑定微信后，网页用户消息也以 `[User]: 消息内容` 同步到 ClawBot，助手公开输出按完整消息回传，保留空行，仅超长消息分块。
- 平台每次微信用户输入后最多连续回传 10 条，第 10 条附上继续对话提醒；超额内容排队至下一条微信输入，完整输出可在网页查看。“正在执行命令…”不再推送微信。网页消息同步与 `wxbot send` 共用额度，重启不清零。
- 助手内置 `grok-video` Skill：管理员配置订阅版 Grok Build 登录后，可生成视频或将 PNG/JPEG 图片转成视频，跨聊天轮次查询任务并下载 MP4，通过现有文件通道回传微信。无需 xAI API Key，调用共用所配置账号的订阅额度。见 [Grok 视频接入](docs/GROK-VIDEO.md)。
- 新输入中断当前生成后继续；扫码新助手发送问候，有历史时额外总结最近十条正文消息。
- 激活第四个助手时明确选择停止哪个，历史保留；管理员可只读查看所有用户的助手及对话。
- 微信 Channel 与 Codex Harness 解耦，可分别接入其他聊天渠道或 AI 执行器。

下载并安装依赖后，按 [平台部署文档](docs/PLATFORM.md#部署) 配置管理员密码、Codex 登录和 bubblewrap，再运行 `npm run platform`，访问 **http://127.0.0.1:3211**。首次启动必须配置 `PLATFORM_ADMIN_PASSWORD`，没有默认管理员密码。systemd 模板与环境变量示例在 [`deploy/`](deploy/)。

平台支持 ClawBot 图片理解，以及 UTF-8 文本、PDF、DOCX、XLSX 附件内容提取；网页历史支持图片预览和附件下载，网页上传尚未开放。已开放实时搜索、公网读取、Playwright 浏览器、命令/代码执行、工作目录文件操作、本地技能和子代理；按助手隔离文件、工具凭据、联网和系统资源。外部账号应用/远程插件尚需单独授权接入。原 3210 消息台继续保留原能力，已有连接和账号不会自动迁移至新平台。

## 本机消息台快速安装

当前版本：[v1.0.1](https://github.com/wakaka-sam/wxbot/releases/tag/v1.0.1) · [所有 Releases](https://github.com/wakaka-sam/wxbot/releases)。

需要 [Node.js](https://nodejs.org/) **22.13+**（推荐 24，包含 npm）。Release 同时包含两个入口的源码，无前端构建步骤；不包含 Node.js、Codex CLI、bubblewrap 或 npm 依赖，首次安装需要网络。以下步骤启动 3210 本机消息台，可在 macOS / Linux / Windows 上运行；3211 助手平台需要 Linux。Codex 的平台要求以其[官方安装说明](https://github.com/openai/codex#installing-and-running-codex-cli)为准。

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
curl -fL https://github.com/wakaka-sam/wxbot/releases/download/v1.0.1/wxbot-v1.0.1.tar.gz -o wxbot-v1.0.1.tar.gz
tar -xzf wxbot-v1.0.1.tar.gz
cd wxbot-v1.0.1
npm ci --omit=dev
npm start
```

Windows PowerShell：

```powershell
Invoke-WebRequest https://github.com/wakaka-sam/wxbot/releases/download/v1.0.1/wxbot-v1.0.1.zip -OutFile wxbot-v1.0.1.zip
Expand-Archive .\wxbot-v1.0.1.zip -DestinationPath .
Set-Location .\wxbot-v1.0.1
npm ci --omit=dev
npm start
```

也可以从 GitHub 克隆（需要 Git）：

```bash
git clone --branch v1.0.1 --depth 1 https://github.com/wakaka-sam/wxbot.git
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

## 命令行发送：`wxbot send`

在项目目录运行 `npm link` 后可使用 `wxbot` 命令；也可以直接运行 `node src/cli.js send`，无需全局安装。首版支持发送文字（最多 4000 个 UTF-16 字符），`--content-file` 读取 UTF-8 正文，不是发送文件附件。

本机操作需要先启动 3210 消息台并扫码连接：

```bash
wxbot send '任务完成'
wxbot send --profile <连接ID> --content-file /path/message.txt
wxbot send --image /path/chart.png
wxbot send --file /path/report.pdf
wxbot send --server http://127.0.0.1:3210 <<'EOF'
第一行
第二行
EOF
```

默认连接为 `default`，可通过 `--profile` 或 `WXBOT_PROFILE` 选择；服务地址支持 `--server` 或 `WXBOT_SERVER`，只接受本机 HTTP。命令复用服务端账号、发送记录和去重回执，不直接读取微信登录 token，也不启动额外的微信轮询。

命令输出 JSON，包含 `requestId`、`id`、`status` 和可能的 `error`。只有 `sent` 返回退出码 0，表示微信接口接受请求；`unknown` 返回 2，其他失败返回 1。结果不明时先检查微信；可用相同 `--request-id <UUID>` 和完全相同正文再次获取回执，不能换标识盲目重发。连接切换或重新绑定后不要重试旧请求。

两种模式的 Codex 会话都可主动发送：平台在助手自己的目录安装 `wxbot-send` Skill 和 `wxbot` 包装命令，本机模式通过开发者指令和 PATH 提供命令。每轮输入提供 `wxbot send --turn <本轮UUID>`；宿主只向这一轮绑定的微信用户代发，轮次结束后标识失效。该通道不需要助手访问宿主 HTTP 或持有微信凭证。平台发送同时保存到网页历史与 SQLite outbox；完全相同的最终回复不会再次发往微信，其他最终回复仍自动发送。平台公开进度与最终答案均在各自消息完成后投递，连续换行保留在同一条消息中，仅超过 1200 个 Unicode 字符时分块；网页继续实时显示增量。

支持 `wxbot send --turn <本轮UUID> --image /workspace/chart.png` 或 `--file /workspace/report.pdf` 发送真实附件。每次一张图片或一个文件，非空且最多 20 MB；图片支持 PNG/JPEG/GIF/WebP，其他格式用 `--file`，说明文字另发。附件会持久化到平台历史，图片可预览、文件可下载；超过微信回复额度时保留排队，原工作文件删除或服务重启后仍可续发。若最后一个额度轮到附件，先用第 10 条发送文字提醒，附件等待下一条微信输入。

详见 [Codex 交互与发送通道](docs/CODEX-INTEGRATION.md)。

## 连接管理页面

打开 **http://127.0.0.1:3210/connections**，或从消息收件箱左侧点击「所有连接管理」。

- 概览显示全部连接、正在接收和需要处理的账号，每 3 秒自动同步；支持按在线/暂停/待处理筛选，以及按名称或账号标识搜索。
- 「新增连接」创建独立用户并获取二维码，手机扫码后可以直接在页面输入数字配对码。连接详情实时更新扫码、确认、过期和错误状态，并可刷新二维码。
- 每张账号卡片可重命名、暂停/恢复接收、查看详情、打开对应消息收件箱，或确认后断开连接。详情面板可单独开启/暂停该账号的自动回复。
- 服务失联时保留上次状态并明确提示，管理操作暂时禁用；恢复连接后继续同步。页面适配桌面和手机。

页面沿用现有本机访问限制。远程使用时先通过 SSH 转发服务端口，再在自己的浏览器打开上述地址。列表只返回账号状态和消息数量，不返回消息正文或登录凭证；消息内容在各账号收件箱中查看。

## 多连接配置（3210 本机消息台）

消息台支持最多 50 个用户同时连接微信。左侧选择「新增用户」，填写便于识别的名称，再为该用户生成二维码，由对应的微信账号扫码。可以切换用户和重命名；切换页面不会暂停其他用户收发。

- 每个用户分别保存微信登录态、消息、附件、去重记录、Codex 配置、任务队列及会话；不同用户可同时执行任务，同一用户的消息仍串行处理。
- 发送、导出、清空记录、暂停接收、退出登录和 Codex 控制仅作用于当前选中的用户。未发送的文字、附件选择和待确认发送按用户保留在当前页面，刷新页面后不保留草稿。
- 旧版本的账号和数据原地保留为「默认用户」，无需重新扫码；新用户使用独立的数据库和初始工作目录。服务重启后恢复全部用户，已暂停的用户保持暂停。
- 同一微信 Bot 不能同时绑定两个在线用户；已绑定过的用户只能重新登录原账号，换账号请新增用户，防止历史记录混用。需要停用某用户时选择该用户并退出登录，记录仍保留。
- 网页继续仅限本机访问，是管理所有账号的管理员控制台，没有提供按用户登录的网页权限控制。各用户共用本机 Codex 登录和系统账号；独立工作目录属于数据与会话组织方式，不是操作系统级安全隔离。不应作为互不信任用户的公共托管服务。

数据目录结构：

```text
data/
  clawbot.sqlite           # 默认用户；settings 中保存用户列表
  media/                   # 默认用户附件
  profiles/<用户ID>/
    clawbot.sqlite         # 该用户登录态、消息、会话与任务
    media/                 # 该用户附件
  workspaces/<用户ID>/     # 新用户的初始 Codex 工作目录
```

备份或迁移时复制整个数据目录，并备份网页中另行配置的工作目录及 Codex 自身的会话数据。默认用户原有的工作目录保持不变。

HTTP 接口仍需本机 Host/Origin 校验，POST 仍需 `X-Clawbot-Local: 1`。所有用户相关 API、SSE、媒体和导出请求通过 `?profile=<用户ID>` 指定用户，省略时兼容旧版默认用户；未知 ID 返回 404，不回落到其他账号。`GET /api/profiles` 获取用户列表，`POST /api/profiles` 携带 `{ "name": "用户名称" }` 创建用户，`POST /api/profile?profile=<用户ID>` 使用同样的请求体重命名。浏览器地址也保存当前用户 ID，刷新后继续显示该用户。

多用户回归测试覆盖并发扫码与任务、账号去重、会话恢复、旧数据兼容、发送目标校验、附件/导出/清空范围，以及跨站防护。

## 校验与升级

每个 Release 附带 `SHA256SUMS.txt`。下载后可计算压缩包 SHA-256，与该文件中的同名条目比较：macOS 使用 `shasum -a 256 wxbot-v1.0.1.tar.gz`，Linux 使用 `sha256sum wxbot-v1.0.1.tar.gz`，Windows 使用 `Get-FileHash .\wxbot-v1.0.1.zip -Algorithm SHA256`。

默认消息、登录态和会话设置保存在安装目录的 `data/`。升级前用 `Ctrl+C` 停止旧实例，并备份该目录；解压新版本到新目录，将旧 `data/` 复制进去，再运行 `npm ci --omit=dev`、`npm start`。不要同时启动新旧实例。也可以从首次安装起通过 `CLAWBOT_DATA_DIR` 指向安装目录之外的固定路径，升级时继续使用同一路径。Codex 历史还依赖本机 Codex 自身的数据目录；跨机器迁移仅复制 `data/` 不能保证续聊。

平台升级还需停止 `wxbot-platform`，备份完整 `PLATFORM_DATA_DIR`（包含数据库、微信凭证和各助手的 Codex 会话文件），在新目录安装依赖并更新 systemd 的项目路径后再启动。保留原环境配置和数据目录，不能仅复制 SQLite 或 thread ID。`v1.0.0` 本机消息台升级后，原账号与记录保留为默认连接；不会自动变成注册用户。

## 发布构建

维护者从已提交的源码生成包：

```bash
npm ci
npm run check
npm test
npm run test:platform
npm run release:pack -- HEAD
```

`dist/` 生成 `wxbot-v<版本>.tar.gz`、`wxbot-v<版本>.zip` 和 `SHA256SUMS.txt`。脚本从指定 Git 提交读取版本并按文件清单归档，不复制工作目录的登录态、附件、聊天记录、截图、依赖或环境配置。用户安装 Release 不需要 Git。

推送 `vX.Y.Z` 标签会触发 [Release 工作流](.github/workflows/release.yml)：核对标签与包版本、运行语法检查及两组测试、生成源码包与 SHA-256，再用 GitHub Actions 的仓库令牌创建 Release。先以草稿上传完整附件，成功后公开；已公开版本不会被覆盖。发布说明取自对应 CHANGELOG 段落。工作流失败时可重跑，或在 Actions 页手动输入已有标签补发。

## 本机消息台功能与边界

- 完整扫码状态：获取、等待扫码、手机确认、配对码、节点跳转、过期重试。
- 文字保留换行，按纯文本展示；语音有微信转写结果时显示转写。
- 图片预览，视频播放（取决于浏览器编码支持），文件下载。
- 原始语音以 SILK 附件保存，可下载；不做本地语音转写或 SILK 转码。
- 附件上限 20 MB。下载失败显示原因，消息文字仍然保留；接收附件的下载不会自动重试。
- 网络故障自动退避重连，登录失效提示重新扫码；支持暂停接收与退出登录。
- SQLite 保存消息和同步游标，按账号和消息 ID 去重。完整保留超出 JavaScript 安全整数范围的消息 ID。
- 搜索、文字/附件筛选、复制、自动跟随、JSON 导出、清空本地记录。
- 页面显示最近 500 条；导出包含全部记录。历史消息不会自动过期。
- 清空时删除本地记录和附件，但保留去重回执，防止上游重放让已清空消息重新出现。
- 仅接收当前扫码绑定用户的完整入站消息；过滤机器人回复。主要面向个人 ClawBot 会话。

## 本机消息台：ClawBot → Codex 持续会话

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
- 发送媒体时，CDN 网络异常、5xx 或缺少下载参数会在同一上传地址最多尝试 3 次，4xx 立即失败；消息提交结果未知时不会自动重发。本机 Codex 的最终附件发送失败会另发明确提示，未知结果则提示检查是否收到；提示也经过回执去重，微信自身不可用时仍可能无法送达。上传日志只记录次数、状态码和耗时，不含凭证或文件内容。
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
npm test        # 本机消息台回归测试
npm run test:platform  # 平台权限、激活配额、会话、中断及微信适配器测试
```

新增测试验证图片/视频/文件上传、AES 密文与 MD5、大小及类型校验、重复请求、上传失败与发送结果未知、typing 续期/取消/失败降级、Codex 附件回传与重复恢复、越界及凭证目录保护。

集成测试涵盖扫码、SSE 实时消息、64 位消息 ID、去重和消息过滤、游标持久化、暂停/恢复、重连、登录过期、跨站保护、附件解密和清空，以及发送载荷、上下文更新、重复请求、错误状态和发送中断恢复。

真实端到端验收：扫码确认 → 用微信发送一条包含换行的消息 → 网页即时出现 → 刷新网页仍在 → 重启服务后再次发送，确认自动恢复。测试中的模拟微信接口不能替代手机扫码后的真实验收。

## 项目结构

```text
src/server.js     本地 HTTP 服务、API、SSE、静态资源
src/profiles.js   用户列表、独立账号运行实例与旧数据兼容
src/weixin.js     微信 iLink 协议客户端
src/bridge.js     扫码、接收、重连与消息转换
src/store.js      SQLite 存储与事务
src/media.js      附件下载、大小限制、AES 解密、Codex 产物暂存
public/          原生 HTML / CSS / JavaScript 界面，无构建步骤
src/codex-client.js  Codex 子进程、JSON-RPC、轮次事件与取消
src/codex-manager.js 会话绑定、持久化队列、微信控制指令与回复回传
src/platform/    账号、权限、助手调度、持久任务和 HTTP/SSE API
src/platform/adapters/  微信 Channel 与 Codex Harness
public/platform/ 注册、登录、聊天、扫码和管理员页面
deploy/          systemd 单元与不含真实凭证的环境变量模板
docs/PLATFORM.md 平台部署、运行边界及扩展接口
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
