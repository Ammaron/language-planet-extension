// Service-worker hardening: alarm scheduling, sync de-duplication, endpoint
// allowlist, extension-page-only messages and the cached paused-site list.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const hosts = await readFile(new URL('../shared/hosts.js', import.meta.url), 'utf8');

function slice(startMarker, endMarker) {
  const start = worker.indexOf(startMarker);
  const end = worker.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} .. ${endMarker} missing`);
  return worker.slice(start, end);
}

function fakeAlarms(initial = {}) {
  const alarms = new Map(Object.entries(initial));
  const created = [];
  return {
    created,
    api: {
      get: async name => alarms.get(name),
      create: async (name, info) => { created.push([name, info.periodInMinutes]); alarms.set(name, { name, ...info }); },
      clear: async name => alarms.delete(name),
    },
  };
}

function loadScheduling({ storage = {}, alarms = {}, syncDelayMs = 0 } = {}) {
  const fake = fakeAlarms(alarms);
  const syncs = [];
  const context = {
    console,
    Date, Number, Math, Promise,
    migrateLegacyConfig: async () => {},
    syncVocabulary: () => { syncs.push(Date.now()); return new Promise(resolve => setTimeout(resolve, syncDelayMs)); },
    browser: {
      alarms: fake.api,
      storage: { local: { get: async keys => Object.fromEntries([].concat(keys).filter(k => k in storage).map(k => [k, storage[k]])) } },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${slice('// ─── Sync scheduling', 'browser.alarms.onAlarm.addListener')}
this.setupAlarms = setupAlarms; this.ensureAlarm = ensureAlarm; this.requestVocabularySync = requestVocabularySync;
this.normalizeSyncInterval = normalizeSyncInterval;`, context);
  return { context, created: fake.created, syncs };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('worker wake does not recreate alarms that already exist with the same period', async () => {
  const { context, created } = loadScheduling({
    storage: { syncInterval: 60 },
    alarms: { 'vocab-sync': { name: 'vocab-sync', periodInMinutes: 60 }, 'encounter-flush': { name: 'encounter-flush', periodInMinutes: 5 } },
  });
  await settle();
  created.length = 0;
  await context.setupAlarms();
  await context.setupAlarms();
  assert.deepEqual(created, [], 'existing alarms must keep their countdown');
});

test('missing alarms are created and a changed interval re-creates only the sync alarm', async () => {
  const { context, created } = loadScheduling({ storage: { syncInterval: 30 } });
  await settle();
  assert.deepEqual(created, [['vocab-sync', 30], ['encounter-flush', 5]]);
  created.length = 0;
  assert.equal(await context.ensureAlarm('vocab-sync', 30), false);
  assert.equal(await context.ensureAlarm('vocab-sync', 120), true);
  assert.deepEqual(created, [['vocab-sync', 120]]);
  assert.equal(context.normalizeSyncInterval(1), 15);
  assert.equal(context.normalizeSyncInterval('abc'), 60);
  assert.equal(context.normalizeSyncInterval(99999), 1440);
});

test('worker start syncs only when signed in and the last sync is overdue', async () => {
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const fresh = new Date(Date.now() - 60 * 1000).toISOString();
  assert.equal((await (async () => { const l = loadScheduling({ storage: { refreshToken: 'r', lastSync: stale } }); await settle(); return l.syncs.length; })()), 1);
  assert.equal((await (async () => { const l = loadScheduling({ storage: { refreshToken: 'r', lastSync: fresh } }); await settle(); return l.syncs.length; })()), 0);
  assert.equal((await (async () => { const l = loadScheduling({ storage: { lastSync: stale } }); await settle(); return l.syncs.length; })()), 0);
});

test('concurrent sync requests share one fetch and recent syncs are skipped for automatic triggers', async () => {
  const { context, syncs } = loadScheduling({ syncDelayMs: 30 });
  await settle();
  await Promise.all(Array.from({ length: 11 }, () => context.requestVocabularySync()));
  assert.equal(syncs.length, 1);
  const recent = loadScheduling({ storage: { lastSync: new Date().toISOString() } });
  await settle();
  await recent.context.requestVocabularySync({ maxAgeMs: 2 * 60 * 1000 });
  assert.equal(recent.syncs.length, 0);
});

