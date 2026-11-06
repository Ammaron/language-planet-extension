import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../shared/source-language.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context, { filename: 'source-language.js' });
const { resolve, isChineseVocabularyResponseReady, chinesePageRows } = context.LangslySourceLanguage;

test('extension source-language resolver keeps Simplified and Traditional Chinese distinct', () => {
  for (const tag of ['zh', 'zh-Hans', 'zh_CN', 'zh-SG', 'zh-Hans-CN']) {
    assert.equal(resolve(tag), 'zh', tag);
  }
  for (const tag of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-Hans-TW', 'zh-Hant-CN', 'zh-MO']) {
    assert.equal(resolve(tag), null, tag);
  }
  assert.equal(resolve('en-US'), 'en');
  assert.equal(resolve('es-PE'), 'es');
  assert.equal(resolve(''), '');
});

test('Chinese vocabulary sync drops unusable words and keeps the rest', () => {
  const good = { id: 'word-1', term: 'hola', translation: '你好', search_language: 'zh', term_language: 'es', source_forms: ['你好'] };
  const unfinished = { ...good, id: 'word-2', source_forms: [] };
  const otherDirection = { ...good, id: 'word-3', search_language: 'en' };
  const grammar = { ...good, id: 'word-4', validation_version: 3 };
  const response = {
    source_language: 'zh', source_language_ready: true, validation_versions: [2, 3],
    words: [good, unfinished, otherDirection, grammar],
  };
  assert.equal(isChineseVocabularyResponseReady(response), true);
  assert.deepEqual(chinesePageRows(response).map(word => word.id), ['word-1']);
});

test('Chinese vocabulary sync rejects payloads with nothing usable', () => {
  const word = {
    id: 'word-1', term: 'hola', translation: '你好',
    search_language: 'zh', term_language: 'es', source_forms: ['你好'],
  };
  const response = {
    source_language: 'zh', source_language_ready: true,
    validation_versions: [2], words: [word],
  };
  assert.equal(isChineseVocabularyResponseReady(response), true);
  for (const invalid of [
    { ...response, source_language_ready: false },
    { ...response, source_language: 'en' },
    { ...response, validation_versions: [3] },
    { ...response, words: [] },
    { ...response, words: [{ ...word, search_language: 'en' }] },
    { ...response, words: [{ ...word, id: '' }] },
    { ...response, words: [{ ...word, term_language: 'zh' }] },
    { ...response, words: [{ ...word, source_forms: [] }] },
    { ...response, words: [{ ...word, source_forms: ['你好 / 您好'] }] },
    { ...response, words: [{ ...word, source_forms: ['你好/您好'] }] },
    { ...response, words: [{ ...word, source_forms: ['你好／您好'] }] },
    { ...response, words: [{ ...word, translation: '' }] },
  ]) {
    assert.equal(isChineseVocabularyResponseReady(invalid), false);
  }
});
