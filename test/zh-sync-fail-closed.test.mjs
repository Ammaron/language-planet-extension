import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const sourceLanguage = await readFile(new URL('../shared/source-language.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function createSyncHarness(source = 'zh', request = async () => null) {
  const oldWord = { id: 'old-reviewed-word', search_language: source, term_language: 'es' };
  const state = {
    authToken: 'test-access-token', extensionSourceLanguage: source,
    difficulty: 'normal', vocabWords: [oldWord], wordCount: 1,
    matchableWordCount: 1, lastSync: 'previous-success', syncStatus: 'success',
  };
  const broadcasts = [];
  const context = vm.createContext({
    browser: {
      storage: { local: {
        get: async (keys) => Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]]),
        ),
        set: async values => Object.assign(state, values),
      } },
    },
    getTokens: async () => ({ access: state.authToken }),
    getExtensionSourceLanguage: async () => state.extensionSourceLanguage,
    getConfig: async () => ({ apiBase: 'https://example.test/api' }),
    authFetch: request,
    broadcastVocabulary: async words => broadcasts.push([...words]),
    countMatchableWords: words => words.length,
  });
  vm.runInContext(sourceLanguage, context, { filename: 'source-language.js' });
  vm.runInContext(worker.slice(
    worker.indexOf('let authGeneration = 0;'),
    worker.indexOf('function _getSessionSnapshot()'),
  ), context, { filename: 'worker-session.js' });
  // The sync records the dominant page-text language (Vocab Pass billing merge).
  vm.runInContext(worker.slice(worker.indexOf('function normalizeLanguageCode('), worker.indexOf('async function getExtensionSourceLanguage(')), context);
  const dominant = worker.indexOf('function dominantPageTextLanguage(');
  vm.runInContext(worker.slice(dominant, worker.indexOf('\n}', dominant) + 2), context);
  vm.runInContext(worker.slice(
    worker.indexOf('async function failVocabularySync('),
    worker.indexOf('// ─── Encounter Flush'),
  ), context, { filename: 'worker-sync.js' });
  return { state, broadcasts, sync: () => vm.runInContext('syncVocabulary()', context) };
}

test('failed Chinese sync removes stored and active page matches', async () => {
  for (const request of [
    async () => null,
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }),
    async () => ({ ok: true, json: async () => null }),
    async () => { throw new TypeError('offline'); },
  ]) {
    const { state, broadcasts, sync } = createSyncHarness('zh', request);
    await sync();
    assert.deepEqual(plain(state.vocabWords), []);
    assert.equal(state.wordCount, 0);
    assert.equal(state.matchableWordCount, 0);
    assert.equal(state.lastSync, null);
    assert.equal(state.syncStatus, 'failed');
    assert.deepEqual(broadcasts, [[]]);
  }
  const missingToken = createSyncHarness();
  missingToken.state.authToken = null;
  await missingToken.sync();
  assert.deepEqual(plain(missingToken.state.vocabWords), []);
  assert.deepEqual(missingToken.broadcasts, [[]]);
});

test('English sync keeps cached words available during a transient failure', async () => {
  const { state, broadcasts, sync } = createSyncHarness('en');
  await sync();
  assert.deepEqual(state.vocabWords.map(word => word.id), ['old-reviewed-word']);
  assert.equal(state.syncStatus, 'failed');
  assert.deepEqual(broadcasts, []);
});

test('an older Chinese response cannot restore words after a newer failed sync', async () => {
  let resolveFirst;
  let requests = 0;
  const request = () => (++requests === 1
    ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve(null));
  const { state, broadcasts, sync } = createSyncHarness('zh', request);
  const first = sync();
  for (let i = 0; i < 10 && !resolveFirst; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof resolveFirst, 'function');
  await sync();
  resolveFirst({ ok: true, json: async () => ({
    source_language: 'zh', source_language_ready: true,
    validation_versions: [2], words: [{
      id: 'new-reviewed-word', term: 'hola', translation: '你好',
      search_language: 'zh', term_language: 'es', source_forms: ['你好'],
    }],
  }) });
  await first;
  assert.deepEqual(plain(state.vocabWords), []);
  assert.equal(state.syncStatus, 'failed');
  assert.deepEqual(broadcasts, [[]]);
});

test('an older Chinese failure cannot erase a newer reviewed sync', async () => {
  let resolveFirst;
  let requests = 0;
  const reviewed = {
    source_language: 'zh', source_language_ready: true,
    validation_versions: [2], words: [{
      id: 'current-word', term: 'hola', translation: '你好',
      search_language: 'zh', term_language: 'es', source_forms: ['你好'],
    }],
  };
  const request = () => (++requests === 1
    ? new Promise(resolve => { resolveFirst = resolve; })
    : Promise.resolve({ ok: true, json: async () => reviewed }));
  const { state, broadcasts, sync } = createSyncHarness('zh', request);
  const first = sync();
  for (let i = 0; i < 10 && !resolveFirst; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(typeof resolveFirst, 'function');
  await sync();
  resolveFirst(null);
  await first;
  assert.deepEqual(plain(state.vocabWords).map(word => word.id), ['current-word']);
  assert.equal(state.syncStatus, 'success');
  assert.deepEqual(broadcasts.map(words => words.map(word => word.id)), [['current-word']]);
});

test('a superseded vocabulary broadcast sends no stale page update', async () => {
  let resolveTabs;
  let current = true;
  const sent = [];
  const context = vm.createContext({ browser: { tabs: {
    query: () => new Promise(resolve => { resolveTabs = resolve; }),
    sendMessage: async (id, message) => sent.push({ id, words: message.words }),
  } } });
  vm.runInContext(worker.slice(
    worker.indexOf('async function broadcastVocabulary('),
    worker.indexOf('const deviceConnection ='),
  ), context, { filename: 'worker-broadcast.js' });
  context.isCurrent = () => current;
  const pending = vm.runInContext('broadcastVocabulary([{ id: "stale" }], isCurrent)', context);
  current = false;
  resolveTabs([{ id: 1 }]);
  await pending;
  assert.deepEqual(sent, []);
});
