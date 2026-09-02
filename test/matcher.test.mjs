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

function createMatcher(words, grammarOverrides = {}) {
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
  };

  vm.runInNewContext(matcherSource, sandbox, { filename: 'matcher.js' });
  const VocabMatcher = sandbox.window.VocabMatcher;
  return new VocabMatcher(words, { rotationSalt: 'test-salt' });
}

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
