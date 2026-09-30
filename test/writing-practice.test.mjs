import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  FakeDocument, drawStroke, loadVendoredHanziWriter, readPackagedData, settle, toSurfacePoints,
} from './writing-practice-dom.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
vm.runInThisContext(await read('content/writing-practice.js'), { filename: 'content/writing-practice.js' });
vm.runInThisContext(await read('background/hanzi-practice.js'), { filename: 'background/hanzi-practice.js' });
const Practice = globalThis.LangslyWritingPractice;
const Background = globalThis.LangslyHanziPractice;
const vendorManifest = JSON.parse(await read('vendor/hanzi-writing-manifest.json'));
const packaged = Object.fromEntries(vendorManifest.characters.map(entry => [entry.character, entry]));

const reference = (overrides = {}) => ({
  feature: 'hanzi-writing',
  vocabulary_word_id: 'w1',
  script: 'Hans',
  characters: ['你', '好'].map((text, index) => ({
    index, text, status: 'supported', data_version: '2.0.1', sha256: packaged[text].sha256, stroke_count: packaged[text].stroke_count,
  })),
  ...overrides,
});
const wordState = (overrides = {}) => ({ translation: '你好', termLanguage: 'zh', hanziWriting: reference(), ...overrides });

// ─── Eligibility ────────────────────────────────────────────────────────────

test('only Simplified Chinese target words with a server reference are eligible', () => {
  const eligible = Practice.eligibleReference(wordState());
  assert.equal(eligible.vocabularyWordId, 'w1');
  assert.deepEqual(eligible.characters.map(entry => entry.text), ['你', '好']);
  for (const termLanguage of ['zh-hans', 'zh-CN', 'zh_Hans']) {
    assert.ok(Practice.eligibleReference(wordState({ termLanguage })), termLanguage);
  }
});

test('English and Spanish targets never qualify, even on Chinese pages or with Han text', () => {
  for (const termLanguage of ['en', 'es', 'es-MX', '', undefined]) {
    assert.equal(Practice.eligibleReference(wordState({ termLanguage, sourceLanguage: 'zh' })), null, String(termLanguage));
  }
  assert.equal(Practice.eligibleReference(wordState({ termLanguage: 'es', hanziWriting: reference() })), null);
});

test('Traditional targets, missing references, opt-out and mismatches are ineligible', () => {
  for (const termLanguage of ['zh-hant', 'zh-TW', 'zh-HK']) assert.equal(Practice.eligibleReference(wordState({ termLanguage })), null);
  assert.equal(Practice.eligibleReference(wordState({ hanziWriting: null })), null);
  assert.equal(Practice.eligibleReference(wordState(), { enabled: false }), null);
  assert.equal(Practice.eligibleReference(wordState({ translation: '您好' })), null, 'displayed text must be the checked term');
  assert.equal(Practice.eligibleReference(wordState({ grammarForm: true })), null);
  assert.equal(Practice.eligibleReference(wordState({ hanziWriting: reference({ script: 'Hant' }) })), null);
  const unsupported = reference();
  unsupported.characters = unsupported.characters.map(entry => ({ ...entry, status: 'unsupported' }));
  assert.equal(Practice.eligibleReference(wordState({ hanziWriting: unsupported })), null);
});

test('punctuation is skipped and unsupported characters stay listed honestly', () => {
  const mixed = reference();
  mixed.characters.push({ index: 2, text: '吗', status: 'unsupported' }, { index: 3, text: '？', status: 'not_han' });
  const eligible = Practice.eligibleReference(wordState({ translation: '你好吗？', hanziWriting: mixed }));
  assert.deepEqual(eligible.characters.map(entry => [entry.text, entry.supported]), [['你', true], ['好', true], ['吗', false]]);
});

test('quiz options never rely on upstream defaults', () => {
  for (const mode of ['trace', 'write']) {
    const options = Practice.quizOptionsFor(mode);
    assert.equal(options.acceptBackwardsStrokes, false);
    assert.equal(options.markStrokeCorrectAfterMisses, false);
    assert.equal(options.leniency, 1.3);
  }
  assert.equal(Practice.quizOptionsFor('trace').showHintAfterMisses, 3);
  assert.equal(Practice.quizOptionsFor('write').showHintAfterMisses, false);
});

// ─── Panel with the real vendored Hanzi Writer ─────────────────────────────

