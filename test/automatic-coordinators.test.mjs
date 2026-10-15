import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { loadContentPage } from './zh-mini-dom.mjs';

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

test('validation coordinator suppresses duplicate pending requests before counting quota', async () => {
  const factory = await loadGlobal('content/request-coordinator.js', 'LangslyRequestCoordinator');
  let calls = 0;
  const coordinator = factory.createBatchCoordinator({
    keyOf: ({ sentence, offset }) => `${sentence}:${offset}`,
    maxPerWindow: 1,
    send: async (items) => {
      calls += 1;
      return items.map(item => ({ item_id: item.item_id, decision: 'keep' }));
    },
  });
  const first = coordinator.request({ item_id: 'one', sentence: 'mañana', offset: 0 });
  const duplicate = coordinator.request({ item_id: 'one', sentence: 'mañana', offset: 0 });
  const overBudget = coordinator.request({ item_id: 'two', sentence: 'mañana', offset: 1 });
  assert.strictEqual(first, duplicate);
  assert.equal(await overBudget, null);
  assert.equal((await first).decision, 'keep');
  assert.equal(calls, 1);
});

test('an old batch cannot erase a new matching request after cancellation', async () => {
  const factory = await loadGlobal('content/request-coordinator.js', 'LangslyRequestCoordinator');
  const releases = [];
  const coordinator = factory.createBatchCoordinator({
    keyOf: ({ sentence }) => sentence,
    send: (items) => new Promise(resolve => releases.push(() => resolve(items))),
  });
  const oldRequest = coordinator.request({ sentence: 'mañana' });
  await tick();
  coordinator.cancel();
  const newRequest = coordinator.request({ sentence: 'mañana' });
  releases.shift()();
  assert.equal(await oldRequest, null);
  await tick();
  assert.strictEqual(coordinator.request({ sentence: 'mañana' }), newRequest);
  releases.shift()();
  assert.deepEqual(await newRequest, { sentence: 'mañana' });
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

test('batch coordinator reports when a full window has room again', async () => {
  const factory = await loadGlobal('content/request-coordinator.js', 'LangslyRequestCoordinator');
  const coordinator = factory.createBatchCoordinator({
    maxBatch: 20, maxPerWindow: 2, windowMs: 60_000, send: (items) => Promise.resolve(items.map(() => null)),
  });
  assert.equal(coordinator.msUntilCapacity(), 0);
  coordinator.request({ id: 1 });
  coordinator.request({ id: 2 });
  const wait = coordinator.msUntilCapacity();
  assert.ok(wait > 59_000 && wait <= 60_000);
  coordinator.cancel();
  assert.equal(coordinator.msUntilCapacity(), 0);
});

test('unjudged words are retried, not dropped, and an unchanged sync keeps the page', async () => {
  const content = await readFile(new URL('../content/content.js', import.meta.url), 'utf8');
  const worker = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
  // No queue-time expiry that throws away later batches.
  assert.doesNotMatch(content, /expired = true/);
  // Over budget: stop queueing and come back later without spending an attempt.
  assert.match(content, /msUntilCapacity\(\) > 0\) \{\s*scheduleValidationRetry\(\);\s*break;/);
  assert.match(content, /if \(deferred\) \{[\s\S]{0,80}validationQueued: false[\s\S]{0,40}scheduleValidationRetry\(\)/);
  // Same vocabulary (key order ignored) must not wipe the page.
  assert.match(content, /signature === vocabularySignature\) \{[\s\S]{0,400}requestPendingValidations\(\);\s*return;/);
  assert.match(content, /Object\.keys\(value\)\.sort\(\)/);
  // Changed vocabulary restarts validation budgets in the background.
  assert.match(worker, /if \(vocabularyChanged\) _resetAutomaticBudget\('disambiguate'\)/);
});

// ─── Validation client: precheck, 400, 429, backoff ───
// The real content scripts on a small page, with the worker's response shapes.
const GREETINGS = [
  { id: 'w-hello', term: 'hola', translation: 'hello', search_language: 'en', term_language: 'es', part_of_speech: 'interjection',
    source_forms: ['hello'], effective_runtime_triggers: ['hello'], searchable_forms: [], pronunciation_audio: null, validation_version: 2 },
  { id: 'w-goodbye', term: 'adiós', translation: 'goodbye', search_language: 'en', term_language: 'es', part_of_speech: 'interjection',
    source_forms: ['goodbye'], effective_runtime_triggers: ['goodbye'], searchable_forms: [], pronunciation_audio: null, validation_version: 2 },
];
const THANKS = { id: 'w-thanks', term: 'gracias', translation: 'thanks', search_language: 'en', term_language: 'es', part_of_speech: 'interjection',
  source_forms: ['thanks'], effective_runtime_triggers: ['thanks'], searchable_forms: [], pronunciation_audio: null, validation_version: 2 };
const TERMS = { 'w-hello': 'hola', 'w-goodbye': 'adiós', 'w-thanks': 'gracias' };
const TWO_BLOCKS = '<p>Hello there.</p><p>Goodbye now.</p>';
const candidate = item => String(item.candidate_ids[0]);
const verdict = item => ({ item_id: item.item_id, validation_version: 2, decision: 'replace',
  replacement_text: TERMS[candidate(item)], vocabulary_ids: [candidate(item)], method: 'test' });
// Values built inside the page's VM realm: compare their shape, not their prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const validations = loaded => loaded.sent.filter(message => message.type === 'VALIDATE_REPLACEMENTS');
const pendingSpans = loaded => loaded.document.querySelectorAll('.lp-validation-pending');
const bodyText = loaded => loaded.document.body.textContent;
// Delays the client asked for that can only be a validation retry: the
// encounter flush also uses 2000, so the backoff shows in the growth from there.
const retryDelays = loaded => loaded.timeouts.filter(ms => ms >= 4000);

// `maxTimerMs` lets a scheduled retry fire inside settle() while the delay
// asked for is still recorded in `timeouts`.
async function greetingPage(respond, { html = TWO_BLOCKS, words = GREETINGS, maxTimerMs = Infinity, rounds = 12 } = {}) {
  const loaded = await loadContentPage({ html, words, validate: respond, maxTimerMs });
  await loaded.settle(rounds);
  return loaded;
}
// "Sync now" with nothing new: the page keeps its spans and asks about what is
// still pending (cancelValidationRetry + requestPendingValidations).
const wake = (loaded, words = GREETINGS) => loaded.window.browser.runtime.listener({ type: 'VOCAB_UPDATED', words });

function pendingSpan(loaded, text, state) {
  const span = loaded.document.createElement('span');
  span.className = 'lp-validation-pending';
  span.setAttribute('data-lp-processed', 'true');
  span.textContent = text;
  loaded.privateState.set(span, { original: text, sourceLanguage: 'en', targetLanguage: 'es', domain: 'news.example.test',
    validationVersion: 2, phrase: false, phraseMatches: [], ...state });
  return span;
}

test('two learner words on adjacent lines reach the server as two single items', async () => {
  // Markdown-rendered pages keep a soft line break inside one text node.
  const loaded = await greetingPage(items => items.map(verdict), { html: '<p>We said hello\n        goodbye to everyone there.</p>' });
  assert.equal(validations(loaded).length, 1);
  const items = plain(validations(loaded)[0].items);
  assert.deepEqual(items.map(item => [item.matched_text, item.phrase]), [['hello', false], ['goodbye', false]]);
  for (const item of items) {
    assert.equal(item.sentence.slice(item.match_offset, item.match_offset + item.matched_text.length), item.matched_text);
    assert.doesNotMatch(item.sentence, /\n/);
  }
  assert.equal(bodyText(loaded), 'We said hola\n        adiós to everyone there.');
  const crlf = await greetingPage(items => items.map(verdict), { html: '<p>We said hello\r\n        goodbye to everyone there.</p>' });
  assert.deepEqual(plain(validations(crlf)[0].items.map(item => [item.matched_text, item.phrase])), [['hello', false], ['goodbye', false]]);
});

test('a span the server would reject is restored locally and never sent', async () => {
  const loaded = await greetingPage(items => items.map(verdict));
  assert.equal(validations(loaded).length, 1);
  // The M-08 shape: a phrase grouped across a soft line break whose sentence
  // ended at that break. Built by hand, because the matcher no longer makes it.
  const broken = pendingSpan(loaded, 'hello\n        goodbye', { sentence: 'We said hello', offset: 8, phrase: true,
    candidates: ['w-hello', 'w-goodbye'], components: ['w-hello', 'w-goodbye'], componentCandidates: [['w-hello'], ['w-goodbye']], proposed: 'hola adiós' });
  const brokenBlock = loaded.document.createElement('p');
  brokenBlock.append('We said ', broken, ' to everyone there.');
  // Offset off by one UTF-16 unit (an emoji before the word): outside the sentence.
  const shifted = pendingSpan(loaded, 'hello', { sentence: '😀 hello', offset: 2,
    candidates: ['w-hello'], components: ['w-hello'], componentCandidates: [['w-hello']], proposed: 'hola' });
  const shiftedBlock = loaded.document.createElement('p');
  shiftedBlock.append('😀 ', shifted);
  // A consistent span beside them still goes out and is judged.
  const good = pendingSpan(loaded, 'hello', { sentence: 'Then hello again.', offset: 5,
    candidates: ['w-hello'], components: ['w-hello'], componentCandidates: [['w-hello']], proposed: 'hola' });
  const goodBlock = loaded.document.createElement('p');
  goodBlock.append('Then ', good, ' again.');
  loaded.document.body.append(brokenBlock, shiftedBlock, goodBlock);

  wake(loaded);
  await loaded.settle(4);
  assert.equal(broken.isConnected, false, 'the broken phrase is plain text again');
  assert.equal(brokenBlock.textContent, 'We said hello\n        goodbye to everyone there.');
  assert.equal(shifted.isConnected, false);
  assert.equal(shiftedBlock.textContent, '😀 hello');
  assert.equal(validations(loaded).length, 2, 'one more request, for the good span only');
  assert.deepEqual(plain(validations(loaded)[1].items.map(item => [item.matched_text, item.sentence, item.match_offset])),
    [['hello', 'Then hello again.', 5]]);
  assert.equal(good.textContent, 'hola');
});

test('400 is final', async () => {
  // Retries would fire at once; a final rejection schedules none.
  const loaded = await greetingPage(() => ({ results: [], error: 'rejected' }), { maxTimerMs: 20, rounds: 20 });
  assert.equal(validations(loaded).length, 1);
  assert.equal(validations(loaded)[0].items.length, 2);
  // Plain text again, nothing pending, no attempt left waiting.
  assert.equal(pendingSpans(loaded).length, 0);
  assert.equal(bodyText(loaded), 'Hello there.Goodbye now.');
  assert.deepEqual(retryDelays(loaded), []);
});

test('429 waits Retry-After', async () => {
  const loaded = await greetingPage(() => ({ results: [], retryAfterMs: 45_000 }), { maxTimerMs: 20, rounds: 20 });
  // Still pending, no attempt spent, and the retry is due when the server said.
  const spans = pendingSpans(loaded);
  assert.equal(spans.length, 2);
  for (const span of spans) {
    assert.equal(loaded.privateState.get(span).validationAttempts, 0);
    assert.equal(loaded.privateState.get(span).validationQueued, false);
  }
  assert.ok(loaded.timeouts.some(ms => ms >= 44_000 && ms <= 45_000), `scheduled ${JSON.stringify(loaded.timeouts)}`);
  // The timer fired early here (capped) and a sync woke the page: nothing
  // goes out before Retry-After, and the attempt count stays untouched.
  wake(loaded);
  await loaded.settle(4);
  assert.equal(validations(loaded).length, 1);
  assert.equal(pendingSpans(loaded).length, 2);
  assert.equal(loaded.privateState.get(pendingSpans(loaded)[0]).validationAttempts, 0);
});

test('deferred items keep the backoff', async () => {
  // Round 1 judges "hello", round 2 judges "goodbye", "thanks" never gets an
  // answer: each partial batch keeps doubling instead of restarting at 2 s.
  let round = 0;
  const loaded = await greetingPage(items => {
    round += 1;
    const judged = round === 1 ? 'w-hello' : round === 2 ? 'w-goodbye' : null;
    return items.filter(item => candidate(item) === judged).map(verdict);
  }, { html: '<p>Hello there.</p><p>Goodbye now.</p><p>Thanks again.</p>', words: [...GREETINGS, THANKS], maxTimerMs: 20, rounds: 40 });
  assert.deepEqual(retryDelays(loaded), [4000, 8000, 16_000, 30_000]);
  assert.equal(round, 6, 'six attempts for the unanswered word');
  assert.equal(bodyText(loaded), 'hola there.adiós now.Thanks again.');
  assert.equal(pendingSpans(loaded).length, 0, 'the unanswered word is plain text after the last attempt');
  // Every item judged in one batch: no retry at all.
  const complete = await greetingPage(items => items.map(verdict), { maxTimerMs: 20, rounds: 20 });
  assert.deepEqual(retryDelays(complete), []);
  assert.equal(bodyText(complete), 'hola there.adiós now.');
});

// ─── Worker: HTTP status → response shape, deadline aborts the request ───
function loadValidateHandler({ status = 200, body = {}, headers = {}, hang = false, deadlineMs = 8000 } = {}) {
  const worker = workerSource;
  const slice = (startMarker, endMarker) => {
    const start = worker.indexOf(startMarker);
    const end = worker.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${startMarker} .. ${endMarker} missing`);
    return worker.slice(start, end);
  };
  const helpers = slice('// ─── Validation responses', 'function withoutChineseTargets')
    .replace('VALIDATION_DEADLINE_MS = 8000', `VALIDATION_DEADLINE_MS = ${deadlineMs}`);
  const handler = slice("if (message.type === 'VALIDATE_REPLACEMENTS')", '// ─── Word Sense Disambiguation');
  const warnings = [];
  const calls = [];
  const context = {
    console: { warn: (...args) => warnings.push(args), log() {}, error() {} },
    Date, Number, Math, Promise, JSON, Array, Set, Object, String, setTimeout, clearTimeout, AbortController,
    authGeneration: 1,
    _consumeAutomaticBudget: () => true,
    getConfig: async () => ({ apiBase: 'https://api.example.test/api' }),
    browser: { storage: { local: { get: async () => ({ difficulty: 'normal', lastSync: 1 }) } } },
    ZH_TARGET_CAPABILITY: 'zh_target_v1',
    authFetch: async (url, init) => {
      calls.push({ url, init });
      if (hang) return new Promise(resolve => init.signal.addEventListener('abort', () => resolve(null)));
      return { ok: status < 400, status, headers: { get: name => headers[name] ?? null }, json: async () => body };
    },
  };
  vm.createContext(context);
  vm.runInContext(`${helpers}\nthis.handle = (message, sender) => { ${handler} };`, context);
  return { handle: context.handle, warnings, calls };
}
const workerSource = await readFile(new URL('../background/service-worker.js', import.meta.url), 'utf8');
const ITEMS = [
  { item_id: '1', validation_version: 2, sentence: 'We said hello', matched_text: 'hello', match_offset: 8 },
  { item_id: '2', validation_version: 2, sentence: 'Goodbye now.', matched_text: 'Goodbye', match_offset: 0 },
];

test('the worker maps 400 to a final rejection and logs field names only', async () => {
  const { handle, warnings } = loadValidateHandler({ status: 400,
    body: { items: [{}, { match_offset: ['Span is outside sentence.'] }], detail: 'Bad request.' } });
  assert.deepEqual(plain(await handle({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {})), { results: [], error: 'rejected' });
  assert.equal(warnings.length, 1);
  assert.deepEqual(plain(warnings[0][1]), ['items[1].match_offset', 'detail']);
  const logged = JSON.stringify(warnings);
  assert.doesNotMatch(logged, /Span is outside|Bad request|We said hello|Goodbye/);
});

test('the worker turns 429 into retryAfterMs from Retry-After, one minute by default', async () => {
  const { handle } = loadValidateHandler({ status: 429, headers: { 'Retry-After': '45' }, body: { code: 'rate_limited' } });
  assert.deepEqual(plain(await handle({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {})), { results: [], retryAfterMs: 45_000 });
  const bare = loadValidateHandler({ status: 429, body: { code: 'rate_limited' } });
  assert.deepEqual(plain(await bare.handle({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {})), { results: [], retryAfterMs: 60_000 });
  const dated = loadValidateHandler({ status: 429, headers: { 'Retry-After': new Date(Date.now() + 90_000).toUTCString() } });
  const { retryAfterMs } = await dated.handle({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {});
  assert.ok(retryAfterMs > 85_000 && retryAfterMs <= 90_000, String(retryAfterMs));
});

test('the worker aborts the request at the deadline and keeps 5xx retryable', async () => {
  const { handle, calls } = loadValidateHandler({ hang: true, deadlineMs: 30 });
  const started = Date.now();
  assert.deepEqual(plain(await handle({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {})), { results: [], error: 'validator_unavailable' });
  assert.ok(Date.now() - started < 2000);
  assert.equal(calls[0].init.signal.aborted, true, 'the fetch itself was aborted');
  const outage = loadValidateHandler({ status: 503, body: {} });
  assert.deepEqual(plain(await outage.handle({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {})), { results: [], error: 'validator_unavailable' });
  const fine = loadValidateHandler({ status: 200, body: { validation_version: 2, results: [{ item_id: '1', decision: 'keep' }] } });
  assert.deepEqual(plain(await fine.handle({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {})), { results: [{ item_id: '1', decision: 'keep' }] });
});
