import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { FakeDocument, settle } from './writing-practice-dom.mjs';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [practiceSource, popupSource] = await Promise.all([read('content/writing-practice.js'), read('content/popup.js')]);
const manifest = JSON.parse(await read('vendor/hanzi-writing-manifest.json'));
const sha = Object.fromEntries(manifest.characters.map(entry => [entry.character, entry.sha256]));

function loadPopup({ stored = {} } = {}) {
  const doc = new FakeDocument(300);
  const messages = [];
  const sandbox = {
    document: doc,
    window: { innerHeight: 800, innerWidth: 1200, scrollX: 0, scrollY: 0 },
    browser: {
      runtime: {
        getURL: path => `chrome-extension://test/${path}`,
        sendMessage: async (message) => { messages.push(message); return { success: false }; },
      },
      storage: { local: { get: async key => ({ [key]: stored[key] }) } },
    },
    setTimeout, clearTimeout, Promise, Event, crypto, performance,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(practiceSource, context, { filename: 'content/writing-practice.js' });
  vm.runInContext(`${popupSource}\n;globalThis.VocabPopup = VocabPopup;`, context, { filename: 'content/popup.js' });
  return { doc, messages, context, VocabPopup: context.VocabPopup, state: context.LangslyPrivateState };
}

function wordSpan(env, overrides = {}) {
  const span = env.doc.createElement('span');
  span.className = 'lp-vocab-word';
  env.doc.body.appendChild(span);
  env.state.set(span, {
    wordId: 'c1', original: 'hello', translation: '你好', baseTranslation: 'hello', termLanguage: 'zh',
    targetLanguage: 'zh', sourceLanguage: 'en', audioUrl: '',
    hanziWriting: {
      feature: 'hanzi-writing', vocabulary_word_id: 'w1', script: 'Hans',
      characters: [
        { index: 0, text: '你', status: 'supported', data_version: '2.0.1', sha256: sha['你'] },
        { index: 1, text: '好', status: 'supported', data_version: '2.0.1', sha256: sha['好'] },
      ],
    },
    ...overrides,
  });
  return span;
}

const popupRoot = env => env.doc.body.childNodes.find(node => node.shadowRoot)?.shadowRoot;
const buttons = root => root.allDescendants.filter(node => node.nodeName === 'BUTTON');
const labels = root => buttons(root).map(node => node.textContent.trim());

test('the normal popup is unchanged for English and Spanish targets', async () => {
  for (const termLanguage of ['es', 'en']) {
    const env = loadPopup();
    await env.VocabPopup.showWord(wordSpan(env, { termLanguage, targetLanguage: termLanguage, sourceLanguage: 'zh' }));
    const shown = labels(popupRoot(env));
    assert.equal(shown.length, 3, shown.join(', '));
    assert.ok(shown.includes('Wrong meaning?') && shown.includes('Mark incorrect'));
    assert.ok(!shown.includes('Practice writing'), termLanguage);
    assert.ok(!popupRoot(env).find(node => String(node.className).includes('lp-writing')), 'no writing markup at all');
    env.VocabPopup.hide();
  }
});

test('an eligible Chinese word gets one secondary action that opens nothing by itself', async () => {
  const env = loadPopup();
  await env.VocabPopup.showWord(wordSpan(env));
  const root = popupRoot(env);
  const practice = buttons(root).filter(node => node.textContent === 'Practice writing');
  assert.equal(practice.length, 1);
  const popup = root.childNodes.find(node => String(node.className).includes('lp-vocab-popup'));
  const rows = popup.childNodes.map(node => node.className);
  assert.ok(rows.indexOf('lp-popup-actions lp-writing-entry') > rows.indexOf('lp-popup-actions'), 'below meaning and audio actions');
  assert.ok(!popup.find(node => String(node.className).includes('lp-writing-panel')), 'no panel before the click');
  assert.ok(!env.messages.some(message => String(message.type).startsWith('HANZI_')), 'dormant until opened');
  env.VocabPopup.hide();
});

test('opt-out hides the action', async () => {
  const env = loadPopup({ stored: { hanziWritingPracticeEnabled: false } });
  await env.VocabPopup.showWord(wordSpan(env));
  assert.ok(!labels(popupRoot(env)).includes('Practice writing'));
});

test('practice replaces the details, Back to word restores them, Close removes everything', async () => {
  const env = loadPopup();
  const span = wordSpan(env);
  await env.VocabPopup.showWord(span);
  const root = popupRoot(env);
  const popup = root.childNodes.find(node => String(node.className).includes('lp-vocab-popup'));
  const details = [...popup.childNodes];
  buttons(root).find(node => node.textContent === 'Practice writing').click();
  await settle(5);
  assert.ok(details.every(node => node.hidden), 'details are kept, hidden');
  assert.ok(popup.find(node => String(node.className).includes('lp-writing-panel')));
  assert.equal(env.messages.filter(message => message.type === 'HANZI_WRITER_LOAD').length, 1, 'library requested on click only');

  buttons(root).find(node => node.textContent === 'Back to word').click();
  assert.ok(details.every(node => !node.hidden));
  assert.ok(!popup.find(node => String(node.className).includes('lp-writing-panel')));

  buttons(root).find(node => node.textContent === 'Practice writing').click();
  await settle(5);
  buttons(root).find(node => node.textContent === 'Close').click();
  assert.equal(popupRoot(env), undefined, 'popup closed');
  await settle(15);
  assert.deepEqual(Object.fromEntries([...env.doc.listenerCounts].filter(([, n]) => n)), {}, 'no document listeners remain after close');
  assert.equal(env.doc.defaultView.listenerTotal, 0);
  assert.equal(env.doc.activeElement, span, 'focus returns to the word');
});

test('Escape closes practice and returns focus to the word', async () => {
  const env = loadPopup();
  const span = wordSpan(env);
  await env.VocabPopup.showWord(span);
  buttons(popupRoot(env)).find(node => node.textContent === 'Practice writing').click();
  await settle(5);
  const escape = new Event('keydown');
  escape.key = 'Escape';
  env.doc.dispatchEvent(escape);
  assert.equal(popupRoot(env), undefined);
  assert.equal(env.doc.activeElement, span);
  await settle(15);
  assert.equal(env.doc.listenerTotal, 0);
});