async function openHarness({ loader } = {}) {
  const doc = new FakeDocument(300);
  const HanziWriter = await loadVendoredHanziWriter(doc);
  const popup = doc.createElement('div');
  const anchor = doc.createElement('span');
  doc.body.append(anchor, popup);
  const sent = [];
  let libraryLoads = 0;
  const runtime = {
    async sendMessage(message) {
      sent.push(message);
      if (message.type === 'HANZI_CHARACTER_DATA') return { success: true, data: await readPackagedData(message.character) };
      return { success: true };
    },
  };
  const spy = { writers: [] };
  const events = [];
  const controller = Practice.openPanel({
    host: popup,
    anchor,
    reference: Practice.eligibleReference(wordState()),
    runtime,
    doc,
    reducedMotion: true,
    MutationObserverImpl: doc.MutationObserver,
    libraryLoader: loader || (async () => { libraryLoads += 1; }),
    writerFactory: (element, character, options) => {
      const writer = HanziWriter.create(element, character, options);
      spy.writers.push({ writer, element, character, options });
      return writer;
    },
    onBack: () => events.push('back'),
    onClose: detail => events.push(detail.reason),
  });
  await controller.ready;
  const current = () => spy.writers[spy.writers.length - 1];
  const surface = () => current().element.find(node => node.nodeName === 'SVG');
  const draw = (character, stroke, { reverse = false, end } = {}) => {
    const medians = spy.data[character].medians[stroke];
    const points = toSurfacePoints(current().writer._positioner, reverse ? [...medians].reverse() : medians);
    drawStroke(surface(), points, { end });
  };
  spy.data = { 你: await readPackagedData('你'), 好: await readPackagedData('好') };
  return { doc, popup, anchor, controller, sent, events, spy, draw, current, surface, libraryLoads: () => libraryLoads };
}

const records = sent => sent.filter(message => message.type === 'HANZI_PRACTICE_RECORD').map(message => message.summary);

test('panel starts in Trace and rejects every wrong-order and backwards stroke for the pilot', async () => {
  for (const character of ['你', '好']) {
    const strokeCount = packaged[character].stroke_count;
    for (const mode of ['trace', 'write']) {
      const harness = await openHarness();
      assert.equal(harness.controller.mode, 'trace');
      if (character === '好') harness.controller.selectCharacter(1);
      if (mode === 'write') harness.controller.selectMode('write');
      await harness.controller.ready;
      for (let expected = 0; expected < strokeCount; expected += 1) {
        for (let drawn = expected + 1; drawn < strokeCount; drawn += 1) {
          harness.draw(character, drawn);
          await settle(5);
          assert.equal(harness.controller.session.state.strokeIndex, expected, `${character} ${mode}: stroke ${drawn} before ${expected}`);
        }
        harness.draw(character, expected, { reverse: true });
        await settle(5);
        assert.equal(harness.controller.session.state.strokeIndex, expected, `${character} ${mode}: stroke ${expected} backwards`);
        harness.draw(character, expected);
        await settle(5);
        assert.equal(harness.controller.session.state.strokeIndex, expected + 1, `${character} ${mode}: correct stroke ${expected}`);
      }
      await settle(30);
      assert.equal(harness.controller.session.state.complete, true);
      const [summary] = records(harness.sent);
      assert.equal(summary.character, character);
      assert.equal(summary.mode, mode);
      assert.equal(summary.outcome, 'completed');
      assert.ok(summary.mistakes > 0);
      assert.ok(Background.validateSummary(summary), 'the panel only sends summaries the background accepts');
      harness.controller.close();
    }
  }
});

test('a cancelled stroke is discarded, not graded, and the stroke can be drawn again', async () => {
  const harness = await openHarness();
  harness.draw('你', 0, { end: 'pointercancel' });
  await settle(10);
  assert.equal(harness.controller.session.state.strokeIndex, 0);
  assert.equal(harness.controller.session.state.totalMistakes, 0);
  harness.draw('你', 0);
  await settle(10);
  assert.equal(harness.controller.session.state.strokeIndex, 1);
  harness.controller.close();
});

test('close, Escape, anchor removal and repeated open/close remove every listener', async () => {
  const baseline = new FakeDocument();
  for (let round = 0; round < 3; round += 1) {
    const harness = await openHarness();
    assert.ok(harness.controller.listenerCount > 0);
    assert.ok(harness.doc.listenerTotal > 0, 'Escape and visibility listeners are registered while open');
    harness.controller.selectMode('watch');
    await harness.controller.ready;
    harness.controller.selectMode('write');
    await harness.controller.ready;
    harness.controller.close();
    assert.equal(harness.controller.listenerCount, 0);
    assert.equal(harness.doc.listenerTotal, baseline.listenerTotal, 'no document mouseup/touchend or other listeners remain');
    assert.equal(harness.doc.defaultView.listenerTotal, 0);
    assert.equal(harness.doc.observers.size, 0);
    assert.equal(harness.popup.childNodes.length, 0);
  }

  const escape = await openHarness();
  const keydown = new Event('keydown');
  keydown.key = 'Escape';
  escape.doc.dispatchEvent(keydown);
  assert.deepEqual(escape.events, ['escape']);
  escape.controller.close();

  const navigation = await openHarness();
  navigation.anchor.remove();
  navigation.doc.flushObservers();
  assert.deepEqual(navigation.events, ['anchor_removed']);
  navigation.controller.close();
  assert.equal(navigation.doc.listenerTotal, 0);
});

