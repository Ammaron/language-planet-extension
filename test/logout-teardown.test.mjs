import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('logout clears session-owned state, budgets, requests, and every HTTP(S) content script', async () => {
  const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
  assert.match(worker, /automaticBudgetBuckets\.clear\(\)/);
  assert.match(worker, /controller\.abort\(\)/);
  assert.match(worker, /extensionSourceLanguage/);
  assert.match(worker, /tabs\.query\(\{ url: \['http:\/\/\*\/\*', 'https:\/\/\*\/\*'\] \}\)/);
  assert.match(worker, /type: 'AUTH_CLEARED'/);
  assert.match(worker, /refreshPromiseGeneration === snapshot\.generation/);
  assert.match(worker, /const snapshot = await _getSessionSnapshot\(\)/);
  assert.match(worker, /setTokens\(data\.access, data\.refresh \|\| refresh, generation\)/);
  assert.match(worker, /appendEncountersForSession\(safe, generation\)/);
  assert.doesNotMatch(worker, /generation !== authGeneration\)[\s\S]{0,100}clearTokens\(\)/);
  assert.match(content, /stopDocumentWork\(\{ loggedOut: true \}\)/);
  assert.match(content, /restoreOriginalPageText\(\)/);
  assert.match(content, /VocabPopup\.reset\(\)/);
  assert.match(content, /phraseCoordinator\.cancel\(\)/);
  assert.match(content, /stopSafetyController\(\)/);
});

test('large scans continue in bounded traversal slices and sensitive mutations stop synchronously', async () => {
  const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
  assert.match(content, /finishCollectionBatch\(MAX_TEXT_NODES_PER_SCAN/);
  assert.match(content, /if \(!collectionComplete\) scheduleIdleWork\(collectIdleBatch\)/);
  assert.match(content, /if \(!collectionComplete\) scheduleScanTimeout\(collectFallbackBatch\)/);
  assert.doesNotMatch(content, /textNodes\.length < MAX_TEXT_NODES_PER_SCAN/);
  assert.match(content, /if \(_pageRequiresImmediateExclusion\(\)\) \{[\s\S]{0,100}deactivateForSensitivePage\(\)/);
  assert.match(content, /attributeFilter:\s*\['type'\]/);
});

test('site access changes are targeted and never trigger a global vocabulary sync', async () => {
  const popup = await readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
  const handler = popup.slice(popup.indexOf("siteToggle.addEventListener('change'"), popup.indexOf('// â”€â”€â”€ Open Dashboard'));
  assert.match(handler, /SITE_ACCESS_CHANGED/);
  assert.doesNotMatch(handler, /SYNC_NOW|VOCAB_UPDATED/);
});
