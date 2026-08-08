import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('content metadata stays in extension-owned WeakMaps and popup uses a closed shadow root', async () => {
  const content = await read('content/content.js');
  const popup = await read('content/popup.js');
  assert.match(content, /LangslyPrivateState/);
  assert.match(popup, /attachShadow\(\{\s*mode:\s*'closed'\s*\}\)/);
  assert.doesNotMatch(`${content}\n${popup}`, /\.dataset\.(?:wordId|translation|candidate|cacheEntryId|meaningKey|disambig)/);
});

test('sensitive exclusions are mandatory and reevaluated for SPA and password mutations', async () => {
  const content = await read('content/content.js');
  assert.doesNotMatch(content, /excludeSensitive\s*===\s*false/);
  assert.match(content, /input\[type="password"\]/);
  assert.match(content, /\['pushState',\s*'replaceState'\]/);
  assert.match(content, /MutationObserver\(scheduleSafetyCheck\)/);
  assert.match(content, /deactivateForSensitivePage/);
});

test('automatic processing is bounded and trusted feedback rejects synthetic clicks', async () => {
  const content = await read('content/content.js');
  const popup = await read('content/popup.js');
  const worker = await read('background/service-worker.js');
  assert.match(content, /MAX_TEXT_NODES_PER_SCAN\s*=\s*500/);
  assert.match(content, /MAX_MUTATION_NODES\s*=\s*200/);
  assert.match(content, /document\.hidden/);
  assert.match(`${content}\n${popup}`, /if \(!e\.isTrusted\) return/);
  assert.match(worker, /_consumeAutomaticBudget/);
  assert.match(worker, /maxStored:\s*1000/);
});
