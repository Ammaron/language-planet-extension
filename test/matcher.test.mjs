import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const matcherSource = fs.readFileSync(
  path.join(process.cwd(), 'content/matcher.js'),
  'utf8',
);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMatcher(words, grammarOverrides = {}, intl = Intl) {
  const sandbox = {
    window: {
      GrammarRules: {
        isGlueGap: () => false,
        MAX_GAP_CHARS: 30,
        MIN_PHRASE_WORDS: 2,
        ...grammarOverrides,
      },
    },
    console,
    Date: { now: () => Date.parse('2026-04-15T00:00:00Z') },
    Set,
    Map,
    Math,
    String,
    Number,
    Array,
    Object,
    RegExp,
    Intl: intl,
  };

  vm.runInNewContext(matcherSource, sandbox, { filename: 'matcher.js' });
  const VocabMatcher = sandbox.window.VocabMatcher;
  return new VocabMatcher(words, { rotationSalt: 'test-salt' });
}

test('Chinese page matches require segment boundaries and leave partial compounds unchanged', () => {
  const words = [
    { id: 'hello', term: 'hola', translation: '你好', search_language: 'zh', term_language: 'es', source_forms: ['你好'] },
    { id: 'city', term: 'Shanghái', translation: '上海', search_language: 'zh', term_language: 'es', source_forms: ['上海'] },
    { id: 'long', term: 'hola mundo', translation: '你好世界', search_language: 'zh', term_language: 'es', source_forms: ['你好世界'] },
  ];
  const engine = createMatcher(words);
  assert.deepEqual(plain(engine.findMatches('你好，世界').singles.map(match => match.word.id)), ['hello']);
  assert.deepEqual(plain(engine.findMatches('你好世界').singles.map(match => match.word.id)), ['long']);
  assert.equal(engine.findMatches('上海市').singles.length, 0);
  assert.equal(createMatcher(words, {}, {}).findMatches('你好').singles.length, 0);
});

test('Chinese page matching uses authored source forms across punctuation, not a display gloss', () => {
  const engine = createMatcher([
    { id: 'reviewed', term: 'hola', translation: '问候', search_language: 'zh', term_language: 'es', source_forms: ['你好'] },
    { id: 'gloss-only', term: 'saludo', translation: '问候', search_language: 'zh', term_language: 'es', source_forms: [] },
  ]);
  assert.deepEqual(plain(engine.findMatches('（你好）！问候').singles.map(match => match.word.id)), ['reviewed']);
  assert.equal(engine.findMatches('问候').singles.length, 0);
  const mismatchedRuntime = createMatcher([{
    id: 'reviewed', term: 'hola', translation: '你好', search_language: 'zh',
    term_language: 'es', source_forms: ['你好'], effective_runtime_triggers: ['世界'],
  }]);
  assert.deepEqual(plain(mismatchedRuntime.findMatches('你好').singles.map(match => match.word.id)), ['reviewed']);
  assert.equal(mismatchedRuntime.findMatches('世界').singles.length, 0);
});

test('Chinese adjacent source forms stay separate instead of forming an unreviewed phrase', () => {
  const matcher = createMatcher([
    { id: 'hello', term: 'hola', translation: '你好', search_language: 'zh', term_language: 'es', source_forms: ['你好'] },
    { id: 'world', term: 'mundo', translation: '世界', search_language: 'zh', term_language: 'es', source_forms: ['世界'] },
  ], { isGlueGap: () => true });
  const result = matcher.findMatches('你好世界');
  assert.deepEqual(plain(result.singles.map(match => match.original)), ['你好', '世界']);
  assert.equal(result.phrases.length, 0);
});

test('Chinese sentence context stops at Chinese terminal punctuation', () => {
  const matcher = createMatcher([]);
  const text = '前面。请说你好，朋友！后面。';
  assert.deepEqual(plain(matcher._extractSentence(text, text.indexOf('你好'))), {
    sentence: '请说你好，朋友！',
    offset: 2,
  });
  assert.deepEqual(plain(matcher._extractSentence(text, text.indexOf('后面'))), {
    sentence: '后面。',
    offset: 0,
  });
});

