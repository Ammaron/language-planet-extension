// Re-swaps after a sync. Two bugs made pages lose swaps over time:
// 1. A swapped word inside a block hid the rest of the block from the sentence
//    builder, so later words in other text nodes of that block never swapped
//    (and a restored block is always split into several text nodes).
// 2. Every sync re-signs the media links, so the page saw "new words" each hour
//    and restored and rescanned itself.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadContentPage } from './zh-mini-dom.mjs';

const word = (id, term, trigger, extra = {}) => ({ id, term, translation: trigger, search_language: 'en', term_language: 'es',
  part_of_speech: 'interjection', source_forms: [trigger], effective_runtime_triggers: [trigger], searchable_forms: [],
  pronunciation_audio: null, validation_version: 2, ...extra });
const HELLO = word('w-hello', 'hola', 'hello');
const GOODBYE = word('w-goodbye', 'adiós', 'goodbye');
const THANKS = word('w-thanks', 'gracias', 'thanks');
const TERMS = { 'w-hello': 'hola', 'w-goodbye': 'adiós', 'w-thanks': 'gracias' };
const candidate = item => String(item.candidate_ids[0]);
const verdict = item => ({ item_id: item.item_id, validation_version: 2, decision: 'replace',
  replacement_text: TERMS[candidate(item)], vocabulary_ids: [candidate(item)], method: 'test' });
const plain = value => JSON.parse(JSON.stringify(value));
const validations = loaded => loaded.sent.filter(message => message.type === 'VALIDATE_REPLACEMENTS');
const sentItems = batch => plain(batch.items.map(item => [item.matched_text, item.sentence]));

async function page(html, words = [HELLO, GOODBYE]) {
  const loaded = await loadContentPage({ html, words, validate: items => items.map(verdict) });
  await loaded.settle();
  return loaded;
}

test('a word after an inline element still gets its sentence once an earlier word in the block is swapped', async () => {
  const loaded = await page('<p>Hello there. <b>Goodbye</b> for now.</p>');
  const items = validations(loaded).flatMap(sentItems);
  assert.deepEqual(items, [['Hello', 'Hello there.'], ['Goodbye', 'Goodbye for now.']]);
  assert.equal(loaded.document.body.textContent, 'hola there. adiós for now.');
});

test('a restored block re-swaps every sentence, not only the first', async () => {
  const loaded = await page('<p>Hello one. Goodbye two.</p>');
  assert.equal(loaded.document.body.textContent, 'hola one. adiós two.');
  loaded.window.browser.runtime.listener({ type: 'VOCAB_UPDATED', words: [HELLO, GOODBYE, THANKS] });
  await loaded.settle();
  assert.equal(validations(loaded).length, 2);
  assert.deepEqual(sentItems(validations(loaded)[1]), [['Hello', 'Hello one.'], ['Goodbye', 'Goodbye two.']]);
  assert.equal(loaded.document.body.textContent, 'hola one. adiós two.');
});

test('re-signed media links are not new vocabulary: the page keeps its swaps', async () => {
  const signed = stamp => word('w-hello', 'hola', 'hello', {
    preferred_image: `https://api.langsly.com/api/media/assets/a1/content/?signature=a1%3Aactive%3A${stamp}&archive_state=active`,
    pronunciation_audio: `https://api.langsly.com/api/media/assets/a2/content/?signature=a2%3Aactive%3A${stamp}&archive_state=active`,
  });
  const loaded = await page('<p>Hello there.</p>', [signed('1xHVj0'), GOODBYE]);
  assert.equal(validations(loaded).length, 1);
  loaded.window.browser.runtime.listener({ type: 'VOCAB_UPDATED', words: [signed('1xHW9a'), GOODBYE] });
  await loaded.settle();
  assert.equal(validations(loaded).length, 1);
  assert.equal(loaded.document.body.textContent, 'hola there.');
});

test('the worker ignores re-signed media links when deciding whether the words changed', async () => {
  const source = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  const body = source.match(/function _stableJson\(value\) \{[\s\S]*?\n\}/);
  assert.ok(body, '_stableJson not found');
  const stableJson = new Function(`${body[0]}; return _stableJson;`)();
  const link = stamp => `https://api.langsly.com/api/media/assets/a1/content/?signature=a1%3Aactive%3A${stamp}&archive_state=active`;
  assert.equal(stableJson([{ preferred_image: link('1xHVj0') }]), stableJson([{ preferred_image: link('1xHW9a') }]));
  assert.notEqual(stableJson([{ preferred_image: link('1xHVj0') }]), stableJson([{ preferred_image: link('1xHVj0').replace('/a1/', '/a3/') }]));
});
