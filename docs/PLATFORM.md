# ClawBot 多用户助手平台 · v1.0.1

平台与原本机工作台独立运行：`npm run platform` → 3211，`npm start` → 3210。SQLite、微信凭证、Codex 会话均使用不同目录。旧连接不自动迁移；同一个微信 Bot 不要同时由旧工作台和新平台轮询。

## 使用

1. 注册账号（用户名 3–32 位、密码 10–128 位）或登录。普通注册不能指定管理员角色。
2. 新建助手，默认尝试激活。每个用户最多同时激活三个；第四个弹窗要求选择停止哪个，取消则第四个保留为停止状态。最多保存 50 个助手。
3. 网页直接聊天；点「连接微信」生成真实 iLink 二维码，必要时填写手机上的数字配对码。网页与微信共享一个持久 Codex thread。
4. 新助手扫码后发送问候；有历史的助手先问候，再总结最近十条 user/assistant 正文消息（最多十条消息，并非十轮；不包含进度、问候、历史总结）。上游拒绝主动发送时，网页保留消息并显示投递失败，可先从微信发来一条消息建立回复上下文。
5. 生成中继续输入，会调用 `turn/interrupt`，待原轮次结束，再在同一个 thread 上 `turn/start`；不是新开会话。也可以单独「停止回复」。
6. 绑定微信后，网页发送的用户消息也会同步到 ClawBot，格式为 `[User]: 消息内容`；长消息分段且每段保留前缀。微信原生输入不会重复回显，模型与网页历史仍保留用户原文。网页通过 SSE 即时显示可见回复的增量。微信按自然段和完成的消息依序发送，长段会分块。包括公开进度与最终回复，不包含内部推理、工具原始输出或凭证。
7. 停止助手会停止微信轮询和执行器，保留历史、配对凭证及 thread；再次激活恢复。每个助手一旦绑定微信，只允许重新绑定原微信身份，避免将历史发送给别的用户。
8. 管理员「用户与会话」可查看所有注册用户、助手、历史和实时输出。别人的助手为只读，不能冒充用户发消息、扫码、停止或改名。查看历史记录审计事件。

网页用户消息、模型任务与微信同步投递在同一事务落库，请求重试不会重复入队。用户同步消息排在本轮助手输出之前；已绑定助手断线或退出连接后，新消息仍按原绑定身份排队，重连后继续发送。首次绑定微信之前的历史不自动全文补发，仍通过重连问候/最近十条总结回顾。微信拒收或发送结果未知时保留错误状态，不自动重复执行模型。

平台 ClawBot 每次收到一条新的微信用户消息后，最多连续发送 10 条消息；网页输入、重连、重启和历史重放不会刷新额度。自动回复、问候、网页 `[User]:` 同步以及 `wxbot send` 共用额度。第 10 条正文会附加提醒，提示用户在微信发送“继续”等新消息；未发送的内容留在 outbox，收到新的微信输入后按原顺序续发，网页输出不受限。命令活动提示“正在执行命令…”只在网页显示，不再发送到微信，也不消耗额度。

额度与发送回执在同一 SQLite 事务预占，防止并发超发；重复请求不重复计数，重启后保留。为避免未知结果造成超发，已预占的失败或结果未知发送也保守占用额度；没有提交的超额消息不占额度。升级时按当前绑定最近一次微信输入之后的历史发送记录恢复计数。上述额度控制作用于多用户平台的微信适配器；独立旧版消息台不在本次部署范围内。

## 当前运行边界

平台支持文字、ClawBot 图片和文档输入。微信图片作为真正的 `localImage` 输入复制到该助手的隔离 workspace，UTF-8 文本、PDF、DOCX、XLSX 附件经过独立提取模块再传给模型。网页历史可预览图片和下载附件；网页上传尚未开放。Codex 已开放实时网页搜索、链接读取、命令与代码执行、助手工作目录文件修改、Playwright/Chromium 浏览器自动化、本地技能和子代理。外部账号应用、远程插件与自动安装 MCP 依赖仍需独立集成和按用户授权，不能复用部署账号的私人应用连接。所有用户使用部署方的 Codex 授权与额度。

