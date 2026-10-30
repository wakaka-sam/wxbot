// Loaded only inside assistant command environments. Keep non-browser Node
// commands lightweight; activate compatibility when Playwright is required.
const Module = require('node:module');
const { installBrowserCompatibility } = require('./browser.cjs');
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  const value = originalLoad.call(this, id, ...args);
  if (id === 'playwright' || id === 'playwright-core') installBrowserCompatibility(value);
  return value;
};
