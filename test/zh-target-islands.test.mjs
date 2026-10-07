// Chinese as a target on English pages: islands, not bridges.
// The validation stub says "replace" for every item, so these tests prove the
// client-side guards hold even when a server approves too much.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadContentPage } from './zh-mini-dom.mjs';

const AUDIO = 'https://api.example.test/media/clip.mp3';

function row(id, term, gloss, partOfSpeech, triggers, reading, extra = {}) {
  const profile = {
    version: 1,
    reading: { citation: reading, spoken: null, tone_note: '', ...(extra.reading || {}) },
    measure_words: extra.measure_words || { countable: null, items: [] },
    gloss,
    usage_note: extra.usage_note || `Reviewed note for ${term}.`,
    chunk: extra.chunk === undefined ? null : extra.chunk,
    review: { state: 'approved' },
  };
  return {
    id, term, translation: gloss, term_language: 'zh-Hans', term_script: 'Hans', search_language: 'en',
    part_of_speech: partOfSpeech, source_forms: triggers, effective_runtime_triggers: triggers, searchable_forms: [],
    pronunciation_audio: extra.audio === undefined ? AUDIO : extra.audio, validation_version: 2,
    example_sentence: extra.example_sentence || '', example_translation: '',
    reading: profile.reading, measure_words: profile.measure_words, pinyin_stage: extra.pinyin_stage || 'full',
    zh_target: profile, meaning_key: extra.meaning_key || '',
  };
}

const BOOK = row('c-book', '书', 'book', 'noun', ['book'], ['shū'], {
  measure_words: { countable: true, items: [{ hanzi: '本', pinyin: ['běn'], preferred: true, example: '一本书',
    example_citation: ['yī', 'běn', 'shū'], example_spoken: ['yì', 'běn', 'shū'] }] },
  chunk: { zh: '一本书', citation: ['yī', 'běn', 'shū'], spoken: ['yì', 'běn', 'shū'], en: 'a book' },
  example_sentence: 'UNREVIEWED EXAMPLE',
});
const HELLO = row('c-hello', '你好', 'hello', 'phrase', ['hello'], ['nǐ', 'hǎo'],
  { reading: { spoken: ['ní', 'hǎo'], tone_note: 'Written nǐ hǎo, said ní hǎo.' } });
const THANKS = row('c-thanks', '谢谢', 'thank you', 'phrase', ['thank you', 'thanks'], ['xiè', 'xie']);
const KNOW_PERSON = row('c-renshi', '认识', 'to know (a person)', 'verb', ['know'], ['rèn', 'shi'],
  { chunk: { zh: '我认识他', citation: ['wǒ', 'rèn', 'shi', 'tā'], spoken: null, en: 'I know him' } });
const KNOW_FACT = row('c-zhidao', '知道', 'to know (a fact)', 'verb', ['know'], ['zhī', 'dao'],
  { chunk: { zh: '我知道', citation: ['wǒ', 'zhī', 'dao'], spoken: null, en: 'I know' } });
const EAT = row('c-chi', '吃', 'to eat', 'verb', ['eat', 'eats'], ['chī'],
  { chunk: { zh: '吃饭', citation: ['chī', 'fàn'], spoken: null, en: 'to eat a meal' } });
const HAPPY = row('c-kaixin', '开心', 'happy', 'adjective', ['happy'], ['kāi', 'xīn'],
  { chunk: { zh: '很开心', citation: ['hěn', 'kāi', 'xīn'], spoken: null, en: 'very happy' } });
const GOOD = row('c-hao', '好', 'good', 'adjective', ['good'], ['hǎo'],
  { chunk: { zh: '很好', citation: ['hěn', 'hǎo'], spoken: null, en: 'very good' } });
const TALL = row('c-gao', '高', 'tall', 'adjective', ['tall'], ['gāo'],
  { chunk: { zh: '他很高', citation: ['tā', 'hěn', 'gāo'], spoken: null, en: 'he is tall' } });
