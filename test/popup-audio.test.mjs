import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const popupSource = await readFile(new URL('../content/popup.js', import.meta.url), 'utf8');

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
    this.textContent = '';
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

  setAttribute(name, value) {
    this.attributes[name] = String(value);
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

function createHarness({ storageData = {}, playResult = Promise.resolve() } = {}) {
  const audioInstances = [];
  const speechCalls = [];
  const document = {
    body: new TestElement('body'),
    createElement: tag => new TestElement(tag),
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
      sendMessage: async () => ({}),
    },
  };

  function Audio(src) {
    this.src = src;
    this.play = () => playResult;
    audioInstances.push(this);
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

test('listen button shows fallback styling when no real audio is available', async () => {
  const harness = createHarness();

  await harness.VocabPopup.showWord(harness.makeSpan({ audioUrl: '' }));
  const listenButton = harness.document.body.querySelector('.lp-popup-listen');

  assert.equal(listenButton.classList.contains('lp-popup-listen-fallback'), true);

  await listenButton.click();
  await flushMicrotasks();

  assert.equal(harness.audioInstances.length, 0);
  assert.deepEqual(harness.speechCalls, [{ text: 'hola', lang: 'es' }]);
});
