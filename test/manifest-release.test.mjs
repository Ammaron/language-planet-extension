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
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'storage']);
  assert.equal(manifest.host_permissions[0], '<all_urls>');
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
