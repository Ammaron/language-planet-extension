// Replacement density caps (0.2.9): at most three occurrences of one word per
// page and one swap per sentence, counted at scan time so a capped occurrence
// is never sent for validation. The real content scripts on a small page.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadContentPage } from './zh-mini-dom.mjs';

const word = (id, term, trigger) => ({ id, term, translation: trigger, search_language: 'en', term_language: 'es', part_of_speech: 'interjection',
  source_forms: [trigger], effective_runtime_triggers: [trigger], searchable_forms: [], pronunciation_audio: null, validation_version: 2 });
const HELLO = word('w-hello', 'hola', 'hello');
const GOODBYE = word('w-goodbye', 'adiós', 'goodbye');
const THANKS = word('w-thanks', 'gracias', 'thanks');
const TERMS = { 'w-hello': 'hola', 'w-goodbye': 'adiós', 'w-thanks': 'gracias' };
const candidate = item => String(item.candidate_ids[0]);
const verdict = item => ({ item_id: item.item_id, validation_version: 2, decision: 'replace',
  replacement_text: TERMS[candidate(item)], vocabulary_ids: [candidate(item)], method: 'test' });
const plain = value => JSON.parse(JSON.stringify(value));
const validations = loaded => loaded.sent.filter(message => message.type === 'VALIDATE_REPLACEMENTS');
const sentItems = loaded => plain(validations(loaded).flatMap(batch => batch.items.map(item => [item.matched_text, item.sentence])));

async function page(html, words = [HELLO, GOODBYE]) {
  const loaded = await loadContentPage({ html, words, validate: items => items.map(verdict) });
  await loaded.settle();
  return loaded;
}

test('the same word is swapped at most three times per page, and only once per sentence', async () => {
  // (Glue words such as "and" would group neighbours into one phrase, so the
  // repeats sit behind commas and semicolons.)
  const loaded = await page('<p>Hello there, friend; hello to you.</p><p>Hello again. Hello twice. Hello thrice.</p>');
  // Sentence one: the first "hello" only. Then one per sentence until the
  // word's third occurrence; "Hello thrice." is over the cap.
  assert.deepEqual(sentItems(loaded), [['Hello', 'Hello there, friend; hello to you.'], ['Hello', 'Hello again.'], ['Hello', 'Hello twice.']]);
  assert.equal(loaded.document.body.textContent, 'hola there, friend; hello to you.hola again. hola twice. Hello thrice.');
  assert.equal(loaded.document.querySelectorAll('.lp-validation-pending').length, 0);
});

test('two learner words in one sentence yield one swap; a second sentence gets the other', async () => {
  const loaded = await page('<p>Hello there, friend; goodbye for now.</p><p>Goodbye, friend; hello again.</p>');
  assert.deepEqual(sentItems(loaded), [['Hello', 'Hello there, friend; goodbye for now.'], ['Goodbye', 'Goodbye, friend; hello again.']]);
  assert.equal(loaded.document.body.textContent, 'hola there, friend; goodbye for now.adiós, friend; hello again.');
});

test('a phrase counts as one swap in its sentence and one occurrence of each word', async () => {
  const loaded = await page('<p>Hello goodbye everyone.</p><p>Hello again. Hello once more. Goodbye now.</p>');
  const items = plain(validations(loaded).flatMap(batch => batch.items.map(item => [item.matched_text, item.phrase])));
  // "Hello goodbye" is one phrase item; afterwards hello has two occurrences
  // left and goodbye two, each spent one per sentence.
  assert.deepEqual(items, [['Hello goodbye', true], ['Hello', false], ['Hello', false], ['Goodbye', false]]);
});

test('the caps start over when the page restarts for new vocabulary', async () => {
  // One block per sentence: a restored block keeps split text nodes, and only
  // the first of them gets sentence context on a rescan (pre-existing).
  const loaded = await page('<p>Hello one.</p><p>Hello two.</p><p>Hello three.</p><p>Hello four.</p>');
  assert.equal(validations(loaded).length, 1);
  assert.equal(validations(loaded)[0].items.length, 3);
  assert.equal(loaded.document.body.textContent, 'hola one.hola two.hola three.Hello four.');
  // New words: the page is restored and scanned again from a fresh budget.
  loaded.window.browser.runtime.listener({ type: 'VOCAB_UPDATED', words: [HELLO, GOODBYE, THANKS] });
  await loaded.settle();
  assert.equal(validations(loaded).length, 2);
  assert.equal(validations(loaded)[1].items.length, 3);
  assert.equal(loaded.document.body.textContent, 'hola one.hola two.hola three.Hello four.');
});

test('the caps are constants in content.js, applied before a span is queued, and reset with the page', async () => {
  const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
  assert.match(content, /const DENSITY_SAME_WORD_LIMIT = 3;/);
  assert.match(content, /const DENSITY_SENTENCE_LIMIT = 1;/);
  // Counted in replaceInTextNode, before buildPending*Span, never in the matcher.
  assert.match(content, /densityAllowed\(textNode,[\s\S]{0,400}buildPendingSingleSpan\(/);
  assert.match(content, /function restoreOriginalPageText\(\) \{[\s\S]{0,120}densityBudget = \{ words: new Map\(\), sentences: new WeakMap\(\) \};/);
  const matcher = await readFile(new URL('../content/matcher.js', import.meta.url), 'utf8');
  assert.doesNotMatch(matcher, /DENSITY_|densityBudget/);
});
