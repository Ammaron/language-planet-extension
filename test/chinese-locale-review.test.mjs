import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, REVIEW_ROLES, validateChineseLocale, validateUnreviewedChineseLocale, verifyChineseLocaleForBuild } from '../release/chinese-locale-review.mjs';

const source = Buffer.from(JSON.stringify({ greeting: { message: 'Hello $NAME$', placeholders: { name: { content: '$1' } } } }));
const runtime = Buffer.from(JSON.stringify({ greeting: { message: '你好，$NAME$', placeholders: { name: { content: '$1' } } } }));
function review(copy = runtime) {
  const meta = { locale: 'zh-Hans', extension_locale: 'zh_CN', status: 'approved', source_sha256: digest(source), runtime_sha256: digest(copy) };
  for (const role of REVIEW_ROLES) meta[role] = { id: `fixture-${role}`, reviewed_at: '2026-09-30T12:00:00Z', source_sha256: meta.source_sha256, runtime_sha256: meta.runtime_sha256 };
  return meta;
}

test('English/Spanish builds pass without Chinese and accidental Chinese folders block packaging', () => {
  const root = mkdtempSync(join(tmpdir(), 'langsly-extension-review-'));
  mkdirSync(join(root, '_locales/en'), { recursive: true });
  mkdirSync(join(root, '_locales/es'));
  assert.equal(verifyChineseLocaleForBuild(root).chineseIncluded, false);
  mkdirSync(join(root, '_locales/zh_CN'));
  assert.throws(() => verifyChineseLocaleForBuild(root), /requires release/);
  mkdirSync(join(root, '_locales/zh_TW'));
  assert.throws(() => verifyChineseLocaleForBuild(root), /Only the reviewed/);
});

test('approved exact-copy reviews permit complete Chinese but draft, stale and missing domain reviews fail', () => {
  assert.equal(validateChineseLocale(source, runtime, review()), 1);
  const draft = review(); draft.status = 'draft_unreviewed';
  assert.throws(() => validateChineseLocale(source, runtime, draft), /not approved/);
  const changed = Buffer.from(runtime.toString().replace('你好', '您好'));
  assert.throws(() => validateChineseLocale(source, changed, review()), /differs/);
  for (const role of REVIEW_ROLES) {
    const missing = review(); delete missing[role];
    assert.throws(() => validateChineseLocale(source, runtime, missing), /identity required/);
    const stale = review(); stale[role].runtime_sha256 = 'stale';
    assert.throws(() => validateChineseLocale(source, runtime, stale), /copy review is stale/);
  }
});

test('review attestations cannot permit missing messages or broken substitution contracts', () => {
  for (const copy of [Buffer.from('{}'), Buffer.from('{"greeting":{"message":"你好"}}'),
    Buffer.from(runtime.toString().replace('$NAME$', '$OTHER$')), Buffer.from(runtime.toString().replace('$1', '$2'))]) {
    assert.throws(() => validateChineseLocale(source, copy, review(copy)), /keys must be complete|metadata changed|substitutions changed/);
  }
});

test('build accepts a reviewed fixture on disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'langsly-extension-approved-fixture-'));
  for (const directory of ['_locales/en', '_locales/zh_CN', 'release']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, '_locales/en/messages.json'), source);
  writeFileSync(join(root, '_locales/zh_CN/messages.json'), runtime);
  writeFileSync(join(root, 'release/zh_CN.review.json'), JSON.stringify(review()));
  assert.deepEqual(verifyChineseLocaleForBuild(root), { chineseIncluded: true, keys: 1, reviewed: true });
});

test('review hashes ignore CRLF vs LF checkouts but still bind every other byte', () => {
  const pretty = value => Buffer.from(JSON.stringify(JSON.parse(value), null, 2) + '\n');
  const lfSource = pretty(source); const lfRuntime = pretty(runtime);
  const crlf = bytes => Buffer.from(bytes.toString().replace(/\n/g, '\r\n'));
  const meta = review(lfRuntime);
  meta.source_sha256 = digest(lfSource);
  for (const role of REVIEW_ROLES) meta[role].source_sha256 = meta.source_sha256;
  assert.equal(validateChineseLocale(lfSource, lfRuntime, meta), 1);
  assert.equal(validateChineseLocale(crlf(lfSource), crlf(lfRuntime), meta), 1);
  assert.throws(() => validateChineseLocale(lfSource, Buffer.from(lfRuntime.toString().replace('你好', '您好')), meta), /differs/);
  assert.throws(() => validateChineseLocale(lfSource, Buffer.from(lfRuntime.toString() + ' '), meta), /differs/);
});

function policy(copy = runtime) {
  return { locale: 'zh-Hans', extension_locale: 'zh_CN', unreviewed_release: true, source_sha256: digest(source), runtime_sha256: digest(copy) };
}

test('an owner release policy ships unreviewed copy but keeps every copy check', () => {
  assert.equal(validateUnreviewedChineseLocale(source, runtime, policy()), 1);
  const off = policy(); off.unreviewed_release = false;
  assert.throws(() => validateUnreviewedChineseLocale(source, runtime, off), /does not allow/);
  const changed = Buffer.from(runtime.toString().replace('你好', '您好'));
  assert.throws(() => validateUnreviewedChineseLocale(source, changed, policy()), /differs/);
  const staleSource = Buffer.from(source.toString().replace('Hello', 'Hi'));
  assert.throws(() => validateUnreviewedChineseLocale(staleSource, runtime, policy()), /stale English source/);
  for (const copy of [Buffer.from('{}'), Buffer.from(runtime.toString().replace('$NAME$', '$OTHER$'))]) {
    assert.throws(() => validateUnreviewedChineseLocale(source, copy, policy(copy)), /keys must be complete|substitutions changed/);
  }
});

test('build accepts an owner release policy on disk and prefers a real review', () => {
  const root = mkdtempSync(join(tmpdir(), 'langsly-extension-policy-fixture-'));
  for (const directory of ['_locales/en', '_locales/zh_CN', 'release']) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, '_locales/en/messages.json'), source);
  writeFileSync(join(root, '_locales/zh_CN/messages.json'), runtime);
  writeFileSync(join(root, 'release/zh_CN.release-policy.json'), JSON.stringify(policy()));
  assert.deepEqual(verifyChineseLocaleForBuild(root), { chineseIncluded: true, keys: 1, reviewed: false });
  writeFileSync(join(root, 'release/zh_CN.review.json'), JSON.stringify(review()));
  assert.deepEqual(verifyChineseLocaleForBuild(root), { chineseIncluded: true, keys: 1, reviewed: true });
});
