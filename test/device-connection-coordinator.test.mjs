import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../background/device-connection.js', import.meta.url), 'utf8');
function harness(saved = {}) {
  let time = 100000;
  const storage = structuredClone(saved);
  const calls = [], tabs = new Map(), commits = [];
  let tokenResponse = { error: 'authorization_pending' };
  let starts = 0;
  const browser = {
    storage: { local: {
      get: async (key) => typeof key === 'string' ? { [key]: structuredClone(storage[key]) } : structuredClone(storage),
      set: async (values) => Object.assign(storage, structuredClone(values)),
      remove: async (key) => { delete storage[key]; },
    } },
    alarms: { create: async (...args) => calls.push(['alarm', ...args]), clear: async () => {} },
    tabs: {
      create: async ({ url }) => { const tab = { id: tabs.size + 1, url }; tabs.set(tab.id, tab); calls.push(['tab', url]); return tab; },
      get: async (id) => { if (!tabs.has(id)) throw Error('closed'); return tabs.get(id); },
      update: async (id, updates) => { if (!tabs.has(id)) throw Error('closed'); Object.assign(tabs.get(id), updates); return tabs.get(id); },
    },
  };
  const context = vm.createContext({ URL, AbortSignal });
  vm.runInContext(source, context);
  const options = {
    browser, now: () => time, setTimer: () => 1, clearTimer: () => {},
    getConfig: async () => ({ apiBase: 'https://api.langsly.com/api', frontendUrl: 'https://langsly.com' }),
    complete: async (data, current) => { if (!current()) return { success: false }; commits.push(data); return { success: true }; },
    fetch: async (url) => {
      calls.push(['fetch', url]);
      if (url.endsWith('/start/')) {
        starts++;
        return { ok: true, json: async () => ({ device_code: `secret-${starts}`, user_code: `AAAA-BBB${starts}`, verification_uri: 'https://langsly.com/extension-connect', verification_uri_complete: `https://langsly.com/extension-connect?user_code=AAAA-BBB${starts}`, expires_in: 600, interval: 5 }) };
      }
      const data = typeof tokenResponse === 'function' ? await tokenResponse() : tokenResponse;
      return { ok: Boolean(data.access), json: async () => data };
    },
  };
  const make = () => context.createDeviceConnection(options);
  return { coordinator: make(), make, storage, calls, tabs, commits, advance: (ms) => { time += ms; }, respond: (response) => { tokenResponse = response; } };
}

test('deduplicates starts and approval tabs, preserves an in-progress login', async () => {
  const h = harness();
  await Promise.all([h.coordinator.begin('firefox_android', 'en'), h.coordinator.begin('firefox_android', 'en')]);
  await Promise.all([h.coordinator.openApproval(), h.coordinator.openApproval()]);
  assert.equal(h.calls.filter(c => c[0] === 'fetch').length, 1);
  assert.equal(h.tabs.size, 1);
  h.tabs.get(1).url = 'https://langsly.com/login?next=approval';
  await h.coordinator.openApproval();
  assert.equal(h.tabs.get(1).url, 'https://langsly.com/login?next=approval');
});

test('redeems in background without a visible connection page; never exposes secrets', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en');
  await h.coordinator.openApproval();
  h.respond({ access: 'access-secret', refresh: 'refresh-secret' });
  h.advance(5000);
  await Promise.all([h.coordinator.poll(), h.coordinator.poll()]);
  assert.equal(h.commits.length, 1);
  assert.equal((await h.coordinator.status()).status, 'connected');
  assert.equal(h.storage.extensionDeviceAuthorization.deviceCode, undefined);
  assert.doesNotMatch(JSON.stringify(await h.coordinator.status()), /secret|TabId/);
});

test('background recreation resumes pending authorization and honors polling throttle', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en');
  const resumed = h.make();
  await resumed.resume();
  assert.equal(h.calls.filter(c => c[0] === 'fetch').length, 1);
  h.respond({ access: 'access', refresh: 'refresh' });
  h.advance(6000);
  await resumed.resume();
  assert.equal((await resumed.status()).status, 'connected');
});

test('transient failures retain the request, slow_down is persisted, then connection recovers', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en');
  h.respond(() => { throw Error('offline'); });
  h.advance(5000); await h.coordinator.poll();
  assert.equal((await h.coordinator.status()).status, 'offline');
  assert.ok(h.storage.extensionDeviceAuthorization.deviceCode);
  h.respond({ error: 'slow_down', interval: 12 });
  h.advance(5000); await h.coordinator.poll();
  assert.equal(h.storage.extensionDeviceAuthorization.intervalMs, 12000);
  h.respond({ access: 'a', refresh: 'r' });
  h.advance(12000); await h.coordinator.poll();
  assert.equal((await h.coordinator.status()).status, 'connected');
});

