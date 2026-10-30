// Public-site browsing stays behind the managed Codex proxy. Only a known
// broken, non-navigation telemetry destination is omitted before connecting.
const OMITTED_TELEMETRY = new Set(['rum.battlenet.com.cn']);
function omitRequest(request) {
  if (request.isNavigationRequest()) return false;
  const url = new URL(request.url());
  return ['http:', 'https:'].includes(url.protocol) && OMITTED_TELEMETRY.has(url.hostname.toLowerCase());
}
const guardedContexts = new WeakMap();
const patchedTypes = new WeakSet();
async function guardContext(context) {
  if (guardedContexts.has(context)) return guardedContexts.get(context);
  const ready = (async () => {
    const omitted = [];
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
// Existing workspace scripts also use require('playwright') directly. Install
// the same compatibility handler before any page can navigate, without changing
// launch arguments, proxy settings, or the user's script on disk.
function installBrowserCompatibility(playwright) {
  const type = playwright.chromium;
  if (!type || patchedTypes.has(type)) return;
  patchedTypes.add(type);
  const launch = type.launch;
  type.launch = async function (...args) {
    const browser = await launch.apply(this, args);
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
    const context = await persistent.call(this, directory, { ...options, serviceWorkers: 'block' });
    try { await guardContext(context); return context; }
    catch (error) { await context.close(); throw error; }
  };
}
async function openBrowser({ contextOptions = {} } = {}) {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!proxy) throw new Error('浏览器需要平台网络代理；未启动直连浏览器');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    proxy: { server: proxy },
  });
  try {
    const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block' });
    const omitted = await guardContext(context);
    const page = await context.newPage();
    return { browser, context, page, omitted };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
module.exports = { openBrowser, omitRequest, installBrowserCompatibility };
