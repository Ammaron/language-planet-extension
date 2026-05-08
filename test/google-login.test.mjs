import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

test('manifest allows extension-hosted Google OAuth flow', async () => {
  const manifest = await readJson('manifest.json');

  assert.ok(manifest.permissions.includes('identity'));
});

test('popup login view exposes a Google sign-in action', async () => {
  const popupHtml = await readText('popup/popup.html');
  const popupJs = await readText('popup/popup.js');

  assert.match(popupHtml, /id="google-login-btn"/);
  assert.match(popupHtml, /data-i18n="loginWithGoogle"/);
  assert.match(popupJs, /type:\s*'GOOGLE_LOGIN'/);
});

test('onboarding login step exposes a Google sign-in action', async () => {
  const onboardingHtml = await readText('popup/onboarding.html');
  const onboardingJs = await readText('popup/onboarding.js');

  assert.match(onboardingHtml, /id="onboard-google-login-btn"/);
  assert.match(onboardingHtml, /data-i18n="loginWithGoogle"/);
  assert.match(onboardingJs, /type:\s*'GOOGLE_LOGIN'/);
});

test('background service worker uses website-mediated extension login', async () => {
  const serviceWorker = await readText('background/service-worker.js');

  assert.match(serviceWorker, /message\.type\s*===\s*'GOOGLE_LOGIN'/);
  assert.match(serviceWorker, /launchWebAuthFlow/);
  assert.match(serviceWorker, /\/extension-login/);
  assert.match(serviceWorker, /\/auth\/extension-login\/redeem\//);
  assert.doesNotMatch(serviceWorker, /accounts\.google\.com\/o\/oauth2/);
  assert.doesNotMatch(serviceWorker, /GOOGLE_CLIENT_ID/);
  assert.match(serviceWorker, /setTokens\(data\.access,\s*data\.refresh\)/);
});

test('Google login copy is localized', async () => {
  const en = await readJson('_locales/en/messages.json');
  const es = await readJson('_locales/es/messages.json');

  assert.equal(en.loginWithGoogle.message, 'Continue with Google');
  assert.equal(en.googleLoginLoading.message, 'Connecting to Google...');
  assert.equal(es.loginWithGoogle.message, 'Continuar con Google');
  assert.equal(es.googleLoginLoading.message, 'Conectando con Google...');
});