test('help follows the step: Trace has hints, Write and Watch do not', async () => {
  const harness = await openHarness();
  const labels = () => harness.popup.find(node => String(node.className).includes('lp-writing-tools')).childNodes.map(node => node.textContent);
  assert.deepEqual(labels(), ['Hint', 'Show me', 'Start again']);
  harness.controller.selectMode('write');
  await harness.controller.ready;
  assert.deepEqual(labels(), ['Start again']);
  assert.equal(harness.current().options.showHintAfterMisses, false);
  assert.equal(harness.current().options.showOutline, false);
  harness.controller.selectMode('watch');
  await harness.controller.ready;
  assert.deepEqual(labels(), ['Play', 'Next stroke']);
  harness.controller.close();
});

test('choosing Watch plays the strokes without another click', async () => {
  const harness = await openHarness();
  assert.equal(records(harness.sent).length, 0, 'Trace never plays anything by itself');
  harness.controller.selectMode('watch');
  await harness.controller.ready;
  for (let i = 0; i < 100 && !records(harness.sent).length; i += 1) await settle(20);
  const [watched] = records(harness.sent);
  assert.equal(watched.mode, 'watch');
  assert.equal(watched.outcome, 'watched');
  assert.equal(watched.character, '你');
  harness.controller.close();
});

test('the library loads only after the panel opens, and missing data offers a retry', async () => {
  const harness = await openHarness();
  assert.equal(harness.libraryLoads(), 1);
  harness.controller.close();

  let attempts = 0;
  const failing = await openHarness({ loader: async () => { attempts += 1; if (attempts === 1) throw new Error('offline'); } });
  assert.equal(failing.controller.session, null);
  assert.match(failing.popup.textContent, /unavailable right now/);
  failing.popup.find(node => node.nodeName === 'BUTTON' && node.textContent === 'Retry').click();
  await failing.controller.ready;
  assert.equal(attempts, 2);
  assert.ok(failing.controller.session, 'retry loads the writer');
  assert.match(failing.popup.textContent, /Trace each stroke/);
  failing.controller.close();
  assert.equal(failing.doc.listenerTotal, 0);
});

test('unsupported characters show an honest message instead of a writer', async () => {
  const doc = new FakeDocument();
  const popup = doc.createElement('div');
  const anchor = doc.createElement('span');
  doc.body.append(anchor, popup);
  const mixed = reference();
  mixed.characters.push({ index: 2, text: '吗', status: 'unsupported' });
  const controller = Practice.openPanel({
    host: popup, anchor, doc, runtime: { sendMessage: async () => ({ success: false }) },
    reference: Practice.eligibleReference(wordState({ translation: '你好吗', hanziWriting: mixed })),
    libraryLoader: async () => { throw new Error('offline'); },
    MutationObserverImpl: doc.MutationObserver,
  });
  await settle(5);
  assert.match(popup.textContent, /unavailable right now/);
  assert.match(popup.textContent, /Retry/);
  controller.selectCharacter(2);
  await settle(5);
  assert.match(popup.textContent, /no reviewed stroke data/);
  controller.close();
  assert.equal(doc.listenerTotal, 0);
});

// ─── Background: packaged data and bounded summaries ───────────────────────

function backgroundHarness({ statuses = [] } = {}) {
  const store = {};
  const storage = {
    async get(key) { return { [key]: store[key] }; },
    async set(values) { Object.assign(store, JSON.parse(JSON.stringify(values))); },
    async remove(key) { delete store[key]; },
  };
  const posted = [];
  const files = {};
  const practice = Background.create({
    storage,
    fetchPackaged: async (path) => {
      if (files[path]) return files[path];
      return new Uint8Array(await readFile(new URL(`../${path}`, import.meta.url))).buffer;
    },
    digestHex: async bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
    send: async (summary) => { posted.push(summary); return statuses.length ? statuses.shift() : 201; },
  });
  return { practice, store, posted, files };
}

const summary = (overrides = {}) => ({
  vocabulary_word_id: 'w1', character_index: 0, character: '你', data_version: '2.0.1', mode: 'trace',
  outcome: 'completed', mistakes: 2, hints_used: 1, source: 'extension', client_attempt_id: crypto.randomUUID(), ...overrides,
});

