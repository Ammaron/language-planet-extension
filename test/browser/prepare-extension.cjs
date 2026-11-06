// Release builds only accept the production API over HTTPS and silently fall
// back to it for anything else, so a smoke test pointed at a local mock would
// call production. These helpers test a temporary copy of dist/chrome that
// allows the mock, and refuse to sync until the mock is really in use.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const API_GUARD = "return url.protocol === 'https:' && ALLOWED_CONFIG_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port;";
const LOOPBACK_GUARD = "return url.protocol === 'http:' && url.hostname === '127.0.0.1';";
const CLOSED_POPUP = "attachShadow({ mode: 'closed' })";
const OPEN_POPUP = "attachShadow({ mode: 'open' })";

function patchFile(file, from, to) {
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(source.includes(from), `${path.basename(file)} no longer contains: ${from}`);
  fs.writeFileSync(file, source.replace(from, to));
}

function prepareExtension(distChrome) {
  assert.ok(fs.existsSync(path.join(distChrome, 'manifest.json')), 'Run npm run build first');
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'langsly-smoke-extension-'));
  fs.cpSync(distChrome, copy, { recursive: true });
  patchFile(path.join(copy, 'background', 'service-worker.js'), API_GUARD, LOOPBACK_GUARD);
  // Only so a test can read and click the popup; the shipped popup stays closed.
  patchFile(path.join(copy, 'content', 'popup.js'), CLOSED_POPUP, OPEN_POPUP);
  return copy;
}

async function assertUsingMock(worker, apiBase) {
  const config = await worker.evaluate(() => getConfig());
  assert.equal(config.apiBase, apiBase, 'The extension is not using the local mock; refusing to contact the real API');
}

function removeExtensionCopy(copy) {
  fs.rmSync(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

module.exports = { prepareExtension, assertUsingMock, removeExtensionCopy };