每个附件最多 20 MB，每条消息最多 10 个附件；每轮图片最多 10 张且总计 20 MB，文档文字总计最多 60000 字符。PDF 读取前 40 页文字，不包含扫描图 OCR；DOCX 读取正文/表格文字；XLSX 读取前 5 个表、每表 200 行、每行 50 格，公式只用缓存值。不执行宏或文件。视频、SILK 音频、旧版 DOC/XLS 和压缩包等暂不解析，仍保存供下载；失败、截断和提取范围均作为系统消息回传微信及网页。可改发图片或支持的格式。

附件元数据随用户消息和模型任务原子保存，重启补齐时不重复推理。升级自动为消息表增加附件列，已有微信历史补齐元数据但不重跑旧对话。附件下载检查助手所有权，管理员只读访问留审计；其他用户、未登录请求、目录穿越和符号链接均拒绝。

每个助手有独立 CODEX_HOME、workspace 和数据库身份权限；Linux bubblewrap 文件系统/PID 命名空间不挂载宿主 `/root`、其他助手或平台数据库。执行器环境不继承宿主 secrets。缺少隔离工具时失败，不自动退化为裸进程。Codex 进程使用部署授权访问模型服务，但工具执行由 CLI 内层权限 profile 限制：禁止读取 `.codex` 中的凭据和会话文件，只开放必要的技能文件；代码和依赖写入 `/workspace` 或助手缓存目录。公网命令通过 Codex 网络代理，阻断私网、环回、云元数据和直接套接字绕过；托管搜索走单独服务连接。项目 `.codex` 配置不受信任，不能覆盖平台 profile；hooks、外部 MCP 和应用不自动继承宿主设置。

每个执行器还运行于独立 systemd scope，限制 768 MiB 内存、256 MiB swap、1 核 CPU 配额及 192 个任务；同一会话最多同时运行 2 个子代理。关闭助手会回收整个 scope。保留外层 bubblewrap 文件系统/PID/用户命名空间，工具在隔离身份 UID 1000 下执行。允许安装工作目录级 npm 依赖等，但不开放 sudo、宿主服务管理或其他用户目录。

## 部署