// A row whose gloss is "May" but which has no reviewed trigger "may".
const MAY_MONTH = row('c-wuyue', '五月', 'May', 'noun', [], ['wǔ', 'yuè']);
const ALL = [BOOK, HELLO, THANKS, KNOW_PERSON, KNOW_FACT, EAT, HAPPY, GOOD, TALL, MAY_MONTH];
const TERMS = Object.fromEntries(ALL.map(word => [word.id, word.term]));

function approveAll(seen) {
  return async items => items.map(item => {
    seen?.push(item);
    const id = String(item.candidate_ids[0]);
    return { item_id: item.item_id, validation_version: 2, decision: 'replace', replacement_text: TERMS[id] ?? item.proposed_replacement,
      vocabulary_ids: [id], method: 'test' };
  });
}

async function page(html, { words = ALL, storage, validate, audio } = {}) {
  const seen = [];
  const loaded = await loadContentPage({ html, words, storage, audio, validate: validate || approveAll(seen) });
  await loaded.settle();
  return { ...loaded, seen };
}

const text = node => node.textContent;
// What a reader sees as running text: ruby annotations (<rt>) excluded.
const visibleText = node => (node.nodeType === 3 ? node.data
  : node.tagName === 'RT' ? '' : node.childNodes.map(visibleText).join(''));
const islandTerms = loaded => loaded.islands().map(island => island.querySelector('ruby')
  ? island.querySelector('ruby').childNodes.filter(node => node.nodeType === 3).map(text).join('')
  : text(island));

test('trap fixtures yield only isolated reviewed islands', async () => {
  const traps = [
    ['I bought three books today.', []],
    ['We need two books for class.', []],
    ['Please bring one book tomorrow.', []],
    ['There are several books here.', []],
    ['She is tall.', ['高']],
    ["It's raining again today.", []],
    ['I ate already.', []],
    ['They play piano and wear glasses.', []],
    ['This one is bigger.', []],
    ['You are good at this.', ['好']],
    ['He eats rice every day.', ['吃']],
    ['We met in May last year.', []],
    ['I am not happy about it.', ['开心']],
  ];
  for (const [sentence, expected] of traps) {
    const loaded = await page(`<p>${sentence}</p>`);
    assert.deepEqual(islandTerms(loaded), expected, sentence);
    const body = visibleText(loaded.document.body);
    assert.doesNotMatch(body, /是|们|了|本|两|二/, `${sentence} composed Chinese: ${body}`);
  }
});

test('the subject and "not" stay in English around an island', async () => {
  const eats = await page('<p>He eats rice every day.</p>');
  assert.match(visibleText(eats.document.body), /^He /);
  const happy = await page('<p>I am not happy about it.</p>');
  assert.match(visibleText(happy.document.body), /not 开心/);
});

test('"you are good" never becomes 你好: only the reviewed adjective island appears', async () => {
  const loaded = await page('<p>You are good at this.</p>');
  assert.equal(visibleText(loaded.document.body).includes('你'), false);
  assert.deepEqual(islandTerms(loaded), ['好']);
});

test('"thank you" becomes 谢谢 through the single-match path', async () => {
  const loaded = await page('<p>Thank you for coming.</p>');
  assert.deepEqual(islandTerms(loaded), ['谢谢']);
  const item = loaded.seen[0];
  assert.equal(item.phrase, false);
  assert.equal(item.matched_text, 'Thank you');
  assert.deepEqual([...item.component_ids], ['c-thanks']);
  assert.equal(item.target_language, 'zh-Hans');
});

test('a sense-ambiguous trigger sends the complete reviewed meaning set', async () => {
  const loaded = await page('<p>I know him well.</p>');
  const item = loaded.seen.find(entry => entry.matched_text === 'know');
  assert.deepEqual([...item.candidate_ids].sort(), ['c-renshi', 'c-zhidao']);
});

test('islands never bridge across nodes or punctuation; the leftmost wins', async () => {
  const loaded = await page('<p><b>Thank you.</b> <i>Hello!</i></p>');
  assert.deepEqual(islandTerms(loaded), ['谢谢']);
  assert.match(visibleText(loaded.document.body), /谢谢\. Hello!/);
  const separate = await page('<p>Thank you.</p><p>Hello!</p>');
  assert.deepEqual(islandTerms(separate), ['谢谢', '你好']);
});