test('cancel during redemption never commits late tokens', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en');
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  h.respond(() => new Promise(resolve => { release = resolve; reached(); }));
  h.advance(5000);
  const polling = h.coordinator.poll();
  await waiting;
  await h.coordinator.cancel();
  release({ access: 'a', refresh: 'r' });
  await polling;
  assert.equal(h.commits.length, 0);
  assert.equal((await h.coordinator.status()).status, 'idle');
});

test('bridge rejects other origins, frames, tabs, codes, and paths', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en'); await h.coordinator.openApproval();
  const message = { action: 'status', userCode: 'AAAA-BBB1' };
  const sender = { url: h.tabs.get(1).url, frameId: 0, tab: { id: 1 } };
  for (const invalid of [
    { ...sender, url: 'https://evil.example/extension-connect?user_code=AAAA-BBB1' },
    { ...sender, frameId: 1 },
    { ...sender, url: 'https://langsly.com/login?user_code=AAAA-BBB1' },
  ]) assert.equal((await h.coordinator.bridge(message, invalid)).status, 'unavailable');
  assert.equal((await h.coordinator.bridge({ ...message, userCode: 'AAAA-BBB2' }, sender)).status, 'unavailable');
  assert.equal((await h.coordinator.bridge(message, sender)).status, 'pending');
  assert.equal((await h.coordinator.bridge({ ...message, action: 'restart' }, { ...sender, tab: { id: 2 } })).status, 'unavailable');
});

test('verification in a new tab requires explicit resume before handoff', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en'); await h.coordinator.openApproval();
  const sender = { url: h.tabs.get(1).url, frameId: 0, tab: { id: 2 } };
  assert.equal((await h.coordinator.bridge({ action: 'status', userCode: 'AAAA-BBB1' }, sender)).status, 'resume');
  assert.equal(h.storage.extensionDeviceAuthorization.approvalTabId, 1);
  assert.equal((await h.coordinator.bridge({ action: 'resume', userCode: 'AAAA-BBB1' }, sender)).status, 'pending');
  assert.equal(h.storage.extensionDeviceAuthorization.approvalTabId, 2);
});

test('expired request restarts in the same approval tab without logging in again', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en'); await h.coordinator.openApproval();
  const sender = { url: h.tabs.get(1).url, frameId: 0, tab: { id: 1 } };
  h.advance(601000);
  assert.equal((await h.coordinator.status()).status, 'expired');
  await h.coordinator.bridge({ action: 'restart', userCode: 'AAAA-BBB1' }, sender);
  assert.equal(h.tabs.size, 1);
  assert.match(h.tabs.get(1).url, /AAAA-BBB2/);
  assert.equal((await h.coordinator.status()).status, 'pending');
});

test('denial stops polling and return-to-browsing requires a confirmed connection', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en'); await h.coordinator.openApproval();
  h.respond({ error: 'access_denied' }); h.advance(5000); await h.coordinator.poll();
  assert.equal((await h.coordinator.status()).status, 'denied');
  const count = h.calls.length;
  await h.coordinator.resume();
  assert.equal(h.calls.length, count);
  await h.coordinator.bridge({ action: 'return', userCode: 'AAAA-BBB1' }, { url: h.tabs.get(1).url, frameId: 0, tab: { id: 1 } });
  assert.equal(h.tabs.size, 1);
});

test('completion and a new-tab handoff cannot overwrite each other', async () => {
  const h = harness();
  await h.coordinator.begin('firefox_android', 'en'); await h.coordinator.openApproval();
  h.respond({ access: 'a', refresh: 'r' }); h.advance(5000);
  await Promise.all([
    h.coordinator.poll(),
    h.coordinator.bridge({ action: 'resume', userCode: 'AAAA-BBB1' }, { url: h.tabs.get(1).url, frameId: 0, tab: { id: 2 } }),
  ]);
  assert.equal(h.storage.extensionDeviceAuthorization.status, 'connected');
  assert.equal(h.storage.extensionDeviceAuthorization.approvalTabId, 2);
  assert.equal(h.commits.length, 1);
});

test('confirmed connection returns to the original reading tab', async () => {
  const h = harness({ connectionReturnTabId: 10 });
  h.tabs.set(10, { id: 10, url: 'https://example.test/article', active: false });
  await h.coordinator.begin('firefox_android', 'en'); await h.coordinator.openApproval();
  h.respond({ access: 'a', refresh: 'r' }); h.advance(5000); await h.coordinator.poll();
  const approvalTabId = h.storage.extensionDeviceAuthorization.approvalTabId;
  await h.coordinator.bridge({ action: 'return', userCode: 'AAAA-BBB1' }, { url: h.tabs.get(approvalTabId).url, frameId: 0, tab: { id: approvalTabId } });
  assert.equal(h.tabs.get(10).active, true);
  assert.equal(h.tabs.size, 2);
});
