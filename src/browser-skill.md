---
name: wxbot-browser
description: 在 wxbot 助手隔离环境中浏览动态网页、填写表单、截图、下载文件或保存浏览器会话。遇到 Chromium 启动失败时也使用。
---

使用平台入口；不要指定 `/usr/bin/chromium`、`/usr/lib/chromium/chromium`、`executablePath` 或 `channel`。系统 Chromium 需要当前沙箱禁止的 AF_UNIX socket，平台配套 Headless Shell 使用 pipe IPC，支持网页 JavaScript、表单和 Cookie。

```js
const { openBrowser } = require('/home/assistant/.local/share/wxbot-tools/browser.cjs');
(async () => {
  const { browser, context, page, saveState } = await openBrowser({ session: 'my-site' });
  try {
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    console.log(await page.title());
    await page.screenshot({ path: '/workspace/page.png', fullPage: true });
    // 仅在需要保留本次 Cookie / localStorage / IndexedDB 时保存。
    await saveState();
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
```

- 不需要跨命令持久化时省略 `session`。相同 session 恢复之前显式保存的状态；不同用途使用不同名字。名字只允许 1–64 位字母、数字、下划线和短横线。
- 持久状态保存在当前助手的 `~/.local/share/wxbot-browser/sessions/`，权限 0600。不要输出、提交 Git 或发送包含凭证/Cookie/Token 的状态文件。同名 session 不要并发保存。
- 只在返回的 context 中创建页面，避免丢失会话。`saveState()` 不保存 sessionStorage。
- 配置、缓存、临时 profile 和下载位于当前助手 `~/.cache/wxbot-browser/`。下载后用 `await download.saveAs('/workspace/文件名')` 保留产物，再关闭浏览器。
- 默认启动 30 秒、操作 15 秒、导航 45 秒；浏览器最长存活 15 分钟。长任务分段，并显式保存必要状态。
- 网络沿用平台代理；不要关闭代理或沙箱。`--no-sandbox` 是已有 Chromium 启动参数，外层 bubblewrap、Codex 命令沙箱及资源限制仍在。
- 必须根据实际页面、URL 和截图判断成功。HTTP 200 或浏览器成功启动不代表目标表单/订单已加载。遇到登录、验证码或站点限制时如实报告，不绕过验证。