test('v3 proposes a complete copular phrase without introducing content vocabulary', () => {
  const words = [
    { id: 'doctor', term: 'doctor', translation: 'doctor', search_language: 'en', term_language: 'es', part_of_speech: 'noun', validation_version: 3, effective_runtime_triggers: ['doctor'] },
    { id: 'ser', term: 'es', translation: 'is', search_language: 'en', term_language: 'es', part_of_speech: 'verb', validation_version: 3, effective_runtime_triggers: ['is'] },
  ];
  const result = createMatcher(words).findMatches('She is not a doctor.');
  assert.equal(result.singles.length, 1);
  assert.equal(result.singles[0].original, 'She is not a doctor');
  assert.deepEqual([...result.singles[0].word._candidateIds].sort(), ['doctor', 'ser']);
  const nounOnly = createMatcher([words[0]]).findMatches('She is a doctor.');
  assert.equal(nounOnly.singles[0].original, 'a doctor');
});

test('v3 Spanish accented subjects remain inside the validated phrase', () => {
  const matcher = createMatcher([
    { id: 'doctor', term: 'doctor', translation: 'doctor', search_language: 'es', term_language: 'en', part_of_speech: 'noun', validation_version: 3, effective_runtime_triggers: ['doctor'] },
    { id: 'be', term: 'is', translation: 'es', search_language: 'es', term_language: 'en', part_of_speech: 'verb', validation_version: 3, effective_runtime_triggers: ['es', 'eres'] },
  ]);
  for (const phrase of ['Él es doctor', 'Tú eres doctor']) {
    const result = matcher.findMatches(`${phrase}.`);
    assert.equal(result.singles.length, 1);
    assert.equal(result.singles[0].original, phrase);
  }
});

test('v3 one-word noun proposals include articles but preserve unrelated text', () => {
  const matcher = createMatcher([{ id: 'hand', term: 'mano', translation: 'hand', source_forms: ['hand'], search_language: 'en', term_language: 'es', part_of_speech: 'noun', validation_version: 3 }]);
  for (const phrase of ['the hand', 'a hand', 'my hand']) {
    const result = matcher.findMatches(`Look at ${phrase}.`);
    assert.equal(result.singles[0].original, phrase);
    assert.equal(result.singles[0].start, 8);
  }
  assert.equal(matcher.findMatches('Please hand me a book.').singles[0].original, 'hand');
});

test('explicit multi-word phrases outrank overlapping single-word matches', () => {
  const matcher = createMatcher([
    {
      id: 'phrase_gm',
      term: 'buenos dias',
      translation: 'good morning',
      search_language: 'en',
      term_language: 'es',
    },
    {
      id: 'word_good',
      term: 'bueno',
      translation: 'good',
      search_language: 'en',
      term_language: 'es',
    },
    {
      id: 'word_morning',
      term: 'manana',
      translation: 'morning',
      search_language: 'en',
      term_language: 'es',
    },
  ]);

  const result = matcher.findMatches('Good morning, traveler.');

  assert.equal(result.phrases.length, 0);
  assert.equal(result.singles.length, 1);
  assert.equal(result.singles[0].word.id, 'phrase_gm');
  assert.equal(result.singles[0].original, 'Good morning');
});

test('one vocabulary entry can match multiple source forms like hi and hello', () => {
  const matcher = createMatcher([
    {
      id: 'greeting',
      term: 'hola',
      translation: 'hello',
      source_forms: ['hi', 'hello'],
      search_language: 'en',
      term_language: 'es',
    },
  ]);

  const result = matcher.findMatches('Hi, hello there.');

  assert.deepEqual(
    plain(result.singles.map(match => ({
      id: match.word.id,
      original: match.original,
    }))),
    [
      { id: 'greeting', original: 'Hi' },
      { id: 'greeting', original: 'hello' },
    ],
  );
});

test('same-meaning variants stay grouped under one meaning key for a trigger', () => {
  const matcher = createMatcher([
    {
      id: 'greet_formal',
      term: 'hola',
      translation: 'hello',
      meaning_key: 'greeting.hello',
      variant_weight: 100,
      search_language: 'en',
      term_language: 'es',
    },
    {
      id: 'greet_informal',
      term: 'buenas',
      translation: 'hello',
      meaning_key: 'greeting.hello',
      variant_weight: 100,
      search_language: 'en',
      term_language: 'es',
    },
  ]);

  const result = matcher.findMatches('hello again');
  const match = result.singles[0];

  assert.equal(match.word._localMeaningKey, 'greeting.hello');
  assert.deepEqual(
    plain(match.word._candidateIds.slice().sort()),
    ['greet_formal', 'greet_informal'],
  );
  assert.deepEqual(
    plain(match.word._alternatives.map(option => option.id).slice().sort()),
    ['greet_formal', 'greet_informal'],
  );
});

