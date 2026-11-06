// Chinese islands: the page limits count what is pending or on show, and a
// "Wrong meaning?" report says "Flagged" only after it was really saved.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContentPage } from './zh-mini-dom.mjs';

const AUDIO = 'https://api.example.test/media/clip.mp3';

function row(id, term, trigger) {
  const reading = { citation: [...term].map(() => 'x'), spoken: null, tone_note: '' };
  const measureWords = { countable: null, items: [] };
  return {
    id, term, translation: trigger, term_language: 'zh-Hans', term_script: 'Hans', search_language: 'en',
    part_of_speech: 'adjective', source_forms: [trigger], effective_runtime_triggers: [trigger], searchable_forms: [],
    pronunciation_audio: AUDIO, validation_version: 2, example_sentence: '', example_translation: '',
    reading, measure_words: measureWords, pinyin_stage: 'full', meaning_key: '',
    zh_target: { version: 1, reading, measure_words: measureWords, gloss: trigger, usage_note: 'Note.', chunk: null, review: { state: 'approved' } },
  };
}

const WORDS = ['山 apple', '水 river', '火 garden', '木 window', '金 teacher', '土 market', '日 bridge', '月 doctor']
  .map((entry, index) => { const [term, trigger] = entry.split(' '); return row(`c${index}`, term, trigger); });
const TRIGGERS = WORDS.map(word => word.translation);
const TERMS = Object.fromEntries(WORDS.map(word => [word.id, word.term]));

