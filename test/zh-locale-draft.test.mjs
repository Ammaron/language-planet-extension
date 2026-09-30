import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url));
const sourceBytes = read('../_locales/en/messages.json');
const draftBytes = read('../docs/evidence/zh_CN.messages.draft.json');
const source = JSON.parse(sourceBytes.toString('utf8'));
const draft = JSON.parse(draftBytes.toString('utf8'));
const meta = JSON.parse(read('../docs/evidence/zh_CN.messages.draft.meta.json').toString('utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const placeholders = (value) => [...value.matchAll(/\$[A-Z][A-Z0-9_]*\$/g)].map(([token]) => token).sort();
const protectedNames = ['Langsly', 'LANGSLY', 'Vocab Pass', 'Word Racing', 'Word Fight', 'Google', 'Firefox', 'OpenRouter'];
const allowedUnchanged = new Set(['extName', 'popupBrandName', 'emailPlaceholder', 'apiBasePlaceholder', 'frontendPlaceholder']);

test('unreviewed Chinese extension draft is bound to exact source and draft bytes', () => {
  assert.equal(meta.locale, 'zh-Hans');
  assert.equal(meta.extension_locale, 'zh_CN');
  assert.equal(meta.status, 'draft_unreviewed');
  assert.equal(hash(sourceBytes), meta.source_sha256);
  assert.equal(hash(draftBytes), meta.draft_sha256);
});

test('Chinese extension draft covers current messages without changing placeholders or product names', () => {
  assert.deepEqual(Object.keys(draft), Object.keys(source));
  for (const [key, sourceEntry] of Object.entries(source)) {
    const value = draft[key];
    assert.equal(typeof value, 'string', `${key} must be a string`);
    assert.ok(value.trim(), `${key} must not be blank`);
    assert.deepEqual(placeholders(value), placeholders(sourceEntry.message), `${key} placeholders changed`);
    for (const name of protectedNames) {
      if (sourceEntry.message.includes(name)) {
        assert.ok(value.includes(name), `${key} changed protected name ${name}`);
      }
    }
    if (!allowedUnchanged.has(key)) {
      assert.notEqual(value, sourceEntry.message, `${key} still uses English source copy`);
    }
  }
});
