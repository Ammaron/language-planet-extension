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

test('popup login view exposes the website-mediated Langsly sign-in action', async () => {
  const popupHtml = await readText('popup/popup.html');
  const popupJs = await readText('popup/popup.js');

  assert.match(popupHtml, /id="google-login-btn"/);
  assert.match(popupHtml, /data-i18n="loginWithGoogle"/);
  assert.doesNotMatch(popupHtml, /type="(?:email|password)"/);
  assert.doesNotMatch(popupJs, /type:\s*'LOGIN'/);
  assert.match(popupJs, /type:\s*'GOOGLE_LOGIN'/);
});

test('onboarding login step exposes the website-mediated Langsly sign-in action', async () => {
  const onboardingHtml = await readText('popup/onboarding.html');
  const onboardingJs = await readText('popup/onboarding.js');

  assert.match(onboardingHtml, /id="onboard-google-login-btn"/);
  assert.match(onboardingHtml, /data-i18n="loginWithGoogle"/);
  assert.doesNotMatch(onboardingHtml, /type="(?:email|password)"/);
  assert.doesNotMatch(onboardingJs, /type:\s*'LOGIN'/);
  assert.match(onboardingJs, /type:\s*'GOOGLE_LOGIN'/);
});

test('background service worker uses website-mediated extension login', async () => {
  const serviceWorker = await readText('background/service-worker.js');

  assert.match(serviceWorker, /message\.type\s*===\s*'GOOGLE_LOGIN'/);
  assert.doesNotMatch(serviceWorker, /message\.type\s*===\s*'LOGIN'/);
  assert.match(serviceWorker, /launchWebAuthFlow/);
  assert.match(serviceWorker, /\/extension-login/);
  assert.match(serviceWorker, /\/auth\/extension-login\/redeem\//);
  assert.doesNotMatch(serviceWorker, /accounts\.google\.com\/o\/oauth2/);
  assert.doesNotMatch(serviceWorker, /GOOGLE_CLIENT_ID/);
  assert.match(serviceWorker, /setTokens\(data\.access,\s*data\.refresh\)/);
});

test('website-mediated Langsly login copy is localized', async () => {
  const en = await readJson('_locales/en/messages.json');
  const es = await readJson('_locales/es/messages.json');

  assert.equal(en.loginWithGoogle.message, 'Sign in to your Langsly account');
  assert.equal(en.googleLoginLoading.message, 'Opening secure sign-in...');
  assert.equal(es.loginWithGoogle.message, 'Inicia sesión con tu cuenta de Langsly');
  assert.equal(es.googleLoginLoading.message, 'Abriendo inicio de sesión seguro...');
});
