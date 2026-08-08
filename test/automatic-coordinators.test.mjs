import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadGlobal(path, name, extras = {}) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  const sandbox = { ...extras, console, Date, JSON, Map, Promise, queueMicrotask, Set };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox, { filename: path });
  return sandbox[name];
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

async function waitForRelease(releases) {
  while (releases.length === 0) await new Promise((resolve) => setImmediate(resolve));
  return releases.shift();
}

test('phrase requests deduplicate, never exceed two concurrent calls, and keep a document-lifetime unique budget', async () => {
  const factory = await loadGlobal('content/request-coordinator.js', 'LangslyRequestCoordinator');
  const releases = [];
  let active = 0;
  let peak = 0;
  let calls = 0;
  const coordinator = factory.createRequestCoordinator({
    keyOf: ({ key }) => key,
    maxConcurrent: 2,
    maxUnique: 3,
    send: ({ key }) => new Promise((resolve) => {
      calls += 1;
      active += 1;
      peak = Math.max(peak, active);
      releases.push(() => { active -= 1; resolve({ success: true, key }); });
    }),
  });

  const first = coordinator.request({ key: 'same' });
  const duplicate = coordinator.request({ key: 'same' });
  const second = coordinator.request({ key: 'second' });
  const third = coordinator.request({ key: 'third' });
  const overBudget = coordinator.request({ key: 'after-push-state' });
  await tick();

  assert.strictEqual(first, duplicate);
  assert.equal(calls, 2);
  assert.equal(peak, 2);
  const quotaResult = await overBudget;
  assert.equal(quotaResult.success, false);
  assert.equal(quotaResult.error, 'quota_exceeded');

  releases.shift()();
  while (calls < 3) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  (await waitForRelease(releases))();
  (await waitForRelease(releases))();
  await Promise.all([first, second, third]);
  assert.equal(coordinator.snapshot().unique, 3);
});

test('disambiguation batches are serialized at 20 items and reject work beyond 60 per document window', async () => {
  const factory = await loadGlobal('content/request-coordinator.js', 'LangslyRequestCoordinator');
  const batches = [];
  const releases = [];
  let active = 0;
  let peak = 0;
  const coordinator = factory.createBatchCoordinator({
    maxBatch: 20,
    maxPerWindow: 60,
    send: (items) => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      batches.push(items);
      releases.push(() => { active -= 1; resolve(items.map(({ id }) => ({ id }))); });
    }),
  });

  const accepted = Array.from({ length: 60 }, (_, id) => coordinator.request({ id }));
  const rejected = coordinator.request({ id: 60 });
  await tick();
  assert.equal(await rejected, null);
  assert.equal(batches[0].length, 20);
  assert.equal(peak, 1);

  for (let index = 0; index < 3; index += 1) {
    (await waitForRelease(releases))();
    await tick();
  }
  const results = await Promise.all(accepted);
  assert.equal(results.filter(Boolean).length, 60);
  assert.deepEqual(batches.map((batch) => batch.length), [20, 20, 20]);
  assert.equal(peak, 1);
});

test('encounter writes and flushes serialize, send no more than 50, and preserve appends during a flush', async () => {
  const factory = await loadGlobal('background/encounter-coordinator.js', 'LangslyEncounterCoordinator');
  let stored = [];
  const batches = [];
  let releaseFirst;
  const coordinator = factory.create({
    load: async () => [...stored],
    save: async (next) => { stored = [...next]; },
    send: async (batch) => {
      batches.push([...batch]);
      if (batches.length === 1) await new Promise((resolve) => { releaseFirst = resolve; });
      return true;
    },
  });

  await coordinator.append(Array.from({ length: 70 }, (_, id) => ({ id })));
  const firstFlush = coordinator.flush();
  const sameFlush = coordinator.flush();
  assert.strictEqual(firstFlush, sameFlush);
  await tick();
  await coordinator.append([{ id: 70 }]);
  releaseFirst();
  await firstFlush;

  assert.deepEqual(batches.map((batch) => batch.length), [50, 21]);
  assert.equal(Math.max(...batches.map((batch) => batch.length)), 50);
  assert.deepEqual(stored, []);
});
