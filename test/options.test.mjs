import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('options page does not expose editable server configuration', async () => {
  const optionsHtml = await readText('popup/options.html');

  assert.doesNotMatch(optionsHtml, /id="api-base"/);
  assert.doesNotMatch(optionsHtml, /id="frontend-url"/);
  assert.doesNotMatch(optionsHtml, /data-i18n="serverConfiguration"/);
  assert.doesNotMatch(optionsHtml, /data-i18n="apiBaseUrl"/);
  assert.doesNotMatch(optionsHtml, /data-i18n="frontendUrl"/);
});

test('options save only persists user preferences', async () => {
  const optionsJs = await readText('popup/options.js');

  assert.doesNotMatch(optionsJs, /\bapiBaseInput\b/);
  assert.doesNotMatch(optionsJs, /\bfrontendUrlInput\b/);
  assert.doesNotMatch(optionsJs, /\bapiBase\s*:/);
  assert.doesNotMatch(optionsJs, /\bfrontendUrl\s*:/);
  assert.match(optionsJs, /\bsyncInterval\s*:/);
  assert.match(optionsJs, /\bexcludeSensitive\s*:/);
});

test('options footer keeps secondary reset action aligned with save action', async () => {
  const optionsHtml = await readText('popup/options.html');
  const optionsCss = await readText('popup/options.css');

  assert.match(optionsHtml, /id="reset-preferences"/);
  assert.doesNotMatch(optionsHtml, /id="reset-urls"/);
  assert.match(optionsCss, /\.options-footer\s+\.secondary-btn/);
});
