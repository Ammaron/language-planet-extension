import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contentSource = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');

test('contextual verbs preserve original text until a confident response', () => {
  assert.match(contentSource, /span\.textContent = needsContextualRewrite[\s\S]*?\? match\.original[\s\S]*?: displaySingleTerm\(match\.word\.term, match\.original\)/);
  assert.match(contentSource, /response\.replacement_text && !response\.uncertain/);
  assert.match(contentSource, /span\.textContent = state\.original \|\| span\.textContent/);
});

test('contextual rewriting has separate concurrency, request, and document budgets', () => {
  assert.match(contentSource, /contextualRewriteCoordinator = LangslyRequestCoordinator\.createRequestCoordinator/);
  assert.match(contentSource, /maxConcurrent: 2/);
  assert.match(contentSource, /maxUnique: 30/);
  assert.match(workerSource, /_consumeAutomaticBudget\(sender, 'contextual', 1, 30, 150\)/);
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