先下载并解压 [v1.0.1 源码包](https://github.com/wakaka-sam/wxbot/releases/tag/v1.0.1)，进入 `wxbot-v1.0.1/`。下列 systemd 示例使用 root 部署路径；安装到其他目录时，必须同时修改单元文件中的 `WorkingDirectory`、`ExecStart` 以及 env 文件中的路径。

需要 Linux、systemd/cgroup v2、可嵌套 user namespace 的 bubblewrap、Node.js ≥22.13、Python 3、poppler-utils（`pdftotext`）以及已登录 Codex。当前实际验证版本是 Codex CLI 0.163.0；安装到独立目录，不覆盖现有 CLI：

```bash
npm ci --omit=dev
# Debian/Ubuntu 文档提取依赖：apt-get install -y python3 poppler-utils
npm install --prefix /root/.local/share/wxbot-platform-tools @openai/codex@0.163.0
# 根据系统安装 bubblewrap，设置 PLATFORM_BWRAP 指向 bwrap 可执行文件。
# PLATFORM_SYSTEMD_RUN 默认 /usr/bin/systemd-run；服务需要创建系统 scope 的权限。
# 浏览器运行时使用独立只读工具目录：
npm install --prefix /opt/wxbot-agent-tools playwright
PLAYWRIGHT_BROWSERS_PATH=/opt/wxbot-agent-tools/browsers /opt/wxbot-agent-tools/node_modules/.bin/playwright install chromium
# 使用部署方既有 Codex 登录，PLATFORM_CODEX_AUTH 指向 auth.json。
# 若平台使用独立副本，可设 PLATFORM_CODEX_AUTH_SOURCE 指向同账号持续维护的登录文件。
cp deploy/platform.env.example /etc/wxbot-platform.env
chmod 600 /etc/wxbot-platform.env
# 编辑 env：替换初始化密码、路径、当前账号可用的模型。
# 编辑 deploy/wxbot-platform.service：项目默认路径为 /root/workspace/wxbot。
cp deploy/wxbot-platform.service /etc/systemd/system/wxbot-platform.service
systemctl daemon-reload
systemctl enable --now wxbot-platform
curl http://127.0.0.1:3211/health
```

当前机器通过独立安装的 gpt-6.1-sol 验证成功；gpt-6-astra 曾返回容量不足。模型由 `PLATFORM_MODEL` 配置；示例模型名称是本次部署的验证配置，不保证其他账号可用，请按自己的账号调整。现有旧工作台模型不受影响。管理员仅在数据库没有管理员时初始化，重启不会重置已修改的密码。首次登录后在用户旁齿轮修改密码，会使其他登录会话失效。

服务默认只监听 loopback；从自己的电脑使用 SSH 转发后访问：

```bash
ssh -N -L 3211:127.0.0.1:3211 root@YOUR_SERVER
# 打开 http://127.0.0.1:3211
```

公开域名部署时使用可信 HTTPS 反向代理，设置 `PLATFORM_PUBLIC_URL` 为准确 origin，代理保留 Host 并关闭 SSE 缓冲。仍让后端只监听 loopback。HTTPS 模式 Cookie 带 Secure；默认 HttpOnly/SameSite=Strict，写请求要求同源及专用请求头。跨用户权限在后端检查，不依赖前端隐藏按钮。注册当前开放，没有邮件验证/找回密码；单来源注册限 10 次/小时，适合当前内部部署。

允许从飞书等外站链接打开公开首页及静态资源（仅 GET）；这些响应不含账号和会话数据。接口（含历史、附件和 SSE）及写操作仍执行 Origin/Fetch Metadata 校验，所有请求仍检查 Host，页面禁止被 iframe 嵌入。

数据：`PLATFORM_DATA_DIR/platform.sqlite` 为用户、助手、消息、任务与投递表；`assistants/<id>/channel` 保存微信消息和凭证；`assistants/<id>/harness/home/.codex` 保存 Codex 授权及 thread 文件。数据库和 thread 文件应一起备份。备份前停止新平台服务，复制整个数据目录后重新启动，旧 3210 服务不受影响。凭证和备份均需仅部署账户可读，不提交 Git。

模型鉴权：每次启动或复用执行器前，比较配置的登录文件、助手缓存和可选 `PLATFORM_CODEX_AUTH_SOURCE`。仅在账号相同且访问令牌过期时间更新时同步，用原子写入保留新凭据，避免旧副本覆盖 CLI 更新后的登录。凭据变化时重建执行器并恢复原 thread，不自动重跑失败任务。已知令牌全部过期时明确提示管理员更新 Codex 登录。该机制同步已有凭据，不执行 OAuth 自动续期，也不会自动切换模型账号；部署方仍需维护来源登录有效性。鉴权失败无需删除微信绑定或对话历史。

进程正常停止会中断执行中的轮次并保留上下文。崩溃恢复将 running job 和 streaming 消息标为 interrupted；pending job 继续执行，已运行的任务不自动重放。投递状态未知时不自动重发，避免重复通知。页面显示微信投递异常，完整输出仍保存在网页。此版本未提供失败投递手动重试界面。

## 模块与适配器契约

| 模块 | 责任 |
| --- | --- |
| `src/platform/server.js` | HTTP、登录、所有权校验、SSE、静态页面 |
| `auth.js` | scrypt、哈希会话、Cookie、限流、密码更新 |
| `store.js` | SQLite、激活数量事务、消息/任务/投递恢复 |
| `engine.js` | 生命周期、同用户激活串行化、调度、中断、历史、问候、分段投递 |
| `attachments.js` / `extract-document.py` | 附件安全读取、限额、文档提取；不依赖具体渠道或模型 |
| `adapters/wechat.js` | 复用 iLink Bridge；不依赖 Codex |
| `adapters/codex.js` | 隔离的 Codex app-server；不依赖微信 |
| `public/platform/` | 无构建步骤的响应式工作台 |

`new Engine(store, dir, { channelFactory, harnessFactory })` 为注入点；测试使用相同接口替换两个适配器。数据库预留 `channel`/`harness` 类型，目前 UI 只启用微信和 Codex。

Channel 是 EventEmitter，接受 `{dir, validateBinding}`，实现：

- `start()/stop()/close()`：启动、暂停并保留身份、释放资源。
- `login()/verify(code)/disconnect()`：获取二维码、数字码验证、断开凭证。
- `snapshot()`：`{phase,detail,qr,account:{id,userId}|null}`，不得返回 token。
- `history()`：持久收到的 `{id,text,attachments}`，用于崩溃后补齐平台消息；附件只含 id/name/kind/mime/size/error，不暴露凭据或服务器路径。
- `readAttachment(metadata)`：返回当前渠道、当前助手的原文件 Buffer，必须限制目录和文件大小。
- `send(text,id,binding)`：以稳定 UUID 幂等发送，返回 `{status:'sent'|'failed'|'unknown',error?}`；拒绝目标身份变化。
- 事件 `input:{id,text,attachments}`、`paired`、`state`。确认新配对前必须调用 `validateBinding(account)`。

Harness 接受 `{dir}`，实现：

- `prepare({threadId,onThread})`：创建/恢复，持久 thread ID 通过回调保存。
- `run({text,images,onEvent,onSend})`：images 为可选的 `{id,name,mime,bytes}` 数组，不依赖渠道文件路径。只执行一个轮次，输出公开事件；完成 resolve，被中断 reject 且 `error.code='interrupted'`。可选 `onSend({requestId,text})` 回调由 Engine 绑定助手、轮次及微信身份，返回发送回执；Codex 的 `wxbot send` 通过按轮次隔离的文件通道调用它，不能指定其他接收者。
- `interrupt()/close()`：中断当前轮次/释放进程。
- 事件 `started:{turnId}`、`delta:{itemId,delta,phase}`、`message:{itemId,text,phase}`；phase 区分 `commentary` 与 `final_answer`，不发布内部 reasoning。

接新聊天机器人只需实现 Channel；换 AI harness 只需实现 Harness。两者通过 Engine 的标准事件连接，不应互相调用。协议依据 [Codex app-server 官方文档](https://learn.chatgpt.com/docs/app-server)，具体可用字段以固定版本 CLI schema 为准。

`wxbot send` 的安装、回执、幂等和最终回复去重见 [Codex 交互与发送通道](CODEX-INTEGRATION.md)。公开进度继续分段同步；最终正文等完整消息完成后投递，以便与本轮显式发送的正文比较，网页增量保持实时。

## 实际能力验收

在 sg 上可执行 `PLATFORM_AGENT_TEST=1 node --env-file=/etc/wxbot-platform.env scripts/test-platform-agent.mjs`。这是显式调用真实模型的验收：只使用临时合成数据，验证写入/执行、公网读取、私网和凭据阻断、项目配置不能提权、浏览器、搜索、子代理、scope 配额和重启后工作文件保留；结束删除临时数据。

权限配置以 [Codex 官方权限文档](https://learn.chatgpt.com/docs/permissions) 和固定 CLI 实测为准。`default_permissions` 不与旧 `sandbox_mode` 混用，thread/turn 不再强制覆盖成 read-only。既有会话通过原 thread ID 恢复，无需重新创建助手。

## 验证

```bash
npm run check
npm test
npm run test:platform
# 浏览器验收另需 Playwright 与 Chromium；可使用已安装路径：
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
CHROMIUM_EXECUTABLE=/path/to/chrome npm run test:browser
```

测试覆盖越权、管理员只读、并发激活上限、替换保留会话、输入中断、消息幂等、跨网页/微信续聊、最近十条总结、密码/登出会话失效、历史分页、真实微信适配器的恢复轮询和投递去重。浏览器测试以假模型/微信验证完整 UI，并在 `/tmp/wxbot-platform-browser/` 生成截图。真实 Codex 已另行验证持久上下文和生成中断；真实二维码获取可独立验证，手机扫码与实际微信收发需要用户在手机完成最后一段验收。
