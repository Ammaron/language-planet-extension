import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const matcherSource = fs.readFileSync(
  path.join(process.cwd(), 'language-planet-extension/content/matcher.js'),
  'utf8',
);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMatcher(words) {
  const sandbox = {
    window: {
      GrammarRules: {
        isGlueGap: () => false,
        MAX_GAP_CHARS: 30,
        MIN_PHRASE_WORDS: 2,
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
