import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const readText = relativePath => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} missing`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} not closed`);
}

async function loadSubscriptionHelpers() {
  const worker = await readText('background/service-worker.js');
  const storage = {
    authToken: 'access', vocabWords: [{ id: 'w1' }], wordCount: 1, matchableWordCount: 1,
    phrase_a: 1, disambig_b: 2, contextual_c: 3, difficulty: 'easy',
  };
  const sent = [];
  const context = {
    authGeneration: 7,
    SUBSCRIPTION_REQUIRED_CODE: 'vocab_pass_subscription_required',
    _withSessionMutation: task => task(),
    browser: {
      storage: { local: {
        get: async () => ({ ...storage }),
        remove: async keys => { for (const key of keys) delete storage[key]; },
        set: async values => { Object.assign(storage, values); },
      } },
      tabs: {
        query: async () => [{ id: 1 }, { id: 2 }, {}],
        sendMessage: async (id, message) => { sent.push([id, message.type]); },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunction(worker, 'isSubscriptionRequiredResponse')}
${extractFunction(worker, 'applySubscriptionRequired')}
this.isSubscriptionRequiredResponse = isSubscriptionRequiredResponse;
this.applySubscriptionRequired = applySubscriptionRequired;`, context);
  return { context, storage, sent };
}

const response = (status, body) => ({ status, clone: () => ({ json: async () => body }) });

test('only a 402 with the subscription code counts as subscription required', async () => {
  const { context } = await loadSubscriptionHelpers();
  assert.equal(await context.isSubscriptionRequiredResponse(response(402, { code: 'vocab_pass_subscription_required' })), true);
  assert.equal(await context.isSubscriptionRequiredResponse(response(402, { code: 'other' })), false);
  assert.equal(await context.isSubscriptionRequiredResponse(response(403, { code: 'vocab_pass_subscription_required' })), false);
  assert.equal(await context.isSubscriptionRequiredResponse(null), false);
});

test('subscription required clears vocabulary and caches, keeps the session, and stops every page', async () => {
  const { context, storage, sent } = await loadSubscriptionHelpers();
  await context.applySubscriptionRequired(7);
  for (const key of ['vocabWords', 'wordCount', 'matchableWordCount', 'phrase_a', 'disambig_b', 'contextual_c']) {
    assert.equal(key in storage, false, `${key} should be cleared`);
  }
  assert.equal(storage.authToken, 'access');
  assert.equal(storage.difficulty, 'easy');
  assert.equal(storage.subscriptionRequired, true);
  assert.equal(storage.syncStatus, 'subscription_required');
  assert.deepEqual(sent, [[1, 'SUBSCRIPTION_REQUIRED'], [2, 'SUBSCRIPTION_REQUIRED']]);
});

test('a stale generation never applies the subscription state', async () => {
  const { context, storage, sent } = await loadSubscriptionHelpers();
  await context.applySubscriptionRequired(6);
  assert.ok(storage.vocabWords);
  assert.equal(sent.length, 0);
});

test('sync rechecks access and clears the flag after a successful sync; logout clears it', async () => {
  const worker = await readText('background/service-worker.js');
  const sync = worker.slice(worker.indexOf('async function syncVocabulary()'), worker.indexOf('// ─── Vocab Pass subscription'));
  assert.match(sync, /isSubscriptionRequiredResponse\(res\)[\s\S]{0,80}applySubscriptionRequired\(generation\)/);
  assert.match(sync, /subscriptionRequired: false/);
  const clear = worker.slice(worker.indexOf('async function clearTokens()'), worker.indexOf('async function broadcastAuthCleared()'));
  assert.match(clear, /'subscriptionRequired'/);
  assert.match(worker, /subscribeUrl: await getSubscribeUrl\(\)/);
  assert.match(worker, /\$\{frontendUrl\}\/vocab-pass\/subscribe/);
});

// A worker slice with the real 402 detector and a recording applySubscriptionRequired.
function sliceOf(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} .. ${endMarker} missing`);
  return source.slice(start, end);
}

async function loadPaywalledPaths(status, body) {
  const worker = await readText('background/service-worker.js');
  const applied = [];
  const context = {
    console: { warn() {}, log() {}, error() {} },
    Date, Number, Math, Promise, JSON, Array, Set, Object, String, Boolean, setTimeout, clearTimeout, AbortController,
    authGeneration: 3,
    _consumeAutomaticBudget: () => true,
    getConfig: async () => ({ apiBase: 'https://api.example.test/api' }),
    browser: { storage: { local: { get: async () => ({ difficulty: 'normal', lastSync: 1, pendingEncounters: [] }), set: async () => {} } } },
    ZH_TARGET_CAPABILITY: 'zh_target_v1',
    getTokens: async () => ({ access: 'access' }),
    authFetch: async () => ({ ok: status < 400, status, headers: { get: () => null },
      json: async () => body, clone() { return this; } }),
    applySubscriptionRequired: async generation => { applied.push(generation); },
    LangslyEncounterCoordinator: { create: config => config },
  };
  vm.createContext(context);
  vm.runInContext(`const SUBSCRIPTION_REQUIRED_CODE = 'vocab_pass_subscription_required';
${extractFunction(worker, 'isSubscriptionRequiredResponse')}
${sliceOf(worker, '// ─── Validation responses', 'function withoutChineseTargets')}
${sliceOf(worker, 'encounterCoordinator = LangslyEncounterCoordinator.create({', '// ─── Character-writing practice')}
this.encounterSend = encounterCoordinator.send;
this.validate = (message, sender) => { ${sliceOf(worker, "if (message.type === 'VALIDATE_REPLACEMENTS')", '// ─── Word Sense Disambiguation')} };`, context);
  return { context, applied };
}

const ITEMS = [{ item_id: '1', validation_version: 2, sentence: 'We said hello', matched_text: 'hello', match_offset: 8 }];

test('a 402 on the validation path stops every page at once', async () => {
  const { context, applied } = await loadPaywalledPaths(402, { code: 'vocab_pass_subscription_required' });
  const answer = await context.validate({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {});
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), { results: [], error: 'subscription_required' });
  assert.deepEqual(applied, [3]);
  // A 402 without the code is an ordinary failure: cooldown, no paywall.
  const other = await loadPaywalledPaths(402, { code: 'other' });
  const plain = await other.context.validate({ type: 'VALIDATE_REPLACEMENTS', items: ITEMS }, {});
  assert.equal(plain.error, 'validator_unavailable');
  assert.deepEqual(other.applied, []);
});

