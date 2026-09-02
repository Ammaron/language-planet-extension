import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function matcher(words) {
  const context = { window: { GrammarRules: { isGlueGap: () => false, MAX_GAP_CHARS: 30, MIN_PHRASE_WORDS: 2 } }, console };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../content/matcher.js', import.meta.url), 'utf8'), context);
  return new context.window.VocabMatcher(words);
}
const word = { id: 'is', term: 'Is', translation: 'Es / Está', search_language: 'es', term_language: 'en' };

test('slash display meanings with no authored forms never match', () => {
  assert.equal(matcher([{ ...word, source_forms: [], searchable_forms: ['es'] }]).findMatches('es está Es / Está').singles.length, 0);
});
test('exact alternatives preserve accents and normalize whitespace and duplicates', () => {
  const engine = matcher([{ ...word, source_forms: [' es ', 'está', 'ES'] }]);
  assert.equal(engine.wordMap.size, 2);
  assert.equal(engine.findMatches('Es está').singles.length, 2);
  assert.equal(engine.findMatches('esta').singles.length, 0);
});
test('invalid slash Source Forms disable matching even with one valid alternative', () => {
  assert.equal(matcher([{ ...word, source_forms: ['es / está', 'es'] }]).findMatches('es').singles.length, 0);
});
test('the authoritative empty runtime trigger array does not fall back to meaning', () => {
  assert.equal(matcher([{ ...word, translation: 'es', source_forms: ['es'], effective_runtime_triggers: [] }]).findMatches('es').singles.length, 0);
});
test('authored phrases keep longest-match priority', () => {
  const engine = matcher([
    { ...word, id: 'phrase', term: 'I am a doctor', source_forms: [' soy   un doctor '] },
    { ...word, id: 'verb', term: 'Am', source_forms: ['soy'] },
  ]);
  const matches = engine.findMatches('Soy un doctor.').singles;
  assert.equal(matches.length, 1);
  assert.equal(matches[0].word.id, 'phrase');
});
