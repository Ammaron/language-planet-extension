import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readText = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = async (path) => JSON.parse(await readText(path));

test('base manifest removes identity and activeTab and uses full-tab options', async () => {
  const manifest = await readJson('manifest.json');
  assert.equal(manifest.version, '0.2.2');
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'storage']);
  assert.equal(manifest.options_ui.page, 'popup/options.html');
  assert.equal(manifest.options_ui.open_in_tab, true);
  assert.equal(manifest.options_page, undefined);
});

test('popup and onboarding open the device connection tab without credential fields', async () => {
  for (const [htmlPath, cssPath, jsPath] of [['popup/popup.html', 'popup/popup.css', 'popup/popup.js'], ['popup/onboarding.html', 'popup/onboarding.css', 'popup/onboarding.js']]) {
    const html = await readText(htmlPath);
    const css = await readText(cssPath);
    const js = await readText(jsPath);
    assert.match(html, /data-i18n="connectLangslyAccount"/);
    assert.match(html, /class="account-connect-btn"/);
    assert.doesNotMatch(html, /type="(?:email|password)"/);
    assert.doesNotMatch(html, /google-login-btn/);
    assert.doesNotMatch(css, /content:\s*["']G["']/);
    assert.match(js, /type:\s*'START_DEVICE_LOGIN'/);
    assert.doesNotMatch(js, /GOOGLE_LOGIN|launchWebAuthFlow/);
  }
});

test('mobile-accessible options expose explicit connect and logout controls', async () => {
  const html = await readText('popup/options.html');
  const js = await readText('popup/options.js');
  assert.match(html, /id="account-connect"/);
  assert.match(html, /id="account-logout"/);
  assert.match(js, /type:\s*'START_DEVICE_LOGIN'/);
  assert.match(js, /type:\s*'LOGOUT'/);
  assert.match(js, /type:\s*'GET_STATUS'/);
});

test('device page persists pending state, polls only while visible, and retries on focus', async () => {
  const html = await readText('popup/connect.html');
  const js = await readText('popup/connect.js');
  assert.match(html, /id="user-code"/);
  assert.match(html, /id="approval-url"/);
  assert.match(html, /id="copy-approval-url"/);
  assert.match(html, /id="open-approval"/);
  assert.match(js, /extensionDeviceAuthorization/);
  assert.match(js, /document\.visibilityState\s*!==\s*'visible'/);
  assert.match(js, /addEventListener\('focus'/);
  assert.match(js, /authorization_pending/);
  assert.match(js, /slow_down/);
  assert.match(js, /access_denied/);
  assert.match(js, /expired_token/);
  assert.match(js, /verificationUri:\s*data\.verification_uri/);
  assert.match(js, /navigator\.clipboard\.writeText/);
});

test('service worker renews extension sessions and preserves them through transient failures', async () => {
  const serviceWorker = await readText('background/service-worker.js');
  assert.match(serviceWorker, /extension_session === true/);
  assert.match(serviceWorker, /'\/auth\/extension-token\/refresh\/'/);
  assert.match(serviceWorker, /'\/auth\/token\/refresh\/'/);
  assert.match(serviceWorker, /fetch\(`\$\{apiBase\}\$\{refreshPath\}`/);
  assert.doesNotMatch(serviceWorker, /\$\{apiBase\}\/users\/token\/refresh\//);
  assert.match(serviceWorker, /\[400, 401, 403\]\.includes\(res\.status\)/);
  assert.doesNotMatch(serviceWorker, /if \(!res\.ok\) \{\s*if \(generation === authGeneration\) await clearSession\(\)/);
});

test('service worker has no browser identity or legacy callback authentication', async () => {
  const serviceWorker = await readText('background/service-worker.js');
  assert.doesNotMatch(serviceWorker, /\bidentity\b|launchWebAuthFlow|getRedirectURL|extension-login\/redeem/);
  assert.match(serviceWorker, /COMPLETE_DEVICE_LOGIN/);
  assert.match(serviceWorker, /extensionDeviceAuthorization/);
  assert.match(serviceWorker, /pendingEncounters/);
  assert.match(serviceWorker, /key\.startsWith\('phrase_'\)/);
  assert.match(serviceWorker, /key\.startsWith\('disambig_'\)/);
});

test('connection and privacy copy is localized in English and Spanish', async () => {
  const en = await readJson('_locales/en/messages.json');
  const es = await readJson('_locales/es/messages.json');
  for (const key of ['connectLangslyAccount', 'accountConnectionFailed', 'connectBrowserTitle', 'connectComputerInstructions', 'connectCopyUrl', 'connectUrlCopied', 'accountSettingsTitle', 'accountConnected', 'accountNotConnected', 'connectPrivacyBody', 'sensitiveProtectionLocked']) {
    assert.ok(en[key]?.message);
    assert.ok(es[key]?.message);
  }
});