function loadConfig() {
  const context = {
    URL,
    browser: { runtime: { id: 'ext-id', getURL: path => `chrome-extension://ext-id/${path}` } },
  };
  vm.createContext(context);
  vm.runInContext(`const LEGACY_DEFAULTS = { apiBase: 'http://localhost:8000/api', frontendUrl: 'http://localhost:3000' };
const DEFAULTS = { apiBase: 'https://api.langsly.com/api', frontendUrl: 'https://langsly.com' };
${slice('function normalizeUrl(url)', 'async function getConfig()')}
this.resolveConfigValue = resolveConfigValue; this.isExtensionPage = isExtensionPage;
this.EXTENSION_PAGE_ONLY_MESSAGES = EXTENSION_PAGE_ONLY_MESSAGES;`, context);
  return context;
}

test('stored endpoints outside https Langsly hosts fall back to production', () => {
  const { resolveConfigValue } = loadConfig();
  assert.equal(resolveConfigValue('https://api.langsly.com/api/', 'apiBase'), 'https://api.langsly.com/api');
  assert.equal(resolveConfigValue('https://www.langsly.com', 'frontendUrl'), 'https://www.langsly.com');
  for (const hostile of ['https://evil.test/api', 'http://api.langsly.com/api', 'https://api.langsly.com.evil.test/api',
    'https://user:pw@api.langsly.com/api', 'https://api.langsly.com:8443/api', 'javascript:alert(1)', 'http://localhost:8000/api']) {
    assert.equal(resolveConfigValue(hostile, 'apiBase'), 'https://api.langsly.com/api', hostile);
  }
});

test('privileged messages are accepted only from extension pages', () => {
  const { isExtensionPage, EXTENSION_PAGE_ONLY_MESSAGES } = loadConfig();
  for (const type of ['LOGOUT', 'SET_DIFFICULTY', 'UPDATE_CONFIG', 'TOGGLE_WHITELIST', 'SYNC_NOW']) {
    assert.ok(EXTENSION_PAGE_ONLY_MESSAGES.has(type), type);
  }
  assert.equal(isExtensionPage({ id: 'ext-id', url: 'chrome-extension://ext-id/popup/options.html', tab: { id: 4 } }), true);
  assert.equal(isExtensionPage({ id: 'ext-id', url: 'https://news.example.test/article', tab: { id: 4 } }), false);
  assert.equal(isExtensionPage({ id: 'other', url: 'chrome-extension://ext-id/popup/popup.html' }), false);
  assert.equal(isExtensionPage(undefined), false);
  assert.match(worker, /EXTENSION_PAGE_ONLY_MESSAGES\.has\(message\.type\) && !isExtensionPage\(sender\)/);
  // The worker no longer stores endpoints sent in UPDATE_CONFIG.
  assert.doesNotMatch(slice("if (message.type === 'UPDATE_CONFIG')", '// ─── Phrase Translation'), /apiBase|frontendUrl/);
});