test('slash-separated learner glosses are not literal runtime triggers', () => {
  const matcher = createMatcher([{
    id: 'is-concept',
    term: 'Is',
    translation: 'Es / Está',
    source_forms: [],
    search_language: 'es',
    term_language: 'en',
    part_of_speech: 'verb',
  }]);

  assert.equal(matcher.findMatches('Es / Está').singles.length, 0);
});

test('extension-synced English trigger forms match Wikipedia and Google-like text', () => {
  const matcher = createMatcher([
    {
      id: 'search_word',
      term: 'buscar',
      translation: 'search',
      searchable_forms: ['searches', 'searched', 'searching'],
      source_forms: ['search', 'searches', 'searched', 'searching', 'search engine'],
      search_language: 'en',
      term_language: 'es',
    },
    {
      id: 'encyclopedia_word',
      term: 'enciclopedia',
      translation: 'encyclopedia',
      searchable_forms: ['encyclopedias'],
      search_language: 'en',
      term_language: 'es',
    },
  ]);

  const googleResult = matcher.findMatches('Google Search helps people search the web.');
  assert.deepEqual(
    plain(googleResult.singles.map(match => match.original)),
    ['Search', 'search'],
  );

  const wikipediaResult = matcher.findMatches('Wikipedia is an encyclopedia.');
  assert.deepEqual(
    plain(wikipediaResult.singles.map(match => match.original)),
    ['encyclopedia'],
  );
});

test('single Spanish verb matches carry bounded context even with one candidate', () => {
  const matcher = createMatcher([{
    id: 'is-concept',
    term: 'Is',
    translation: 'Es / Está',
    source_forms: ['es', 'está'],
    search_language: 'es',
    term_language: 'en',
    part_of_speech: 'verb',
  }]);

  const result = matcher.findMatches('Es un doctor.');
  const match = result.singles[0];
  assert.equal(match.word._needsContextualRewrite, true);
  assert.deepEqual(plain(match.word._contextualCandidateIds), ['is-concept']);
  assert.equal(match.word._sentenceContext, 'Es un doctor.');
  assert.equal(match.word._matchOffset, 0);
});

test('Spanish verb-first matches stay out of generic VERB plus NOUN phrases', () => {
  const matcher = createMatcher([
    {
      id: 'is-concept', term: 'Is', translation: 'es', source_forms: ['es'],
      search_language: 'es', term_language: 'en', part_of_speech: 'verb',
    },
    {
      id: 'doctor-concept', term: 'doctor', translation: 'doctor', source_forms: ['doctor'],
      search_language: 'es', term_language: 'en', part_of_speech: 'noun',
    },
  ], { isGlueGap: () => true });

  const result = matcher.findMatches('Es un doctor.');
  assert.equal(result.phrases.length, 0);
  assert.deepEqual(plain(result.singles.map(match => match.original)), ['Es', 'doctor']);
});

test('explicit Spanish pronoun and verb group stops before later context', () => {
  const matcher = createMatcher([
    {
      id: 'he-concept', term: 'He', translation: 'él', source_forms: ['él'],
      search_language: 'es', term_language: 'en', part_of_speech: 'pronoun',
    },
    {
      id: 'is-concept', term: 'is', translation: 'es', source_forms: ['es'],
      search_language: 'es', term_language: 'en', part_of_speech: 'verb',
    },
    {
      id: 'doctor-concept', term: 'doctor', translation: 'doctor', source_forms: ['doctor'],
      search_language: 'es', term_language: 'en', part_of_speech: 'noun',
    },
  ], { isGlueGap: () => true });

  const result = matcher.findMatches('Él es un doctor.');
  assert.equal(result.phrases.length, 1);
  assert.deepEqual(plain(result.phrases[0].matches.map(match => match.original)), ['Él', 'es']);
  assert.deepEqual(plain(result.singles.map(match => match.original)), ['doctor']);
});