test('a later async apply next to an existing island reverts itself', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const loaded = await loadContentPage({
    html: '<p><b>Thank you.</b> <i>Hello!</i></p>', words: ALL,
    validate: async items => {
      const results = await approveAll()(items);
      // Deliver "hello" first and "thank you" later.
      if (items.some(item => item.matched_text === 'Thank you')) await gate;
      return results;
    },
  });
  await loaded.settle(4);
  release();
  await loaded.settle();
  assert.equal(loaded.islands().length, 1);
});

test('nouns right after numbers and quantity words are skipped', async () => {
  for (const sentence of ['I own 3 books.', 'A dozen books arrived.', 'A couple of books fell.', 'Few books remain.']) {
    const loaded = await page(`<p>${sentence}</p>`);
    assert.deepEqual(islandTerms(loaded), [], sentence);
  }
  const plain = await page('<p>I bought a book.</p>');
  assert.deepEqual(islandTerms(plain), ['书']);
});

test('render uses only the synced reviewed term, with lang and translate set', async () => {
  const composed = await page('<p>Thank you for coming.</p>', {
    validate: async items => items.map(item => ({ item_id: item.item_id, validation_version: 2, decision: 'replace',
      replacement_text: '谢谢你', vocabulary_ids: ['c-thanks'], method: 'test' })),
  });
  assert.equal(composed.islands().length, 0);
  const loaded = await page('<p>Thank you for coming.</p>');
  const [island] = loaded.islands();
  assert.equal(island.getAttribute('lang'), 'zh-Hans');
  assert.equal(island.getAttribute('translate'), 'no');
});

test('every pinyin_stage × mode combination', async () => {
  const expected = {
    auto: { full: 'lp-pinyin', faded: 'lp-pinyin lp-pinyin-faded', hidden: null },
    always: { full: 'lp-pinyin', faded: 'lp-pinyin', hidden: 'lp-pinyin' },
    popup: { full: null, faded: null, hidden: null },
  };
  for (const [mode, stages] of Object.entries(expected)) {
    for (const [stage, rubyClass] of Object.entries(stages)) {
      const words = [{ ...HELLO, pinyin_stage: stage }];
      const loaded = await page('<p>Hello there, friend.</p>', { words, storage: { zhPinyinMode: mode } });
      const [island] = loaded.islands();
      const ruby = island.querySelector('ruby');
      assert.equal(ruby ? ruby.className : null, rubyClass, `${mode}/${stage}`);
      if (ruby) assert.deepEqual(ruby.querySelectorAll('rt').map(text), ['nǐ', 'hǎo']);
    }
  }
});

test('two taps within a week step a hidden word back toward full pinyin', async () => {
  const now = Date.now();
  const words = [{ ...HELLO, pinyin_stage: 'hidden' }];
  const loaded = await page('<p>Hello there, friend.</p>', {
    words, storage: { zhPinyinTaps: { 'c-hello': [now - 1000, now - 2000] } },
  });
  assert.equal(loaded.islands()[0].querySelector('ruby').className, 'lp-pinyin lp-pinyin-faded');
  loaded.islands()[0].click();
  await loaded.settle(2);
  assert.equal(loaded.state.zhPinyinTaps['c-hello'].length, 3);
});

test('density: one island per sentence, ten per page, the same word at most twice', async () => {
  const oneSentence = await page('<p>Thank you and hello, a good book.</p>');
  assert.equal(oneSentence.islands().length, 1);
  const repeated = await page(['<p>A book.</p>', '<p>A book.</p>', '<p>A book.</p>'].join(''));
  assert.equal(repeated.islands().length, 2);
  const many = Array.from({ length: 14 }, (_, index) => `<p>Line ${index}: ${['Hello.', 'Thanks.', 'Good.', 'Tall.', 'Happy.', 'Know.', 'Eat.'][index % 7]}</p>`);
  const busy = await page(many.join(''));
  assert.ok(busy.islands().length <= 10, `got ${busy.islands().length}`);
});