function loadPausedSites({ responses, storage = {} }) {
  const calls = [];
  const context = {
    console, Date, Number, Promise, JSON, encodeURIComponent,
    authGeneration: 1,
    getConfig: async () => ({ apiBase: 'https://api.langsly.com/api' }),
    _setSessionStorage: async values => { Object.assign(storage, values); return true; },
    authFetch: async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url.replace('https://api.langsly.com/api', '')}`);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    browser: { storage: { local: { get: async key => (key in storage ? { [key]: storage[key] } : {}) } } },
  };
  vm.createContext(context);
  vm.runInContext(hosts, context);
  vm.runInContext(`${slice('// ─── Paused sites', '// ─── Sync scheduling')}
this.getPausedSites = getPausedSites; this.togglePausedSite = togglePausedSite;`, context);
  return { context, calls, storage };
}
const ok = body => ({ ok: true, status: 200, json: async () => body });
const fail = { ok: false, status: 503, json: async () => ({}) };

test('paused sites are cached, and an unknown list is reported as unknown (fail closed)', async () => {
  const online = loadPausedSites({ responses: [ok([{ id: 1, domain: 'x.com' }])] });
  const first = await online.context.getPausedSites();
  assert.deepEqual([...first.domains], ['x.com']);
  assert.equal(first.known, true);
  const second = await online.context.getPausedSites();
  assert.deepEqual([...second.domains], ['x.com']);
  assert.equal(online.calls.length, 1, 'fresh cache answers without a request');

  const offlineNoCache = loadPausedSites({ responses: [new Error('offline')] });
  assert.equal((await offlineNoCache.context.getPausedSites()).known, false);

  const offlineCached = loadPausedSites({ responses: [fail], storage: { pausedSites: { domains: ['x.com'], fetchedAt: 0 } } });
  const cached = await offlineCached.context.getPausedSites();
  assert.equal(cached.known, true);
  assert.deepEqual([...cached.domains], ['x.com']);
});

test('pausing reports failure when the server rejects it', async () => {
  const rejected = loadPausedSites({ responses: [fail, ok([])] });
  const result = await rejected.context.togglePausedSite('news.example.test', true);
  assert.equal(result.success, false);
  assert.equal(result.paused, false);

  const accepted = loadPausedSites({ responses: [ok({ id: 2 }), ok([{ id: 2, domain: 'news.example.test' }])] });
  const done = await accepted.context.togglePausedSite('news.example.test', true);
  assert.equal(done.success, true);
  assert.deepEqual([...accepted.storage.pausedSites.domains], ['news.example.test']);
});

test('resuming deletes the host entry and parent-domain entries only', async () => {
  const { context, calls } = loadPausedSites({ responses: [
    ok([{ id: 1, domain: 'example.test' }, { id: 2, domain: 'netflix.com' }, { id: 3, domain: 'ample.test' }]),
    ok({}), ok([{ id: 2, domain: 'netflix.com' }, { id: 3, domain: 'ample.test' }]),
  ] });
  const result = await context.togglePausedSite('news.example.test', false);
  assert.equal(result.success, true);
  assert.deepEqual(calls.filter(call => call.startsWith('DELETE')), ['DELETE /lessons/vocabpass/whitelist/1/delete/']);
});

test('expired-audio refreshes come only from content scripts and share the throttled sync', () => {
  const handler = slice("if (message.type === 'REFRESH_WORD_AUDIO')", "if (message.type === 'SET_DIFFICULTY')");
  assert.match(handler, /isOwnContentScript\(sender\)/);
  assert.match(handler, /requestVocabularySync\(\{ maxAgeMs: AUDIO_REFRESH_MIN_AGE_MS \}\)/);
  assert.doesNotMatch(handler, /syncVocabulary\(\)/);
});

test('API requests name the extension build in X-Langsly-Client', () => {
  const block = slice('const CLIENT_HEADER_VALUE', 'const MAX_EXTENSION_AUDIO_FETCH_BYTES');
  const context = { fetch: (url, init) => ({ url, init }), browser: { runtime: { getManifest: () => ({ version: '0.2.8' }) } } };
  vm.createContext(context);
  vm.runInContext(`${block}\nthis.withClientHeader = withClientHeader; this.apiFetch = apiFetch;`, context);
  assert.deepEqual({ ...context.withClientHeader({ Authorization: 'Bearer x' }) }, { Authorization: 'Bearer x', 'X-Langsly-Client': 'extension/0.2.8' });
  assert.equal(context.apiFetch('u', { headers: { 'Content-Type': 'application/json' } }).init.headers['X-Langsly-Client'], 'extension/0.2.8');
  assert.match(worker, /const headers = withClientHeader\(\{ \.\.\.options\.headers, Authorization/);
  assert.match(worker, /createDeviceConnection\(\{ browser, fetch: apiFetch/);
  assert.match(slice('const refreshPath = isExtensionRefreshToken', 'signal: controller.signal'), /withClientHeader\(/);
});
