import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadInstallHandler(initial) {
  const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  const start = worker.indexOf('const INSTALL_DEFAULTS');
  const end = worker.indexOf('browser.runtime.onInstalled.addListener');
  assert.ok(start >= 0 && end > start, 'install handler missing');
  const storage = { ...initial };
  const opened = [];
  const calls = [];
  const context = {
    flushEncounters: async () => { calls.push('flush'); },
    requestVocabularySync: async () => { calls.push('sync'); },
    browser: {
      storage: { local: {
        get: async keys => Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]])),
        set: async values => { Object.assign(storage, values); },
      } },
      tabs: { create: async ({ url }) => { opened.push(url); } },
      runtime: { getURL: path => `ext://id/${path}` },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${worker.slice(start, end)}\nthis.handleInstalled = handleInstalled;`, context);
  return { handleInstalled: context.handleInstalled, storage, opened, calls };
}

test('first install writes defaults and opens onboarding', async () => {
  const { handleInstalled, storage, opened } = await loadInstallHandler({});
  await handleInstalled({ reason: 'install' });
  assert.deepEqual(JSON.parse(JSON.stringify(storage)), { pendingEncounters: [], difficulty: 'normal', syncStatus: 'unknown' });
  assert.deepEqual(opened, ['ext://id/popup/onboarding.html']);
});

test('install only fills keys that are missing', async () => {
  const { handleInstalled, storage } = await loadInstallHandler({ difficulty: 'hard', pendingEncounters: [{ id: 'e1' }] });
  await handleInstalled({ reason: 'install' });
  assert.equal(storage.difficulty, 'hard');
  assert.equal(storage.pendingEncounters.length, 1);
  assert.equal(storage.syncStatus, 'unknown');
});

// ─── Uninstall page (0.2.9) ───
async function loadUninstall({ frontendUrl = 'https://langsly.com', uiLanguage = 'en-US', api = true } = {}) {
  const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  const start = worker.indexOf('async function setUninstallUrl()');
  const end = worker.indexOf('// ─── Install / Startup');
  assert.ok(start >= 0 && end > start, 'setUninstallUrl missing');
  const urls = [];
  const warnings = [];
  const context = {
    console: { warn: (...args) => warnings.push(args) },
    String, RegExp,
    getConfig: async () => ({ apiBase: 'https://api.langsly.com/api', frontendUrl }),
    browser: {
      runtime: api ? { setUninstallURL: async url => { urls.push(url); } } : {},
      i18n: { getUILanguage: () => uiLanguage },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${worker.slice(start, end)}\nthis.setUninstallUrl = setUninstallUrl;`, context);
  await context.setUninstallUrl();
  return { urls, warnings };
}

test('the uninstall page is the configured site, in the UI language, set on every worker start', async () => {
  assert.deepEqual((await loadUninstall()).urls, ['https://langsly.com/extension/uninstalled']);
  assert.deepEqual((await loadUninstall({ uiLanguage: 'es-MX' })).urls, ['https://langsly.com/es/extension/uninstalled']);
  assert.deepEqual((await loadUninstall({ uiLanguage: 'estonian' })).urls, ['https://langsly.com/extension/uninstalled']);
  // A dev build follows its own frontendUrl; nothing is hard-coded.
  assert.deepEqual((await loadUninstall({ frontendUrl: 'http://localhost:3000' })).urls, ['http://localhost:3000/extension/uninstalled']);
  // A browser without the API (or one that throws) is not an error.
  const missing = await loadUninstall({ api: false });
  assert.deepEqual([missing.urls, missing.warnings], [[], []]);
  const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  assert.match(worker, /^void setUninstallUrl\(\);/m);
  assert.doesNotMatch(worker.slice(worker.indexOf('async function setUninstallUrl()'), worker.indexOf('// ─── Install / Startup')), /localhost|langsly\.com/);
});

test('extension and browser updates keep queued encounters, difficulty and sync status', async () => {
  for (const reason of ['update', 'chrome_update', 'browser_update', 'shared_module_update']) {
    const initial = { pendingEncounters: [{ id: 'e1' }], difficulty: 'hard', syncStatus: 'success' };
    const { handleInstalled, storage, opened, calls } = await loadInstallHandler(initial);
    await handleInstalled({ reason });
    assert.deepEqual(storage, initial, reason);
    assert.equal(opened.length, 0, reason);
    // An extension update sends the queued encounters and refreshes the words.
    assert.deepEqual(calls, reason === 'update' ? ['flush', 'sync'] : [], reason);
  }
});
