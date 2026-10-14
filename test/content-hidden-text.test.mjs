// LP-251: hidden DOM text is never scanned or sent as sentence context.
// LP-256: page-owned elements that reuse extension class names are left alone.
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

async function page(html) {
  const loaded = await loadContentPage({ html, words: [TALL], validate: approve });
  await loaded.settle();
  return loaded;
}
const validationText = loaded => JSON.stringify(loaded.sent.filter(message => message.type === 'VALIDATE_REPLACEMENTS'));

test('aria-hidden, [hidden], templates and screen-reader-only text are never scanned', async () => {
  for (const html of [
    '<div><p aria-hidden="true">She is tall.</p></div>',
    '<div><p hidden="">She is tall.</p></div>',
    '<div><p><span class="sr-only">She is tall.</span></p></div>',
    '<div><template><p>She is tall.</p></template></div>',
  ]) {
    const loaded = await page(html);
    assert.equal(loaded.islands().length, 0, html);
    assert.doesNotMatch(validationText(loaded), /tall/, html);
  }
});

test('a visible sentence next to hidden text sends no context at all', async () => {
  const loaded = await page('<div><p>She is tall.<span class="sr-only">Account 1234</span></p><p>He is tall.</p></div>');
  assert.doesNotMatch(validationText(loaded), /1234/);
  assert.equal(loaded.islands().length, 1, 'the clean paragraph still gets its word');
});

test('page elements that reuse extension class names are never flattened', async () => {
  const loaded = await page('<div><p><b class="lp-validation-pending lp-vocab-word">Menu</b></p><p>He is tall.</p></div>');
  const own = () => loaded.document.querySelectorAll('b');
  assert.equal(own().length, 1);
  assert.equal(loaded.islands().length, 1);
  assert.doesNotMatch(validationText(loaded), /Menu/);
  loaded.window.browser.runtime.listener({ type: 'SUBSCRIPTION_REQUIRED' });
  await loaded.settle(2);
  assert.equal(loaded.islands().length, 0, 'extension words are restored');
  assert.equal(own().length, 1, 'the page element survives the restore');
  assert.equal(own()[0].textContent, 'Menu');
});
