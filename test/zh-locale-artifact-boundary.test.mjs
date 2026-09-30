import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyChineseLocaleForBuild } from '../release/chinese-locale-review.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root));

test('built Chrome/Firefox ship only en/es while AMO source retains the separate draft test inputs', () => {
  const readiness = verifyChineseLocaleForBuild(fileURLToPath(root));
  const expectedLocales = readiness.chineseIncluded ? ['en', 'es', 'zh_CN'] : ['en', 'es'];
  for (const browser of ['chrome', 'firefox']) {
    const locales = readdirSync(new URL(`dist/${browser}/_locales/`, root)).sort();
    assert.deepEqual(locales, expectedLocales, `${browser} locale inclusion differs from approved source`);
    assert.equal(existsSync(new URL(`dist/${browser}/docs/evidence/`, root)), false);
    for (const locale of locales) {
      assert.deepEqual(JSON.parse(read(`dist/${browser}/_locales/${locale}/messages.json`)),
        JSON.parse(read(`_locales/${locale}/messages.json`)));
    }
  }
  for (const file of ['zh_CN.messages.draft.json', 'zh_CN.messages.draft.meta.json']) {
    assert.deepEqual(read(`dist/amo-source/docs/evidence/${file}`), read(`docs/evidence/${file}`));
  }
  assert.deepEqual(read('dist/amo-source/release/chinese-locale-review.mjs'), read('release/chinese-locale-review.mjs'));
});
