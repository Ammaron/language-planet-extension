import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const popupSource = await readFile(new URL('../content/popup.js', import.meta.url), 'utf8');
const toolbarPopupHtml = await readFile(new URL('../popup/popup.html', import.meta.url), 'utf8');
const toolbarPopupCss = await readFile(new URL('../popup/popup.css', import.meta.url), 'utf8');

class TestClassList {
  constructor(element) {
    this.element = element;
    this.classes = new Set();
  }

  setFromString(value) {
    this.classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }

  sync() {
    this.element._className = [...this.classes].join(' ');
  }

  add(...tokens) {
    for (const token of tokens) this.classes.add(token);
    this.sync();
  }

  remove(...tokens) {
    for (const token of tokens) this.classes.delete(token);
    this.sync();
  }

  contains(token) {
    return this.classes.has(token);
  }
}

class TestElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this._textContent = '';
    this.disabled = false;
    this.type = '';
    this.isConnected = true;
    this.listeners = new Map();
    this.classList = new TestClassList(this);
    this._className = '';
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value || '');
    this.classList.setFromString(this._className);
  }

  get textContent() {
    return this._textContent + this.children.map(child => child.textContent || '').join('');
  }

  set textContent(value) {
    this._textContent = String(value || '');
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') {
      this.className = value;
    }
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
    this.isConnected = false;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  async click() {
    const event = {
      target: this,
      preventDefault() {},
      stopPropagation() {},
    };
    const results = (this.listeners.get('click') || []).map(handler => handler(event));
    await Promise.all(results.filter(result => result && typeof result.then === 'function'));
  }

  contains(target) {
    if (target === this) return true;
    return this.children.some(child => child.contains && child.contains(target));
  }

  getBoundingClientRect() {
    return { bottom: 20, left: 20, width: 240, height: 120 };
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    if (!selector.startsWith('.')) return [];
    const className = selector.slice(1);
    const results = [];

    function visit(node) {
      if (node.classList && node.classList.contains(className)) results.push(node);
      for (const child of node.children || []) visit(child);
    }

    visit(this);
    return results;
  }
}