test('summaries carry only the vocabulary item, data version and result', () => {
  assert.ok(Background.validateSummary(summary()));
  for (const bad of [
    { page_url: 'https://example.test/' }, { page_text: 'hello' }, { strokes: [[1, 2]] },
    { mode: 'write', outcome: 'needs_another_try' }, { mode: 'watch', outcome: 'watched', mistakes: 1 },
    { source: 'web' }, { client_attempt_id: 'x' }, { character: '你好' }, { mistakes: -1 },
  ]) {
    assert.equal(Background.validateSummary({ ...summary(), ...bad }), null, JSON.stringify(bad));
  }
});

test('queue deduplicates, stays bounded, drops permanent errors and clears on account change', async () => {
  const { practice, store, posted } = backgroundHarness({ statuses: [400] });
  const first = summary();
  await practice.record(first);
  await practice.record(first);
  await practice.flush();
  assert.equal(posted.length, 1);
  assert.equal((store.hanziPracticeQueue || []).length, 0, 'a permanent 400 is dropped');

  const retrying = backgroundHarness({ statuses: [503, 503, 503, 503, 503] });
  await retrying.practice.record(summary());
  for (let i = 0; i < 5; i += 1) await retrying.practice.flush();
  assert.equal(retrying.posted.length, 5);
  assert.equal(retrying.store.hanziPracticeQueue.length, 0, 'bounded retries');

  const bounded = backgroundHarness({ statuses: Array(200).fill(503) });
  for (let i = 0; i < 60; i += 1) await bounded.practice.record(summary());
  assert.ok(bounded.store.hanziPracticeQueue.length <= Background.MAX_QUEUED);
  await bounded.practice.clear();
  assert.equal(bounded.store.hanziPracticeQueue, undefined);
});

test('character data is served only from packaged files that match their checksum', async () => {
  const { practice, files } = backgroundHarness();
  const ok = await practice.characterData({ character: '你', data_version: '2.0.1', sha256: packaged['你'].sha256 });
  assert.equal(ok.success, true);
  assert.equal(ok.data.strokes.length, 7);
  assert.equal((await practice.characterData({ character: '吗', data_version: '2.0.1', sha256: 'x' })).error, 'not_packaged');
  assert.equal((await practice.characterData({ character: '你', data_version: '9.9.9', sha256: packaged['你'].sha256 })).error, 'version_mismatch');
  files[packaged['好'].path] = new TextEncoder().encode('{"strokes":[]}').buffer;
  assert.equal((await practice.characterData({ character: '好', data_version: '2.0.1', sha256: packaged['好'].sha256 })).error, 'checksum_mismatch');
});

// ─── Packaging and runtime boundaries ──────────────────────────────────────

test('writer code is packaged, dormant and never loaded from a CDN', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('content/writing-practice.js') < scripts.indexOf('content/popup.js'));
  assert.ok(!scripts.some(file => file.includes('hanzi-writer')), 'the library is injected on click, not on page load');
  const exposed = (manifest.web_accessible_resources || []).flatMap(entry => entry.resources);
  assert.ok(!exposed.some(file => file.includes('hanzi')), 'nothing writing-related is web-accessible');
  assert.equal(manifest.content_security_policy, undefined, 'the default extension CSP is kept');
  assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'scripting', 'storage']);
  for (const file of ['content/writing-practice.js', 'background/hanzi-practice.js', 'content/popup.js']) {
    assert.doesNotMatch(await read(file), /https?:\/\/(?:cdn|unpkg|jsdelivr)/i, file);
  }
  // Loading the content script defines functions only: no listeners, no messages.
  const doc = new FakeDocument();
  assert.equal(doc.listenerTotal, 0);
});

test('vendored files match the pinned manifest byte for byte', async () => {
  const { verifyHanziVendor } = await import('../release/hanzi-writer-vendor.mjs');
  const root = new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
  const files = verifyHanziVendor(root);
  assert.ok(files.includes('vendor/hanzi-writer/hanzi-writer.min.js'));
  assert.ok(files.includes('vendor/hanzi-writer-data/ARPHICPL.TXT'));
  const licenses = await read('popup/licenses.html');
  for (const path of ['vendor/hanzi-writer/LICENSE', 'vendor/hanzi-writer/COPYING.md', 'vendor/hanzi-writer-data/ARPHICPL.TXT', 'vendor/LICENSE-webextension-polyfill']) {
    assert.ok(licenses.includes(`../${path}`), `${path} is reachable from the licenses page`);
  }
  assert.match(await read('popup/options.html'), /href="licenses\.html"/);
});
