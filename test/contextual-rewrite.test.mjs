import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contentSource = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');

test('contextual verbs preserve original text until a confident response', () => {
  assert.match(contentSource, /function buildPendingSingleSpan[\s\S]*?span\.textContent = match\.original/);
  assert.match(contentSource, /result\?\.decision !== 'replace'/);
  assert.match(contentSource, /span\.textContent = result\.replacement_text/);
  assert.doesNotMatch(contentSource, /function requestContextualRewrites\(/);
});

test('contextual rewrites share the bounded versioned validation path', () => {
  assert.match(contentSource, /validationCoordinator = LangslyRequestCoordinator\.createBatchCoordinator/);
  assert.match(contentSource, /maxBatch: 20/);
  assert.match(contentSource, /validation_version: state\.validationVersion \|\| 2/);
  assert.match(workerSource, /items\.filter\(item => item\.validation_version === version\)/);
  assert.match(workerSource, /message\.type === 'VALIDATE_REPLACEMENTS'/);
  assert.match(workerSource, /_consumeAutomaticBudget\(sender, 'disambiguate', items\.length, 60, 300\)/);
});

test('contextual cache keys include pair, offset, and candidate IDs and clear on logout', () => {
  assert.match(workerSource, /item\.source_language \|\| 'es'/);
  assert.match(workerSource, /item\.target_language \|\| 'en'/);
  assert.match(workerSource, /item\.match_offset \|\| 0/);
  assert.match(workerSource, /candidatesSorted/);
  assert.match(workerSource, /key\.startsWith\('contextual_'\)/);
  assert.match(workerSource, /crypto\.subtle\.digest\('SHA-256'/);
  assert.doesNotMatch(workerSource, /contextual_\$\{btoa[\s\S]*?slice\(0, 64\)/);
});