test('a 402 on the encounter path stops every page at once and keeps the queue', async () => {
  const { context, applied } = await loadPaywalledPaths(402, { code: 'vocab_pass_subscription_required' });
  assert.equal(await context.encounterSend([{ word_id: 'w1', domain: 'news.example.test', interaction: 'automatic_view' }]), false);
  assert.deepEqual(applied, [3]);
  const fine = await loadPaywalledPaths(200, { success: true });
  assert.equal(await fine.context.encounterSend([{ word_id: 'w1' }]), true);
  assert.deepEqual(fine.applied, []);
});

test('content script stops page work on SUBSCRIPTION_REQUIRED and restarts on VOCAB_UPDATED', async () => {
  const content = await readText('content/content.js');
  assert.match(content, /message\.type === 'SUBSCRIPTION_REQUIRED'[\s\S]{0,200}stopDocumentWork\(\);[\s\S]{0,60}enterUnavailable\(\)/);
  assert.match(content, /function enterUnavailable\(\) \{\s*lifecycleState = 'unavailable';\s*stopSafetyController\(\);/);
  assert.match(content, /message\.type === 'VOCAB_UPDATED'/);
});

test('popup, connect and options screens show the subscribe state with a Subscribe on Langsly button', async () => {
  for (const [html, js, button] of [
    ['popup/popup.html', 'popup/popup.js', 'subscribe-btn'],
    ['popup/connect.html', 'popup/connect.js', 'subscribe-connect'],
    ['popup/options.html', 'popup/options.js', 'subscribe-btn'],
  ]) {
    const markup = await readText(html);
    const script = await readText(js);
    assert.match(markup, /data-i18n="subscriptionRequiredTitle"/, html);
    assert.match(markup, new RegExp(`id="${button}"[^>]*data-i18n="subscribeOnLangsly"`), html);
    assert.match(script, /subscriptionRequired/, js);
    assert.match(script, /tabs\.create\(\{ url(?:: subscribeUrl)? \}\)/, js);
  }
});

test('subscription copy exists in English and Spanish and escapes the dollar sign', async () => {
  const en = JSON.parse(await readText('_locales/en/messages.json'));
  const es = JSON.parse(await readText('_locales/es/messages.json'));
  assert.equal(en.subscriptionRequiredTitle.message, 'Vocab Pass needs an active subscription ($$5/month)');
  assert.equal(en.subscribeOnLangsly.message, 'Subscribe on Langsly');
  for (const key of ['subscriptionRequiredTitle', 'subscriptionRequiredBody', 'subscribeOnLangsly', 'statusSubscriptionRequired']) {
    assert.equal(typeof es[key].message, 'string', key);
  }
  assert.match(es.subscriptionRequiredTitle.message, /\$\$5/);
});
