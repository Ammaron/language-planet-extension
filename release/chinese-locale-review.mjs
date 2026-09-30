import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const REVIEW_ROLES = ['native_reviewer', 'product_reviewer', 'privacy_reviewer', 'legal_reviewer'];
const tokens = value => [...value.matchAll(/\$(?:[A-Z][A-Z0-9_]*\$|\d+)/gi)].map(([token]) => token.toLowerCase()).sort();
const brands = ['Langsly', 'LANGSLY', 'Vocab Pass', 'Word Racing', 'Word Fight', 'Google', 'Firefox', 'OpenRouter'];

export function validateChineseLocale(sourceBytes, runtimeBytes, review) {
  assert.equal(review.locale, 'zh-Hans');
  assert.equal(review.extension_locale, 'zh_CN');
  assert.equal(review.status, 'approved', 'Chinese extension copy is not approved');
  const sourceHash = digest(sourceBytes);
  const runtimeHash = digest(runtimeBytes);
  assert.equal(review.source_sha256, sourceHash, 'Chinese extension review has stale English source');
  assert.equal(review.runtime_sha256, runtimeHash, 'Chinese extension runtime differs from reviewed copy');
  for (const role of REVIEW_ROLES) {
    const attestation = review[role];
    assert.ok(attestation && typeof attestation.id === 'string' && attestation.id.trim(), `${role} identity required`);
    assert.match(attestation.reviewed_at || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
    assert.ok(Number.isFinite(Date.parse(attestation.reviewed_at)), `${role} timestamp invalid`);
    assert.equal(attestation.source_sha256, sourceHash, `${role} source review is stale`);
    assert.equal(attestation.runtime_sha256, runtimeHash, `${role} copy review is stale`);
  }
  assert.notEqual(review.native_reviewer.id, review.product_reviewer.id, 'Native and product reviews must be independent');
  const source = JSON.parse(sourceBytes);
  const runtime = JSON.parse(runtimeBytes);
  assert.deepEqual(Object.keys(runtime).sort(), Object.keys(source).sort(), 'Chinese extension keys must be complete');
  for (const [key, entry] of Object.entries(source)) {
    const { message, ...sourceStructure } = entry;
    const { message: translated, ...runtimeStructure } = runtime[key];
    assert.equal(typeof translated, 'string', `${key}: message required`);
    assert.ok(translated.trim(), `${key}: message blank`);
    assert.deepEqual(runtimeStructure, sourceStructure, `${key}: placeholder definitions or metadata changed`);
    assert.deepEqual(tokens(translated), tokens(message), `${key}: substitutions changed`);
    for (const brand of brands) if (message.includes(brand)) assert.ok(translated.includes(brand), `${key}: ${brand} changed`);
    if (/[A-Za-z]/.test(message) && !['extName', 'popupBrandName', 'emailPlaceholder', 'apiBasePlaceholder', 'frontendPlaceholder'].includes(key)) {
      assert.notEqual(translated, message, `${key}: untranslated message`);
    }
  }
  return Object.keys(runtime).length;
}

// Run before deleting/rebuilding dist. Drafts in docs/evidence are never read here.
export function verifyChineseLocaleForBuild(root) {
  const localesRoot = join(root, '_locales');
  const chinese = readdirSync(localesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^zh(?:_|-|$)/i.test(entry.name)).map(entry => entry.name);
  if (!chinese.length) return { chineseIncluded: false, keys: 0 };
  assert.deepEqual(chinese, ['zh_CN'], 'Only the reviewed Simplified Chinese extension locale may ship');
  const reviewPath = join(root, 'release/zh_CN.review.json');
  assert.ok(existsSync(reviewPath), 'Chinese extension packaging requires release/zh_CN.review.json');
  const keys = validateChineseLocale(readFileSync(join(localesRoot, 'en/messages.json')),
    readFileSync(join(localesRoot, 'zh_CN/messages.json')), JSON.parse(readFileSync(reviewPath, 'utf8')));
  return { chineseIncluded: true, keys };
}