test('no islands in Chinese, Japanese or Korean blocks, or blocks that already hold CJK', async () => {
  for (const html of ['<p lang="zh">Thank you for coming.</p>', '<div lang="ja-JP"><p>Thank you for coming.</p></div>',
    '<p lang="ko">Thank you.</p>', '<p>Thank you (谢谢) for coming.</p>']) {
    const loaded = await page(html);
    assert.equal(loaded.islands().length, 0, html);
  }
});

test('Chinese islands never appear alongside Spanish ones', async () => {
  const spanish = { id: 'es-libro', term: 'libro', translation: 'book', term_language: 'es', search_language: 'en',
    source_forms: ['book'], effective_runtime_triggers: ['book'], part_of_speech: 'noun', validation_version: 2 };
  const loaded = await page('<p>I read a book.</p><p>Thank you.</p>', {
    words: [spanish, BOOK, THANKS],
    validate: async items => items.map(item => ({ item_id: item.item_id, validation_version: 2, decision: 'replace',
      replacement_text: { 'es-libro': 'libro', 'c-book': '书', 'c-thanks': '谢谢' }[item.candidate_ids[0]],
      vocabulary_ids: [item.candidate_ids[0]], method: 'test' })),
  });
  assert.equal(visibleText(loaded.document.body).includes('libro'), false);
  assert.deepEqual(islandTerms(loaded), ['书', '谢谢']);
});

test('the popup is phrase-first and built from reviewed rows only', async () => {
  const loaded = await page('<p>I know him well.</p>');
  loaded.islands()[0].click();
  await loaded.settle(3);
  const popup = loaded.popup();
  const popupText = text(popup);
  const shownTerm = islandTerms(loaded)[0];
  if (shownTerm === '认识') {
    assert.match(popupText, /我认识他/);
    assert.match(popupText, /知道 = to know \(a fact\)/);
  } else {
    assert.match(popupText, /我知道/);
    assert.match(popupText, /认识 = to know \(a person\)/);
  }
  assert.ok(popup.querySelectorAll('[lang]').every(node => node.getAttribute('lang') === 'zh-Hans'));
  assert.equal(popup.querySelectorAll('.lp-phrase-word-row').length, 0, 'no alternative chooser');
});

test('the chunk sits under the word; the measure word and both readings show; an unreviewed example is hidden', async () => {
  const loaded = await page('<p>I bought a book yesterday.</p>');
  loaded.islands()[0].click();
  await loaded.settle(3);
  const popup = loaded.popup();
  const popupText = text(popup);
  assert.match(popupText, /一本书/);
  assert.match(popupText, /said: yì běn shū/);
  assert.match(popupText, /Measure word: 本 běn/);
  assert.doesNotMatch(popupText, /UNREVIEWED EXAMPLE/);
  const children = popup.childNodes.map(node => node.className);
  assert.ok(children.indexOf('lp-zh-chunk') === children.indexOf('lp-zh-reading') + 1, children.join(' | '));

  const hello = await page('<p>Hello there, friend.</p>');
  hello.islands()[0].click();
  await hello.settle(3);
  assert.match(text(hello.popup()), /nǐ hǎo/);
  assert.match(text(hello.popup()), /said: ní hǎo/);
});

test('Chinese speech synthesis never fires, with missing audio or an audio 404', async () => {
  const missing = await page('<p>Hello there, friend.</p>', { words: [{ ...HELLO, pronunciation_audio: '' }] });
  missing.islands()[0].click();
  await missing.settle(3);
  const button = missing.popup().querySelector('.lp-popup-listen');
  assert.equal(button.disabled, true);
  button.click();
  await missing.settle(3);
  assert.equal(missing.spoken.length, 0);

  const broken = await page('<p>Hello there, friend.</p>', { audio: { fail: true } });
  broken.islands()[0].click();
  await broken.settle(3);
  broken.popup().querySelector('.lp-popup-listen').click();
  await broken.settle(4);
  assert.equal(broken.played.length, 1);
  assert.equal(broken.spoken.length, 0);
  assert.match(text(broken.popup().querySelector('.lp-popup-listen')), /Audio unavailable/);
});

test('triggers come only from reviewed source forms, never the gloss', async () => {
  const loaded = await page('<p>We met in May last year.</p>');
  assert.equal(loaded.seen.length, 0);
});
