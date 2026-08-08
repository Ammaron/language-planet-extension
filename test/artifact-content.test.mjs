import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('release artifacts and AMO source inputs exist', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  const names = [
    `../dist/langsly-vocab-pass-chrome-${manifest.version}.zip`,
    `../dist/langsly-vocab-pass-firefox-amo-${manifest.version}.zip`,
    `../dist/langsly-vocab-pass-amo-source-${manifest.version}.zip`,
    '../vendor/browser-polyfill.js',
    '../vendor/browser-polyfill.min.js',
    '../vendor/LICENSE-webextension-polyfill',
    '../BUILDING.md',
    '../package-lock.json',
  ];
  await Promise.all(names.map((name) => access(new URL(name, import.meta.url))));
  assert.ok(true);
});
