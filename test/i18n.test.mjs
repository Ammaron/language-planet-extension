import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

test('manifest uses Chrome i18n metadata and localized store copy', async () => {
  const manifest = await readJson('manifest.json');
  const messages = await readJson('_locales/en/messages.json');

  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.name, '__MSG_extName__');
  assert.equal(manifest.description, '__MSG_extDescription__');
  assert.equal(messages.extName.message, 'English Vocabulary Builder · Langsly Vocab Pass');
  assert.equal(
    messages.extDescription.message,
    "Read Spanish websites and see the English words you're learning in Langsly. Tap a word for its meaning and audio.",
  );
  assert.ok(messages.extDescription.message.length <= 132);
});

test('Spanish locale defines every English message key', async () => {
  const englishMessages = await readJson('_locales/en/messages.json');
  const spanishMessages = await readJson('_locales/es/messages.json');

  assert.deepEqual(Object.keys(spanishMessages).sort(), Object.keys(englishMessages).sort());
  assert.equal(spanishMessages.extName.message, 'Aprende vocabulario en inglés · Langsly Vocab Pass');
  assert.equal(
    spanishMessages.extDescription.message,
    'Lee sitios en español y descubre las palabras en inglés que aprendes en Langsly. Toca una para ver su significado y audio.',
  );
  assert.ok(spanishMessages.extDescription.message.length <= 132);
  assert.equal(
    spanishMessages.popupHeroTitle.message,
    'Repasa palabras de español e inglés en las páginas que lees.',
  );
});

test('extension UI entrypoints load the shared i18n helper', async () => {
  const manifest = await readJson('manifest.json');
  const serviceWorker = await readText('background/service-worker.js');
  const popupHtml = await readText('popup/popup.html');
  const optionsHtml = await readText('popup/options.html');
  const onboardingHtml = await readText('popup/onboarding.html');

  assert.ok(manifest.content_scripts[0].js.includes('shared/i18n.js'));
  assert.match(serviceWorker, /shared\/i18n\.js/);
  assert.match(popupHtml, /shared\/i18n\.js/);
  assert.match(optionsHtml, /shared\/i18n\.js/);
  assert.match(onboardingHtml, /shared\/i18n\.js/);
});

test('build scripts package i18n assets for Chrome and Firefox builds', async () => {
  const nodeBuild = await readText('build.mjs');
  const powershellBuild = await readText('build.ps1');
  const bashBuild = await readText('build.sh');

  assert.match(nodeBuild, /shared\/i18n\.js/);
  assert.match(nodeBuild, /_locales/);
  assert.match(powershellBuild, /build\.mjs/);
  assert.match(bashBuild, /build\.mjs/);
});