// Rejects every sentence that says "skip"; approves the rest.
function validator(seen = []) {
  return async items => items.map(item => {
    seen.push(item);
    if (/skip/i.test(item.sentence)) {
      return { item_id: item.item_id, validation_version: 2, decision: 'keep', reason: 'none_fit', method: 'test' };
    }
    const id = String(item.candidate_ids[0]);
    return { item_id: item.item_id, validation_version: 2, decision: 'replace', replacement_text: TERMS[id], vocabulary_ids: [id], method: 'test' };
  });
}

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index} ${TRIGGERS[index % TRIGGERS.length]}.`);
const paragraphs = sentences => sentences.map(sentence => `<p>${sentence}</p>`).join('');

async function load(html, options = {}) {
  const loaded = await loadContentPage({ html, words: WORDS, validate: validator(options.seen), maxTimerMs: 5, ...options });
  await loaded.settle(40);
  return loaded;
}

test('words the validator rejects give their slots to later sentences', async () => {
  const loaded = await load(paragraphs([...lines(10, 'Skip'), ...lines(3, 'See')]));
  assert.equal(loaded.islands().length, 3);
});

test('the page never shows more than ten islands or the same word more than twice', async () => {
  const loaded = await load(paragraphs(lines(24, 'See')));
  assert.ok(loaded.islands().length <= 10, `got ${loaded.islands().length}`);
  const counts = {};
  for (const island of loaded.islands()) {
    const id = loaded.privateState.get(island).wordId;
    counts[id] = (counts[id] || 0) + 1;
  }
  assert.ok(Object.values(counts).every(count => count <= 2), JSON.stringify(counts));
});

test('rejections cannot send more than thirty occurrences per page to the validator', async () => {
  const seen = [];
  const loaded = await load(paragraphs(lines(80, 'Skip')), { seen });
  await loaded.settle(40);
  assert.ok(seen.length > 10, `only ${seen.length} tried`);
  assert.ok(seen.length <= 30, `sent ${seen.length}`);
  assert.equal(loaded.islands().length, 0);
});

test('a rejected sentence is never sent again on a later scan', async () => {
  const seen = [];
  await load(paragraphs([...lines(10, 'Skip'), ...lines(3, 'See')]), { seen });
  const sentences = seen.map(item => item.sentence);
  assert.equal(new Set(sentences).size, sentences.length);
});

test('in-app navigation starts the limits again', async () => {
  const location = { href: 'https://news.example.test/one', hostname: 'news.example.test', pathname: '/one' };
  const listeners = new Set();
  const navigation = { addEventListener: (_type, handler) => listeners.add(handler), removeEventListener: (_type, handler) => listeners.delete(handler) };
  const loaded = await load(paragraphs(lines(24, 'See')), { location, navigation });
  const before = loaded.islands().length;
  assert.ok(before > 0 && before <= 10);

  // A hash change is the same page.
  location.href = 'https://news.example.test/one#comments';
  for (const handler of listeners) handler();
  await loaded.settle(40);
  assert.equal(loaded.islands().length, before);

  location.href = 'https://news.example.test/two';
  location.pathname = '/two';
  for (const handler of listeners) handler();
  await loaded.settle(40);
  assert.ok(loaded.islands().length > before, `still ${loaded.islands().length}`);
});

test('a long page keeps showing words: the limits are per screenful of text', async () => {
  // Far more than one screenful (about 1800 characters).
  const filler = 'The quick brown fox jumps over a lazy dog while people talk about their day and walk along the river path.';
  const long = Array.from({ length: 80 }, (_, index) => `<p>${filler} See line ${index} ${TRIGGERS[index % TRIGGERS.length]}.</p>`).join('');
  const loaded = await load(long);
  assert.ok(loaded.islands().length > 10, `only ${loaded.islands().length}`);
  const counts = {};
  for (const island of loaded.islands()) {
    const state = loaded.privateState.get(island);
    counts[state.zhScreen] = (counts[state.zhScreen] || 0) + 1;
  }
  assert.ok(Object.keys(counts).length > 1, 'spread over more than one screen');
  assert.ok(Object.values(counts).every(count => count <= 10), JSON.stringify(counts));
});

test('a word glued to something else stays in English', async () => {
  for (const sentence of ["The apple's skin is thin.", 'An apple-shaped box.', 'A crab-apple tree.', "The rivers' apple' is odd."]) {
    const loaded = await load(`<p>${sentence}</p>`);
    assert.equal(loaded.islands().length, 0, sentence);
  }
  const plain = await load('<p>See the apple, please.</p>');
  assert.equal(plain.islands().length, 1);
});

test('only English text gets Chinese words', async () => {
  for (const html of ['<p lang="es">See the apple.</p>', '<div lang="fr"><p>See the apple.</p></div>', '<p lang="zh">See the apple.</p>']) {
    const loaded = await load(html);
    assert.equal(loaded.islands().length, 0, html);
  }
  for (const html of ['<p lang="en">See the apple.</p>', '<div lang="en-GB"><p>See the apple.</p></div>', '<p>See the apple.</p>']) {
    const loaded = await load(html);
    assert.equal(loaded.islands().length, 1, html);
  }
});

test('the browser language detector blocks a page only when it is confident', async () => {
  const answer = result => async () => result;
  const page = '<p>See the apple.</p>';
  const spanish = await load(page, { detectLanguage: answer({ isReliable: true, languages: [{ language: 'es', percentage: 99 }] }) });
  assert.equal(spanish.islands().length, 0);
  const unsure = await load(page, { detectLanguage: answer({ isReliable: false, languages: [{ language: 'es', percentage: 40 }] }) });
  assert.equal(unsure.islands().length, 1);
  const english = await load(page, { detectLanguage: answer({ isReliable: true, languages: [{ language: 'en', percentage: 99 }] }) });
  assert.equal(english.islands().length, 1);
  const broken = await load(page, { detectLanguage: async () => { throw new Error('unavailable'); } });
  assert.equal(broken.islands().length, 1);
});

test('a scan that swaps nothing leaves the page text nodes untouched', async () => {
  const loaded = await load('<p id="seen">Skip this apple.</p>');
  const paragraph = loaded.document.querySelector('p');
  await loaded.settle(10);
  const nodes = [...paragraph.childNodes];
  // Coming back to the tab scans the whole page again.
  const handlers = loaded.document.listeners.get('visibilitychange');
  assert.ok(handlers && handlers.size > 0);
  for (const handler of handlers) handler();
  await loaded.settle(10);
  assert.equal(paragraph.childNodes.length, nodes.length);
  assert.ok(nodes.every((node, index) => paragraph.childNodes[index] === node), 'text nodes were replaced');
  assert.equal(paragraph.textContent, 'Skip this apple.');
});

async function openPopup(options = {}) {
  const loaded = await load('<p>Please see the apple now.</p>', options);
  loaded.islands()[0].click();
  await loaded.settle(3);
  const popup = loaded.popup();
  const button = popup.querySelectorAll('button').find(node => /Wrong meaning/.test(node.textContent));
  assert.ok(button, 'report button');
  return { loaded, popup, button };
}

test('"Wrong meaning?" sends the sentence and the word position', async () => {
  const { loaded, button } = await openPopup();
  button.click();
  await loaded.settle(3);
  const report = loaded.sent.find(message => message.type === 'DISAMBIG_FEEDBACK');
  assert.equal(report.sentence, 'Please see the apple now.');
  assert.equal(report.match_offset, 15);
  assert.equal(report.matched_text, 'apple');
  assert.deepEqual([...report.candidate_ids], ['c0']);
  assert.equal(report.shown_word_id, 'c0');
});

test('"Flagged" shows only once the report is saved', async () => {
  const saved = await openPopup({ feedback: async () => ({ success: true }) });
  saved.button.click();
  await saved.loaded.settle(3);
  assert.match(saved.button.textContent, /Flagged/);
  assert.equal(saved.button.disabled, true);

  const failed = await openPopup({ feedback: async () => ({ success: false }) });
  failed.button.click();
  await failed.loaded.settle(3);
  assert.doesNotMatch(failed.button.textContent, /Flagged/);
  assert.equal(failed.button.disabled, false, 'can be sent again');
});
