import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('generated Firefox manifest combines desktop and Android requirements', async () => {
  const manifest = JSON.parse(await readFile(new URL('../dist/firefox/manifest.json', import.meta.url), 'utf8'));
  const settings = manifest.browser_specific_settings;
  assert.equal(settings.gecko.id, 'vocabpass@languageplanet.app');
  assert.equal(settings.gecko.strict_min_version, '140.0');
  assert.equal(settings.gecko_android.strict_min_version, '142.0');
  assert.deepEqual(settings.gecko.data_collection_permissions.required.sort(), [
    'authenticationInfo', 'browsingActivity', 'websiteActivity', 'websiteContent',
  ].sort());
  // scripting injects the packaged writer only after an explicit practice click;
  // it grants no hosts beyond the existing host_permissions.
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'scripting', 'storage']);
  assert.ok(manifest.background.scripts.includes('background/hanzi-practice.js'));
  assert.equal(manifest.host_permissions[0], '<all_urls>');
});

test('built packages carry the pinned writer, pilot data and full notices', async () => {
  const { createHash } = await import('node:crypto');
  const vendor = JSON.parse(await readFile(new URL('../vendor/hanzi-writing-manifest.json', import.meta.url), 'utf8'));
  for (const target of ['chrome', 'firefox']) {
    for (const file of [...vendor.files.map(entry => entry.path), 'vendor/LICENSE-webextension-polyfill', 'popup/licenses.html']) {
      const bytes = await readFile(new URL(`../dist/${target}/${file}`, import.meta.url));
      const expected = vendor.files.find(entry => entry.path === file);
      if (expected) assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, `${target}: ${file}`);
    }
  }
});

test('generated Chrome and Firefox manifests expose only the closed-shadow stylesheet', async () => {
  for (const target of ['chrome', 'firefox']) {
    const manifest = JSON.parse(await readFile(new URL(`../dist/${target}/manifest.json`, import.meta.url), 'utf8'));
    assert.deepEqual(manifest.web_accessible_resources, [{
      resources: ['content/content.css'],
      matches: ['<all_urls>'],
    }]);
  }
});
