// Content-script lifecycle: idle cost when no vocabulary is usable, host matching,
// and SPA navigation checks that do not rely on patching history in the isolated world.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContentPage } from './zh-mini-dom.mjs';

const TALL = {
  id: 'c-gao', term: '高', translation: 'tall', term_language: 'zh-Hans', term_script: 'Hans', search_language: 'en',
  part_of_speech: 'adjective', source_forms: ['tall'], effective_runtime_triggers: ['tall'], searchable_forms: [],
  pronunciation_audio: null, validation_version: 2, example_sentence: '', example_translation: '',
  reading: { citation: ['gāo'], spoken: null, tone_note: '' }, measure_words: { countable: null, items: [] }, pinyin_stage: 'full',
  zh_target: { version: 1, reading: { citation: ['gāo'], spoken: null, tone_note: '' }, measure_words: { countable: null, items: [] },
    gloss: 'tall', usage_note: 'Reviewed.', chunk: null, review: { state: 'approved' } },
  meaning_key: '',
};
const approve = async items => items.map(item => ({ item_id: item.item_id, validation_version: 2, decision: 'replace',
  replacement_text: '高', vocabulary_ids: [String(item.candidate_ids[0])], method: 'test' }));
const HTML = '<p>She is tall.</p>';
const host = (hostname, pathname = '/article') => ({ href: `https://${hostname}${pathname}`, hostname, pathname });

async function page(options = {}) {
  const loaded = await loadContentPage({ html: HTML, words: [TALL], validate: approve, ...options });
  await loaded.settle();
  return loaded;
}

test('with no vocabulary the page watchers stop, and a vocabulary write restarts them', async () => {
  const loaded = await page({ words: [] });
  assert.equal(loaded.islands().length, 0);
  assert.equal(loaded.observers.size, 0, 'safety observer should stop while unavailable');
  assert.equal(loaded.intervals.size, 0);
  loaded.changeStorage({ vocabWords: [] });
  await loaded.settle();
  assert.equal(loaded.observers.size, 0, 'an empty vocabulary write keeps the page idle');
  loaded.changeStorage({ vocabWords: [TALL] });
  await loaded.settle();
  assert.equal(loaded.islands().length, 1);
  assert.ok(loaded.observers.size >= 1);
  assert.equal(loaded.intervals.size, 1);
});

test('subscription required stops watchers until access returns', async () => {
  const loaded = await page();
  assert.equal(loaded.islands().length, 1);
  loaded.window.browser.runtime.listener({ type: 'SUBSCRIPTION_REQUIRED' });
  await loaded.settle(2);
  assert.equal(loaded.islands().length, 0);
  assert.equal(loaded.observers.size, 0);
  assert.equal(loaded.intervals.size, 0);
  loaded.changeStorage({ subscriptionRequired: true });
  await loaded.settle(2);
  assert.equal(loaded.observers.size, 0);
  loaded.changeStorage({ subscriptionRequired: false });
  await loaded.settle();
  assert.equal(loaded.islands().length, 1);
});

test('logout stops watchers and a fresh vocabulary write after sign-in resumes', async () => {
  const loaded = await page();
  loaded.window.browser.runtime.listener({ type: 'AUTH_CLEARED' });
  loaded.changeStorage({ vocabWords: undefined });
  await loaded.settle(2);
  assert.equal(loaded.observers.size, 0);
  loaded.changeStorage({ vocabWords: [TALL] });
  loaded.window.browser.runtime.listener({ type: 'VOCAB_UPDATED', words: [TALL] });
  await loaded.settle();
  assert.equal(loaded.islands().length, 1);
});

test('site-disable entries match the host or its subdomains only', async () => {
  for (const [whitelist, active] of [
    [['example.test'], false],
    [['news.example.test'], false],
    [['s.example.test'], true],
    [['news.example.test.evil'], true],
    [['other.test'], true],
  ]) {
    const loaded = await page({ whitelist });
    assert.equal(loaded.islands().length, active ? 1 : 0, whitelist[0]);
  }
});

test('the local sensitive blocklist matches the host or its subdomains only', async () => {
  for (const [sensitiveBlocklist, active] of [[['example.test'], false], [['ample.test'], true], [['news'], true]]) {
    const loaded = await page({ storage: { sensitiveBlocklist } });
    assert.equal(loaded.islands().length, active ? 1 : 0, sensitiveBlocklist[0]);
  }
});

test('an SPA route change to a sensitive path is caught by the Navigation API event', async () => {
  const listeners = new Map();
  const navigation = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
  };
  const location = host('news.example.test');
  const loaded = await page({ location, navigation });
  assert.equal(loaded.islands().length, 1);
  assert.equal(typeof loaded.window.history.pushState, 'function');
  Object.assign(location, host('news.example.test', '/checkout'));
  listeners.get('currententrychange')();
  assert.equal(loaded.islands().length, 0);
});

test('without the Navigation API a low-frequency URL check catches route changes while active', async () => {
  const location = host('news.example.test');
  const loaded = await page({ location });
  assert.equal(loaded.islands().length, 1);
  assert.equal(loaded.intervals.size, 1);
  Object.assign(location, host('news.example.test', '/login'));
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(loaded.islands().length, 0);
  assert.equal(loaded.intervals.size, 0, 'URL polling stops once the page is no longer active');
});
