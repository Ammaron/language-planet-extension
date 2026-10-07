// Service-worker side of Chinese targets: capability, readiness and fail-closed purge.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const sourceLanguage = await readFile(new URL('../shared/source-language.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function zhRow(overrides = {}) {
  return {
    id: 'c-thanks', term: '谢谢', translation: 'thank you', term_language: 'zh-Hans', term_script: 'Hans',
    search_language: 'en', source_forms: ['thank you'], pronunciation_audio: 'https://api.example.test/a.mp3',
    zh_target: { version: 1, reading: { citation: ['xiè', 'xie'], spoken: null }, review: { state: 'approved' } },
    ...overrides,
  };
}
const SPANISH = { id: 'es-hola', term: 'hola', translation: 'hello', term_language: 'es', search_language: 'en', source_forms: ['hello'] };

function harness(response, cached = [SPANISH, zhRow()]) {
  const state = {
    authToken: 'test-access-token', extensionSourceLanguage: 'en', difficulty: 'normal', vocabWords: cached,
    wordCount: cached.length, matchableWordCount: cached.length, lastSync: 'previous', syncStatus: 'success',
  };
  const requests = [];
  const broadcasts = [];
  const context = vm.createContext({
    browser: { storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]])),
      set: async values => Object.assign(state, values),
    } } },
    getTokens: async () => ({ access: state.authToken }),
    getExtensionSourceLanguage: async () => state.extensionSourceLanguage,
    getConfig: async () => ({ apiBase: 'https://example.test/api' }),
    authFetch: async (url) => { requests.push(url); return response(); },
    broadcastVocabulary: async words => broadcasts.push(plain(words)),
    countMatchableWords: words => words.length,
  });
  vm.runInContext(sourceLanguage, context, { filename: 'source-language.js' });
  vm.runInContext(worker.slice(worker.indexOf('let authGeneration = 0;'), worker.indexOf('function _getSessionSnapshot()')), context);
  // The sync records the dominant page-text language (Vocab Pass billing merge).
  vm.runInContext(worker.slice(worker.indexOf('function normalizeLanguageCode('), worker.indexOf('async function getExtensionSourceLanguage(')), context);
  const dominant = worker.indexOf('function dominantPageTextLanguage(');
  vm.runInContext(worker.slice(dominant, worker.indexOf('\n}', dominant) + 2), context);
  vm.runInContext(worker.slice(worker.indexOf('async function failVocabularySync('), worker.indexOf('// ─── Encounter Flush')), context);
  return { state, requests, broadcasts, sync: () => vm.runInContext('syncVocabulary()', context) };
}

const ok = data => () => ({ ok: true, json: async () => data });

test('the sync sends the zh-target capability', async () => {
  const run = harness(ok({ words: [], zh_target_enabled: false }));
  await run.sync();
  assert.match(run.requests[0], /[?&]capabilities=zh_target_v1(&|$)/);
  assert.match(worker, /encounters\/batch\/\?capabilities=\$\{ZH_TARGET_CAPABILITY\}/);
  assert.match(worker, /disambiguate\/\?capabilities=\$\{ZH_TARGET_CAPABILITY\}/);
  assert.match(worker, /disambiguate\/feedback\/\?capabilities=\$\{ZH_TARGET_CAPABILITY\}/);
});

test('only complete reviewed Simplified rows survive, and only while the gate is open', async () => {
  const rows = [
    SPANISH,
    zhRow(),
    zhRow({ id: 'unreviewed', zh_target: { ...zhRow().zh_target, review: { state: 'unreviewed' } } }),
    zhRow({ id: 'no-audio', pronunciation_audio: '' }),
    zhRow({ id: 'traditional', term: '謝謝', term_language: 'zh-Hant', term_script: 'Hant' }),
    zhRow({ id: 'bad-reading', zh_target: { ...zhRow().zh_target, reading: { citation: ['xiè'], spoken: null } } }),
    zhRow({ id: 'cjk-trigger', source_forms: ['谢谢'] }),
    zhRow({ id: 'no-triggers', source_forms: [] }),
    zhRow({ id: 'not-han', term: 'xie xie' }),
  ];
  const open = harness(ok({ words: rows, zh_target_enabled: true }));
  await open.sync();
  assert.deepEqual(open.state.vocabWords.map(word => word.id), ['es-hola', 'c-thanks']);
  const closed = harness(ok({ words: rows, zh_target_enabled: false }));
  await closed.sync();
  assert.deepEqual(closed.state.vocabWords.map(word => word.id), ['es-hola']);
  const legacy = harness(ok({ words: [SPANISH, { ...zhRow(), term_language: 'zh', zh_target: undefined }] }));
  await legacy.sync();
  assert.deepEqual(legacy.state.vocabWords.map(word => word.id), ['es-hola']);
});

test('a failed sync purges Chinese targets from storage and pages but keeps cached Spanish words', async () => {
  for (const response of [() => null, () => ({ ok: false, status: 503 }), () => { throw new TypeError('offline'); }]) {
    const run = harness(response);
    await run.sync();
    assert.deepEqual(run.state.vocabWords.map(word => word.id), ['es-hola']);
    assert.equal(run.state.syncStatus, 'failed');
    assert.deepEqual(run.broadcasts.map(words => words.map(word => word.id)), [['es-hola']]);
  }
  const spanishOnly = harness(() => null, [SPANISH]);
  await spanishOnly.sync();
  assert.deepEqual(spanishOnly.broadcasts, []);
});

test('no Spanish defaults remain in the worker or popup', async () => {
  const popup = await readFile(new URL('../content/popup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(worker, /source_language \|\| 'es'|target_language \|\| 'es'/);
  assert.doesNotMatch(popup, /\|\| 'es'/);
  assert.doesNotMatch(popup, /utterance\.lang = termLanguage \|\| /);
});
