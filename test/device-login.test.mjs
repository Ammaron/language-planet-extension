import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readText = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = async (path) => JSON.parse(await readText(path));

test('base manifest removes identity and activeTab and uses full-tab options', async () => {
  const manifest = await readJson('manifest.json');
  assert.equal(manifest.version, '0.2.4');
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

test('device page delegates connection lifetime to the background', async () => {
  const html = await readText('popup/connect.html');
  const js = await readText('popup/connect.js');
  assert.match(html, /<details class="other-device">/);
  assert.match(js, /DEVICE_CONNECTION_BEGIN/);
  assert.match(js, /DEVICE_CONNECTION_OPEN/);
  assert.match(js, /storage.onChanged/);
  assert.doesNotMatch(js, /fetch\(|visibilityState/);
});

test('service worker renews extension sessions and preserves them through transient failures', async () => {
  const serviceWorker = await readText('background/service-worker.js');
  assert.match(serviceWorker, /extension_session === true/);
  assert.match(serviceWorker, /'\/auth\/extension-token\/refresh\/'/);
  assert.match(serviceWorker, /'\/auth\/token\/refresh\/'/);
  assert.match(serviceWorker, /fetch\(`\$\{apiBase\}\$\{refreshPath\}`/);
  assert.doesNotMatch(serviceWorker, /\$\{apiBase\}\/users\/token\/refresh\//);
  assert.match(serviceWorker, /\[401, 403\]\.includes\(res\.status\)/);
  assert.doesNotMatch(serviceWorker, /\[400, 401, 403\]\.includes\(res\.status\)/);
  assert.match(serviceWorker, /function isAccessTokenFresh\(token, now = Date\.now\(\)\)/);
  assert.match(serviceWorker, /isLoggedIn: !!\(authToken \|\| refreshToken\)/);
  assert.match(serviceWorker, /ensureAccessToken\(\)\.catch\(\(\) => \{\}\)/);
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