test('authored whole-sentence source forms retain longest-match authority', () => {
  const matcher = createMatcher([
    {
      id: 'authored-phrase', term: 'I am a doctor', translation: 'soy un doctor',
      source_forms: ['soy un doctor'], search_language: 'es', term_language: 'en',
      part_of_speech: 'verb',
    },
    {
      id: 'am-concept', term: 'Am', translation: 'soy', source_forms: ['soy'],
      search_language: 'es', term_language: 'en', part_of_speech: 'verb',
    },
  ], { isGlueGap: () => true });

  const result = matcher.findMatches('Soy un doctor.');
  assert.equal(result.singles.length, 1);
  assert.equal(result.singles[0].word.id, 'authored-phrase');
  assert.equal(result.singles[0].word._needsContextualRewrite, undefined);
});

test('greeting and farewell formulas stay English inside a larger phrase', () => {
  const engine = createMatcher([
    { id: 'night', term: 'Buenas noches', translation: 'Good night', search_language: 'en', term_language: 'es', part_of_speech: 'phrase', source_forms: ['good night'] },
    { id: 'see', term: 'Nos vemos', translation: 'See you', search_language: 'en', term_language: 'es', part_of_speech: 'phrase', source_forms: ['see you'] },
  ]);
  const ids = text => plain(engine.findMatches(text).singles.map(match => match.word.id));
  assert.deepEqual(ids("I try to get a good night's sleep the night before a test."), []);
  assert.deepEqual(ids('I’m excited to see you building your wallet!'), []);
  assert.deepEqual(ids('I will see you there.'), []);
  assert.deepEqual(ids('Good night, everyone!'), ['night']);
  assert.deepEqual(ids('Thanks for coming. See you tomorrow!'), ['see']);
  assert.deepEqual(ids('Okay, see you!'), ['see']);
});

test('single-word vocab with no part of speech is not treated as a formula', () => {
  const engine = createMatcher([
    { id: 'cat', term: 'gato', translation: 'cat', search_language: 'en', term_language: 'es', source_forms: ['cat'] },
  ]);
  assert.deepEqual(plain(engine.findMatches('I saw a cat.').singles.map(match => match.word.id)), ['cat']);
});

test('an unaccented trigger never turns the Spanish article "el" into "he"', () => {
  const engine = createMatcher([
    { id: 'he', term: 'He', translation: 'Él', search_language: 'es', term_language: 'en', part_of_speech: 'pronoun',
      source_forms: ['el'], effective_runtime_triggers: ['el'] },
    { id: 'cat', term: 'cat', translation: 'gato', search_language: 'es', term_language: 'en', part_of_speech: 'noun', source_forms: ['gato'] },
  ]);
  const ids = text => plain(engine.findMatches(text).singles.map(match => match.word.id));
  assert.deepEqual(ids('El gato caminó.'), ['cat']);
  const accented = createMatcher([
    { id: 'he', term: 'He', translation: 'Él', search_language: 'es', term_language: 'en', part_of_speech: 'pronoun', source_forms: ['él'] },
  ]);
  assert.deepEqual(plain(accented.findMatches('Él camina. El gato duerme.').singles.map(match => match.original)), ['Él']);
});

test('unaccented él/tú match only before a verb that cannot be a noun', () => {
  const engine = createMatcher([
    { id: 'he', term: 'He', translation: 'Él', search_language: 'es', term_language: 'en', part_of_speech: 'pronoun',
      source_forms: ['el'], effective_runtime_triggers: ['el'] },
    { id: 'you', term: 'You', translation: 'Tú', search_language: 'es', term_language: 'en', part_of_speech: 'pronoun', source_forms: ['tú'] },
    { id: 'the', term: 'the', translation: 'el', search_language: 'es', term_language: 'en', part_of_speech: 'article', source_forms: ['el'] },
  ]);
  const found = text => plain(engine.findMatches(text).singles.map(match => `${match.original}:${match.word.id}`));
  assert.deepEqual(found('el es mi amigo'), ['el:he']);
  assert.deepEqual(found('Creo que el tiene hambre.'), ['el:he']);
  assert.deepEqual(found('Él camina.'), ['Él:he']);
  assert.deepEqual(found('El gato camina.'), ['El:the']);
  assert.deepEqual(found('el agua'), ['el:the']);
  assert.deepEqual(found('tu eres genial'), ['tu:you']);
  assert.deepEqual(found('tu casa'), []);
  assert.deepEqual(found('Tú tienes razón'), ['Tú:you']);
  const heOnly = createMatcher([
    { id: 'he', term: 'He', translation: 'Él', search_language: 'es', term_language: 'en', part_of_speech: 'pronoun', source_forms: ['el'] },
  ]);
  assert.deepEqual(plain(heOnly.findMatches('El gato. el libro. el').singles), []);
});
