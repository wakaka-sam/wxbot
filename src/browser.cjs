// Public-site browsing stays behind the managed Codex proxy. Only a known
// broken, non-navigation telemetry destination is omitted before connecting.
const OMITTED_TELEMETRY = new Set(['rum.battlenet.com.cn']);
function omitRequest(request) {
  if (request.isNavigationRequest()) return false;
  const url = new URL(request.url());
  return ['http:', 'https:'].includes(url.protocol) && OMITTED_TELEMETRY.has(url.hostname.toLowerCase());
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
    const omitted = [];
    await context.route('**/*', async route => {
      const request = route.request();
      if (omitRequest(request)) {
        if (omitted.length < 100) omitted.push({ host: new URL(request.url()).hostname, type: request.resourceType() });
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    const page = await context.newPage();
    return { browser, context, page, omitted };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
module.exports = { openBrowser, omitRequest };
