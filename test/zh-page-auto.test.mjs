// Automatic page language: the worker syncs a second word list for Simplified
// Chinese pages beside the usual one, and each page picks its list itself.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const sourceLanguage = await readFile(new URL('../shared/source-language.js', import.meta.url), 'utf8');
const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

const usualWord = { id: 'usual', term: 'hola', translation: 'hello', search_language: 'en', term_language: 'es', searchable_forms: ['hello'] };
const zhReady = {
  source_language: 'zh', source_language_ready: true, validation_versions: [2],
  words: [
    { id: 'en-hello', term: 'hello', translation: '你好', search_language: 'zh', term_language: 'en', source_forms: ['你好'] },
    { id: 'no-forms', term: 'bye', translation: '再见', search_language: 'zh', term_language: 'en', source_forms: [] },
  ],
};

function harness({ stored = {}, zhReply = zhReady, usualFails = false } = {}) {
  const state = {
    authToken: 'token', extensionSourceLanguage: 'en', difficulty: 'normal',
    vocabWords: [], wordCount: 0, matchableWordCount: 0, syncStatus: 'success', ...stored,
  };
  const requests = [];
  const broadcasts = [];
  const request = async url => {
    requests.push(url);
    if (url.includes('source_language=zh')) {
      if (zhReply instanceof Error) throw zhReply;
      return zhReply ? { ok: true, json: async () => zhReply } : { ok: false, status: 503 };
    }
    if (usualFails) return null;
    return { ok: true, json: async () => ({ source_language_ready: true, words: [usualWord] }) };
  };
  const context = vm.createContext({
    browser: { storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]])),
      set: async values => Object.assign(state, values),
    } } },
    getTokens: async () => ({ access: state.authToken }),
    getExtensionSourceLanguage: async () => state.extensionSourceLanguage,
    getConfig: async () => ({ apiBase: 'https://example.test/api' }),
    authFetch: request,
    broadcastVocabulary: async words => broadcasts.push(plain(words)),
    countMatchableWords: words => words.length,
  });
  vm.runInContext(sourceLanguage, context);
  vm.runInContext(worker.slice(worker.indexOf('let authGeneration = 0;'), worker.indexOf('function _getSessionSnapshot()')), context);
  vm.runInContext(worker.slice(worker.indexOf('function normalizeLanguageCode('), worker.indexOf('async function getExtensionSourceLanguage(')), context);
  const dominant = worker.indexOf('function dominantPageTextLanguage(');
  vm.runInContext(worker.slice(dominant, worker.indexOf('\n}', dominant) + 2), context);
  vm.runInContext(worker.slice(worker.indexOf('async function failVocabularySync('), worker.indexOf('// ─── Encounter Flush')), context);
  vm.runInContext('function _resetAutomaticBudget() {}', context);
  return { state, requests, broadcasts, sync: () => vm.runInContext('syncVocabulary()', context) };
}

test('automatic mode (the default) also syncs the Chinese-page list, keeping only usable rows', async () => {
  const { state, requests, sync } = harness();
  await sync();
  assert.equal(requests.length, 2);
  assert.match(requests[0], /source_language=en/);
  assert.match(requests[1], /source_language=zh/);
  assert.deepEqual(plain(state.vocabWords).map(word => word.id), ['usual']);
  assert.deepEqual(plain(state.vocabWordsZhPage).map(word => word.id), ['en-hello']);
});

test('a chosen page language syncs only that list and drops the Chinese-page list', async () => {
  for (const stored of [{ pageLanguageAuto: false }, { extensionSourceLanguage: 'es' }]) {
    const { state, requests, sync } = harness({ stored: { ...stored, vocabWordsZhPage: [{ id: 'old' }] } });
    await sync();
    assert.equal(requests.length, 1);
    assert.deepEqual(plain(state.vocabWordsZhPage), []);
  }
});

test('Chinese chosen by hand keeps a single list: its words are the usual list', async () => {
  const { requests, sync } = harness({ stored: { extensionSourceLanguage: 'zh' } });
  await sync();
  assert.equal(requests.length, 1);
  assert.match(requests[0], /source_language=zh/);
});

test('an unready or failed Chinese-page reply leaves the list empty, never stale', async () => {
  for (const zhReply of [null, new TypeError('offline'), { ...zhReady, source_language_ready: false }, { ...zhReady, validation_versions: [3] }]) {
    const { state, sync } = harness({ zhReply, stored: { vocabWordsZhPage: [{ id: 'stale' }] } });
    await sync();
    assert.deepEqual(plain(state.vocabWordsZhPage), []);
    assert.deepEqual(plain(state.vocabWords).map(word => word.id), ['usual']);
  }
});

test('a failed usual sync clears the Chinese-page list and tells open pages', async () => {
  const { state, broadcasts, requests, sync } = harness({
    usualFails: true, stored: { vocabWords: [usualWord], vocabWordsZhPage: [{ id: 'stale' }] },
  });
  await sync();
  assert.equal(requests.length, 1);
  assert.deepEqual(plain(state.vocabWordsZhPage), []);
  // The usual words survive a transient failure, as before.
  assert.deepEqual(plain(state.vocabWords).map(word => word.id), ['usual']);
  assert.equal(state.syncStatus, 'failed');
  assert.deepEqual(broadcasts.map(words => words.map(word => word.id)), [['usual']]);
});

test('the setting defaults to automatic, and old manual Spanish or Chinese choices stay manual', () => {
  const context = vm.createContext({});
  vm.runInContext(sourceLanguage, context);
  const auto = (flag, source) => vm.runInContext(`LangslySourceLanguage.isAutoPageLanguage(${JSON.stringify(flag)}, ${JSON.stringify(source)})`, context);
  assert.equal(auto(undefined, undefined), true);
  assert.equal(auto(undefined, 'en'), true);
  assert.equal(auto(undefined, 'es'), false);
  assert.equal(auto(undefined, 'zh'), false);
  assert.equal(auto(true, 'es'), true);
  assert.equal(auto(false, 'en'), false);
});

test('pages pick their list by their own language, with late text looked at again', () => {
  // Simplified tags decide at once; Traditional tags never use the list.
  assert.match(content, /if \(TRADITIONAL_TAG\.test\(tag\)\) return false;\s*if \(SIMPLIFIED_TAG\.test\(tag\)\) return true;/);
  // Without a tag, visible text decides; Japanese and Korean pages are excluded.
  assert.match(content, /han < CHINESE_PAGE_MIN_HAN \|\| JAPANESE_OR_KOREAN\.test\(sample\)/);
  // init and word updates both go through the page's own choice.
  assert.match(content, /let vocabWords = await wordsForThisPage\(storedWords, vocabWordsZhPage\);/);
  assert.match(content, /await wordsForThisPage\(usualWords, zhPageWords\)/);
  assert.match(content, /scheduleChinesePageRechecks\(vocabWordsZhPage\);/);
  // A page with only Chinese-page words wakes up when either list fills.
  assert.match(content, /const WORD_LIST_KEYS = \['vocabWords', 'vocabWordsZhPage'\];/);
});
