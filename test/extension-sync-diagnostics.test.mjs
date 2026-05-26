import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('service worker requests extension vocabulary with an explicit English source language', async () => {
  const serviceWorker = await readText('background/service-worker.js');

  assert.match(serviceWorker, /extensionSourceLanguage/);
  assert.match(serviceWorker, /source_language=\$\{encodeURIComponent\(sourceLanguage\)\}/);
});

test('popup exposes source-language and matchable-word diagnostics', async () => {
  const popupHtml = await readText('popup/popup.html');
  const popupJs = await readText('popup/popup.js');

  assert.match(popupHtml, /id="source-language"/);
  assert.match(popupHtml, /id="matchable-word-count"/);
  assert.match(popupJs, /matchableWordCount/);
  assert.match(popupJs, /noMatchableWordsWarning/);
});
