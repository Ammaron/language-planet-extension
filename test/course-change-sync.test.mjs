import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const bridge = await readFile(new URL('../content/connection-bridge.js', import.meta.url), 'utf8');

const SITE = 'https://langsly.com';
const trusted = { id: 'ext', frameId: 0, url: `${SITE}/profile`, tab: { id: 1 } };

function workerHarness() {
  const timers = [];
  const clock = { now: 1_000_000 };
  let syncs = 0;
  const context = vm.createContext({
    browser: { runtime: { id: 'ext' } },
    getConfig: async () => ({ frontendUrl: SITE }),
    syncVocabulary: async () => { syncs += 1; },
    setTimeout: (run, wait) => { timers.push({ run, wait }); return timers.length; },
    Date: { now: () => clock.now },
    URL,
  });
  vm.runInContext(worker.slice(
    worker.indexOf('const COURSE_SYNC_MIN_GAP_MS'),
    worker.indexOf('// ─── Alarms'),
  ), context);
  return {
    timers,
    clock,
    syncs: () => syncs,
    changed: sender => vm.runInContext('handleCourseChanged', context)(sender),
  };
}

test('a course change from the Langsly site syncs right away', async () => {
  const h = workerHarness();
  assert.equal((await h.changed(trusted)).success, true);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].wait, 0);
  h.timers[0].run();
  assert.equal(h.syncs(), 1);
});

test('other senders cannot trigger a sync', async () => {
  const h = workerHarness();
  for (const sender of [
    null,
    { ...trusted, id: 'other-extension' },
    { ...trusted, frameId: 3 },
    { ...trusted, url: 'https://evil.example/langsly.com' },
    { ...trusted, url: 'not a url' },
  ]) {
    assert.equal((await h.changed(sender)).error, 'untrusted_sender');
  }
  assert.equal(h.timers.length, 0);
});

test('a burst of changes collapses into one trailing sync', async () => {
  const h = workerHarness();
  await h.changed(trusted);
  h.timers[0].run();
  h.clock.now += 1000;
  await h.changed(trusted);
  await h.changed(trusted);
  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[1].wait, 9000);
  h.timers[1].run();
  assert.equal(h.syncs(), 2);
});

test('the worker routes the message to the course-change handler', () => {
  assert.match(worker, /message\.type === 'COURSE_CHANGED'\) return handleCourseChanged\(sender\)/);
});

function bridgeHarness(pathname = '/profile') {
  const sent = [];
  let listener;
  const win = { addEventListener: (_type, run) => { listener = run; }, postMessage() {} };
  const context = vm.createContext({
    window: win,
    location: { origin: SITE, pathname },
    browser: { runtime: { sendMessage: async (message) => { sent.push(message); return {}; } } },
  });
  vm.runInContext(bridge, context);
  return { sent, win, post: (event) => listener(event) };
}

test('the bridge forwards the signal from any Langsly page, carrying no page data', async () => {
  const h = bridgeHarness();
  await h.post({ source: h.win, origin: SITE, data: { type: 'LANGSLY_COURSE_CHANGED', token: 'secret' } });
  assert.deepEqual(h.sent.map(message => ({ ...message })), [{ type: 'COURSE_CHANGED' }]);
});

test('the bridge ignores other windows, other origins and other messages', async () => {
  const h = bridgeHarness();
  await h.post({ source: {}, origin: SITE, data: { type: 'LANGSLY_COURSE_CHANGED' } });
  await h.post({ source: h.win, origin: 'https://evil.example', data: { type: 'LANGSLY_COURSE_CHANGED' } });
  await h.post({ source: h.win, origin: SITE, data: { type: 'SOMETHING_ELSE' } });
  await h.post({ source: h.win, origin: SITE, data: null });
  assert.deepEqual(h.sent, []);
});

test('device connection requests still work only on the connect page', async () => {
  const request = { type: 'LANGSLY_CONNECTION_REQUEST', action: 'status', requestId: 'r1', userCode: 'AAAA-BBB1' };
  const elsewhere = bridgeHarness('/profile');
  await elsewhere.post({ source: elsewhere.win, origin: SITE, data: request });
  assert.deepEqual(elsewhere.sent, []);
  const connect = bridgeHarness('/extension-connect');
  await connect.post({ source: connect.win, origin: SITE, data: request });
  assert.equal(connect.sent.length, 1);
  assert.equal(connect.sent[0].type, 'DEVICE_CONNECTION_BRIDGE');
});