function createHarness({ storageData = {}, playResult = Promise.resolve(), onMessage = async () => ({}) } = {}) {
  const audioInstances = [];
  const speechCalls = [];
  const document = {
    body: new TestElement('body'),
    createElement: tag => new TestElement(tag),
    createElementNS: (namespace, tag) => {
      const el = new TestElement(tag);
      el.namespaceURI = namespace;
      return el;
    },
    addEventListener() {},
    removeEventListener() {},
  };

  const browser = {
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) {
            return Object.fromEntries(key.map(name => [name, storageData[name]]));
          }
          return { [key]: storageData[key] };
        },
      },
    },
    runtime: {
      sendMessage: onMessage,
    },
  };

  function Audio(src) {
    this.src = src;
    audioInstances.push(this);
    this.play = () => (
      typeof playResult === 'function'
        ? playResult(src, audioInstances.length - 1)
        : playResult
    );
  }

  function SpeechSynthesisUtterance(text) {
    this.text = text;
    this.lang = '';
  }

  const sandbox = {
    Audio,
    browser,
    console,
    document,
    Error,
    JSON,
    Map,
    Promise,
    Set,
    SpeechSynthesisUtterance,
    String,
    URL,
    parseInt,
    setTimeout(callback) {
      callback();
      return 0;
    },
    speechSynthesis: {
      speak(utterance) {
        speechCalls.push({ text: utterance.text, lang: utterance.lang });
      },
    },
    window: {
      innerWidth: 1024,
      scrollX: 0,
      scrollY: 0,
    },
  };

  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${popupSource}\nglobalThis.__VocabPopup = VocabPopup;`, sandbox, {
    filename: 'popup.js',
  });

  function makeSpan(dataset = {}) {
    const span = new TestElement('span');
    span.dataset = {
      original: 'hello',
      translation: 'hola',
      termLanguage: 'es',
      ...dataset,
    };
    return span;
  }

  return {
    VocabPopup: sandbox.__VocabPopup,
    audioInstances,
    document,
    makeSpan,
    speechCalls,
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

test('listen button plays relative synced audio from the API origin', async () => {
  const harness = createHarness({
    storageData: { apiBase: 'https://api.langsly.com/api' },
  });

  await harness.VocabPopup.showWord(harness.makeSpan({
    audioUrl: '/media/pronunciations/hola.mp3',
  }));
  const listenButton = harness.document.body.querySelector('.lp-popup-listen');

  await listenButton.click();
  await flushMicrotasks();

  assert.equal(harness.audioInstances.length, 1);
  assert.equal(harness.audioInstances[0].src, 'https://api.langsly.com/media/pronunciations/hola.mp3');
  assert.equal(harness.speechCalls.length, 0);
});

test('listen button renders a Phosphor speaker SVG instead of emoji text', async () => {
  const harness = createHarness();

  await harness.VocabPopup.showWord(harness.makeSpan({
    audioUrl: '/media/pronunciations/hola.mp3',
  }));
  const listenButton = harness.document.body.querySelector('.lp-popup-listen');
  const icon = listenButton.querySelector('.lp-popup-listen-icon');

  assert.equal(listenButton.textContent.includes('\uD83D\uDD0A'), false);
  assert.ok(icon);
  assert.equal(icon.tagName, 'SVG');
  assert.equal(icon.attributes['data-icon-source'], 'phosphor');
  assert.equal(icon.attributes['data-icon-name'], 'speaker-high');
  assert.equal(icon.attributes.viewBox, '0 0 256 256');
  assert.equal(icon.attributes['aria-hidden'], 'true');
});

test('word popup alert actions render Phosphor icons instead of warning emoji text', async () => {
  const harness = createHarness();

  await harness.VocabPopup.showWord(harness.makeSpan({
    audioUrl: '/media/pronunciations/hola.mp3',
  }));
  const buttons = harness.document.body.querySelectorAll('.lp-popup-listen');
  const wrongButton = buttons[1];
  const icon = wrongButton.querySelector('.lp-popup-action-icon');

  assert.equal(wrongButton.textContent.includes('\u26A0'), false);
  assert.ok(icon);
  assert.equal(icon.tagName, 'SVG');
  assert.equal(icon.attributes['data-icon-source'], 'phosphor');
  assert.equal(icon.attributes['data-icon-name'], 'warning-circle');
});

test('phrase report action renders a Phosphor alert icon instead of warning emoji text', () => {
  const harness = createHarness();
  const span = harness.makeSpan({
    original: 'hello world',
    phraseType: 'composed',
  });
  span.textContent = 'hola mundo';

  harness.VocabPopup.showPhrase(span, [
    { original: 'hello', word: { term: 'hola' } },
    { original: 'world', word: { term: 'mundo' } },
  ]);
  const reportButton = harness.document.body.querySelector('.lp-popup-listen');
  const icon = reportButton.querySelector('.lp-popup-action-icon');

  assert.equal(reportButton.textContent.includes('\u26A0'), false);
  assert.ok(icon);
  assert.equal(icon.tagName, 'SVG');
  assert.equal(icon.attributes['data-icon-source'], 'phosphor');
  assert.equal(icon.attributes['data-icon-name'], 'warning-circle');
});

test('toolbar popout dashboard link renders a Phosphor external-link icon', () => {
  assert.match(toolbarPopupHtml, /class="dashboard-link-icon"/);
  assert.match(toolbarPopupHtml, /data-icon-source="phosphor"/);
  assert.match(toolbarPopupHtml, /data-icon-name="arrow-square-out"/);
  assert.doesNotMatch(toolbarPopupCss, /\.dashboard-link::after/);
});

test('listen button falls back to speech synthesis when real audio playback fails', async () => {
  const brokenPlayback = {
    then(resolve, reject) {
      reject(new Error('audio failed'));
    },
  };
  const harness = createHarness({
    storageData: { apiBase: 'https://api.langsly.com/api' },
    playResult: brokenPlayback,
  });

  await harness.VocabPopup.showWord(harness.makeSpan({
    audioUrl: '/media/pronunciations/hola.mp3',
  }));
  const listenButton = harness.document.body.querySelector('.lp-popup-listen');

  await listenButton.click();
  await flushMicrotasks();

  assert.equal(harness.audioInstances.length, 1);
  assert.deepEqual(harness.speechCalls, [{ text: 'hola', lang: 'es' }]);
  assert.equal(listenButton.disabled, false);
});

test('listen button retries lesson audio through the extension when page playback is blocked', async () => {
  const blockedPlayback = {
    then(resolve, reject) {
      reject(new Error('blocked by page policy'));
    },
  };
  const extensionMessages = [];
  const harness = createHarness({
    storageData: { apiBase: 'https://api.langsly.com/api' },
    playResult(src) {
      return src.startsWith('data:audio/mpeg;base64,')
        ? Promise.resolve()
        : blockedPlayback;
    },
    onMessage: async (message) => {
      extensionMessages.push(message);
      if (message.type === 'FETCH_AUDIO') {
        return { success: true, dataUrl: 'data:audio/mpeg;base64,YXVkaW8=' };
      }
      return { success: true };
    },
  });

  await harness.VocabPopup.showWord(harness.makeSpan({
    audioUrl: '/media/pronunciations/hola.mp3',
  }));
  const listenButton = harness.document.body.querySelector('.lp-popup-listen');

  await listenButton.click();
  await flushMicrotasks();

  assert.equal(JSON.stringify(extensionMessages), JSON.stringify([
    {
      type: 'FETCH_AUDIO',
      url: 'https://api.langsly.com/media/pronunciations/hola.mp3',
    },
  ]));
  assert.equal(harness.audioInstances.length, 2);
  assert.equal(harness.audioInstances[1].src, 'data:audio/mpeg;base64,YXVkaW8=');
  assert.equal(harness.speechCalls.length, 0);
  assert.equal(listenButton.disabled, false);
});

test('listen button shows fallback styling when no real audio is available', async () => {
  const harness = createHarness();

  await harness.VocabPopup.showWord(harness.makeSpan({ audioUrl: '' }));
  const listenButton = harness.document.body.querySelector('.lp-popup-listen');

  assert.equal(listenButton.classList.contains('lp-popup-listen-fallback'), true);
  assert.equal(listenButton.textContent, 'Escuchar (voz)');
  assert.equal(
    listenButton.title,
    'No hay audio de pronunciación disponible; se usará la voz del navegador',
  );

  await listenButton.click();
  await flushMicrotasks();

  assert.equal(harness.audioInstances.length, 0);
  assert.deepEqual(harness.speechCalls, [{ text: 'hola', lang: 'es' }]);
});

test('listen button syncs stale words and plays newly available audio before voice fallback', async () => {
  const storageData = {
    apiBase: 'https://api.langsly.com/api',
    vocabWords: [
      {
        id: 'word_hola',
        term: 'hola',
        pronunciation_audio: '',
      },
    ],
  };
  const syncMessages = [];
  const harness = createHarness({
    storageData,
    onMessage: async (message) => {
      syncMessages.push(message);
      if (message.type === 'SYNC_NOW') {
        storageData.vocabWords = [
          {
            id: 'word_hola',
            term: 'hola',
            pronunciation_audio: '/api/media/assets/audio-1/content/',
          },
        ];
      }
      return { success: true };
    },
  });

  await harness.VocabPopup.showWord(harness.makeSpan({
    wordId: 'word_hola',
    audioUrl: '',
  }));
  const listenButton = harness.document.body.querySelector('.lp-popup-listen');

  await listenButton.click();
  await flushMicrotasks();

  assert.equal(JSON.stringify(syncMessages), JSON.stringify([{ type: 'SYNC_NOW' }]));
  assert.equal(harness.audioInstances.length, 1);
  assert.equal(harness.audioInstances[0].src, 'https://api.langsly.com/api/media/assets/audio-1/content/');
  assert.equal(harness.speechCalls.length, 0);
});

test('phrase component rows open the normal word popup so their lesson audio can play', async () => {
  const harness = createHarness({
    storageData: { apiBase: 'https://api.langsly.com/api' },
  });
  const phraseSpan = harness.makeSpan({
    original: 'hello good morning',
    phraseType: 'composed',
  });
  phraseSpan.textContent = 'hola buenos dias';

  harness.VocabPopup.showPhrase(phraseSpan, [
    {
      original: 'hello',
      matchedForm: 'hello',
      word: {
        id: 'word_hello',
        term: 'hola',
        translation: 'hello',
        term_language: 'es',
        search_language: 'en',
        pronunciation_audio: '/media/pronunciations/hola.mp3',
      },
    },
    {
      original: 'morning',
      matchedForm: 'morning',
      word: {
        id: 'word_morning',
        term: 'manana',
        translation: 'morning',
        term_language: 'es',
        search_language: 'en',
        pronunciation_audio: '/media/pronunciations/manana.mp3',
      },
    },
  ]);

  const rows = harness.document.body.querySelectorAll('.lp-phrase-word-row');
  await rows[0].click();
  await flushMicrotasks();

  const listenButton = harness.document.body.querySelector('.lp-popup-listen');
  await listenButton.click();
  await flushMicrotasks();

  assert.equal(harness.audioInstances.length, 1);
  assert.equal(harness.audioInstances[0].src, 'https://api.langsly.com/media/pronunciations/hola.mp3');
  assert.equal(harness.speechCalls.length, 0);
});
