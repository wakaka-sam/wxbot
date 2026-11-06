const { mkdir, mkdtemp, rm, readFile, writeFile, rename } = require('node:fs/promises');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { randomUUID } = require('node:crypto');
// Keep the existing proxy and telemetry policy. No socket/sandbox permissions
// are expanded: Playwright's matching headless shell works with pipe IPC.
const OMITTED_TELEMETRY = new Set(['rum.battlenet.com.cn']);
const SYSTEM_CHROMIUM = new Set(['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/lib/chromium/chromium']);
const browserRoot = () => join(homedir(), '.cache', 'wxbot-browser');
const sessionRoot = () => join(homedir(), '.local', 'share', 'wxbot-browser', 'sessions');
function managedProxy() {
  const server = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!server) throw new Error('浏览器需要平台网络代理；未启动直连浏览器');
  return { server };
}
function omitRequest(request) {
  if (request.isNavigationRequest()) return false;
  const url = new URL(request.url());
  return ['http:', 'https:'].includes(url.protocol) && OMITTED_TELEMETRY.has(url.hostname.toLowerCase());
}
const guardedContexts = new WeakMap();
const patchedTypes = new WeakMap();
async function guardContext(context) {
  if (guardedContexts.has(context)) return guardedContexts.get(context);
  const ready = (async () => {
    const omitted = [];
    context.setDefaultTimeout(15000);
    context.setDefaultNavigationTimeout(45000);
    await context.route('**/*', async route => {
      const request = route.request();
      if (omitRequest(request)) {
        if (omitted.length < 100) omitted.push({ host: new URL(request.url()).hostname, type: request.resourceType() });
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    return omitted;
  })();
  guardedContexts.set(context, ready);
  return ready;
}
async function managedLaunchOptions(options, type) {
  const proxy = managedProxy();
  const result = { ...options };
  if (result.executablePath && !SYSTEM_CHROMIUM.has(result.executablePath) && result.executablePath !== type.executablePath()) {
    throw new Error('当前助手仅支持平台配套 Headless Shell；请使用 openBrowser() 或省略 executablePath');
  }
  // Old scripts chose the system launcher (missing /etc/chromium.d) or full
  // Chromium (ProcessSingleton needs forbidden AF_UNIX). Both use the shell.
  if (result.executablePath || result.channel || result.headless === false) {
    process.stderr.write('wxbot: 使用平台配套 Headless Shell 和受控代理。\n');
  }
  delete result.executablePath; delete result.channel;
  await mkdir(browserRoot(), { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(browserRoot(), 'run-'));
  try {
    for (const name of ['config', 'cache', 'downloads']) await mkdir(join(directory, name), { mode: 0o700 });
    Object.assign(result, {
      headless: true, proxy, timeout: Math.min(result.timeout > 0 ? result.timeout : 30000, 30000),
      args: [...new Set([...(result.args || []), '--no-sandbox', '--disable-dev-shm-usage'])],
      downloadsPath: join(directory, 'downloads'),
      env: { ...process.env, ...result.env, XDG_CONFIG_HOME: join(directory, 'config'), XDG_CACHE_HOME: join(directory, 'cache') },
    });
    return { options: result, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
function manageLifetime(target, event, cleanup) {
  let cleaning;
  const clean = () => cleaning ||= cleanup();
  const close = target.close.bind(target);
  const timer = setTimeout(() => { void target.close().catch(() => {}); }, 15 * 60 * 1000);
  timer.unref();
  target.once(event, () => { clearTimeout(timer); void clean().catch(() => {}); });
  target.close = async (...args) => {
    try { return await close(...args); }
    finally { clearTimeout(timer); await clean(); }
  };
}
function installBrowserCompatibility(playwright, { managed = process.env.WXBOT_MANAGED_BROWSER === '1' } = {}) {
  const type = playwright.chromium;
  if (!type) return;
  const existing = patchedTypes.get(type);
  if (existing) { existing.managed ||= managed; return; }
  const state = { managed }; patchedTypes.set(type, state);
  const launch = type.launch;
  type.launch = async function (options = {}) {
    const prepared = state.managed ? await managedLaunchOptions(options, type) : { options, cleanup: async () => {} };
    let browser;
    try { browser = await launch.apply(this, [prepared.options]); }
    catch (error) { await prepared.cleanup(); throw error; }
    if (state.managed) manageLifetime(browser, 'disconnected', prepared.cleanup);
    const newContext = browser.newContext;
    browser.newContext = async function (options = {}) {
      const context = await newContext.call(this, { ...options, serviceWorkers: 'block' });
      try { await guardContext(context); return context; }
      catch (error) { await context.close(); throw error; }
    };
    return browser;
  };
  const persistent = type.launchPersistentContext;
  if (persistent) type.launchPersistentContext = async function (directory, options = {}) {
    const prepared = state.managed ? await managedLaunchOptions(options, type) : { options, cleanup: async () => {} };
    let context;
    try {
      context = await persistent.call(this, directory, { ...prepared.options, serviceWorkers: 'block' });
      if (state.managed) manageLifetime(context, 'close', prepared.cleanup);
      await guardContext(context); return context;
    } catch (error) { if (context) await context.close(); await prepared.cleanup(); throw error; }
  };
}
// A named session persists only when saveState() is explicitly called. Cookie
// values never enter stdout; private files are atomically replaced with 0600.
async function openBrowser({ contextOptions = {}, session } = {}) {
  managedProxy();
  let statePath, storageState;
  if (session !== undefined) {
    if (typeof session !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(session)) throw new Error('浏览器 session 须为 1–64 位字母、数字、下划线或短横线');
    if (contextOptions.storageState !== undefined) throw new Error('session 与 contextOptions.storageState 不能同时指定');
    await mkdir(sessionRoot(), { recursive: true, mode: 0o700 });
    statePath = join(sessionRoot(), session + '.json');
    try { storageState = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('浏览器会话状态无法读取，请检查或更换 session'); }
  }
  const playwright = require('playwright');
  installBrowserCompatibility(playwright, { managed: true });
  const browser = await playwright.chromium.launch();
  try {
    const context = await browser.newContext({ ...contextOptions, ...(storageState ? { storageState } : {}), serviceWorkers: 'block' });
    const omitted = await guardContext(context);
    const page = await context.newPage();
    const saveState = async () => {
      if (!statePath) throw new Error('保存状态前请为 openBrowser 指定 session');
      const temporary = statePath + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, JSON.stringify(await context.storageState({ indexedDB: true })), { mode: 0o600, flag: 'wx' });
        await rename(temporary, statePath);
      } finally { await rm(temporary, { force: true }); }
    };
    return { browser, context, page, omitted, saveState };
  } catch (error) { await browser.close(); throw error; }
}
module.exports = { openBrowser, omitRequest, installBrowserCompatibility };
