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
  const context = {
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
  return { handleInstalled: context.handleInstalled, storage, opened };
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

test('extension and browser updates keep queued encounters, difficulty and sync status', async () => {
  for (const reason of ['update', 'chrome_update', 'browser_update', 'shared_module_update']) {
    const initial = { pendingEncounters: [{ id: 'e1' }], difficulty: 'hard', syncStatus: 'success' };
    const { handleInstalled, storage, opened } = await loadInstallHandler(initial);
    await handleInstalled({ reason });
    assert.deepEqual(storage, initial, reason);
    assert.equal(opened.length, 0, reason);
  }
});
