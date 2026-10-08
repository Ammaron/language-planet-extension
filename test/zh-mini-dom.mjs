// A small standards-shaped DOM for running the real content scripts in Node:
// elements, text, fragments, simple selectors (no combinators), TreeWalker
// with NodeFilter semantics, and trusted-looking click dispatch. Enough for
// content.js, matcher.js and popup.js; nothing more.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const NodeFilter = {
  SHOW_ELEMENT: 0x1, SHOW_TEXT: 0x4, SHOW_ALL: 0xffffffff,
  FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3,
};
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;
const FRAGMENT_NODE = 11;

class MiniNode {
  constructor(document, nodeType) {
    this.ownerDocument = document;
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node.nodeType === DOCUMENT_NODE) return true;
      node = node.parentNode || node.host || null;
    }
    return false;
  }

  get firstChild() { return this.childNodes[0] || null; }

  get nextSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get previousSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) - 1] || null;
  }

  _adopt(child) {
    if (child.nodeType === FRAGMENT_NODE) return [...child.childNodes].map(node => { node.parentNode = null; return node; });
    if (child.parentNode) child.parentNode.removeChild(child);
    return [child];
  }

  appendChild(child) {
    for (const node of this._adopt(child)) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
    if (child.nodeType === FRAGMENT_NODE) child.childNodes = [];
    return child;
  }

  append(...nodes) { nodes.forEach(node => this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node)); }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    const nodes = this._adopt(child);
    const index = this.childNodes.indexOf(reference);
    nodes.forEach(node => { node.parentNode = this; });
    this.childNodes.splice(index, 0, ...nodes);
    if (child.nodeType === FRAGMENT_NODE) child.childNodes = [];
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(replacement, child) {
    this.insertBefore(replacement, child);
    this.removeChild(child);
    return child;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  get textContent() {
    if (this.nodeType === TEXT_NODE) return this.data;
    return this.childNodes.map(node => node.textContent).join('');
  }

  set textContent(value) {
    if (this.nodeType === TEXT_NODE) { this.data = String(value); return; }
    this.childNodes.forEach(node => { node.parentNode = null; });
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(value)));
  }
}

class MiniText extends MiniNode {
  constructor(document, data) {
    super(document, TEXT_NODE);
    this.data = String(data);
  }

  get nodeValue() { return this.data; }
  set nodeValue(value) { this.data = String(value); }
}

class MiniFragment extends MiniNode {
  constructor(document) { super(document, FRAGMENT_NODE); }
}

class ClassList {
  constructor(element) { this.element = element; }
  get values() { return String(this.element.className || '').split(/\s+/).filter(Boolean); }
  add(...names) { this.element.className = [...new Set([...this.values, ...names])].join(' '); }
  remove(...names) { this.element.className = this.values.filter(name => !names.includes(name)).join(' '); }
  contains(name) { return this.values.includes(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

function parseCompound(selector) {
  const match = /^([a-zA-Z][\w-]*|\*)?((?:\.[\w-]+|\[[^\]]+\])*)$/.exec(selector.trim());
  if (!match) throw new Error(`Unsupported selector: ${selector}`);
  const parts = { tag: match[1] && match[1] !== '*' ? match[1].toUpperCase() : null, classes: [], attributes: [] };
  for (const piece of match[2].match(/\.[\w-]+|\[[^\]]+\]/g) || []) {
    if (piece.startsWith('.')) parts.classes.push(piece.slice(1));
    else {
      const [, name, value] = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(piece);
      parts.attributes.push({ name, value });
    }
  }
  return parts;
}

function matchesCompound(element, parts) {
  if (parts.tag && element.tagName !== parts.tag) return false;
  if (parts.classes.some(name => !element.classList.contains(name))) return false;
  return parts.attributes.every(({ name, value }) => element.hasAttribute(name)
    && (value === undefined || element.getAttribute(name) === value));
}

class MiniElement extends MiniNode {
  constructor(document, tagName) {
    super(document, ELEMENT_NODE);
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.attributes = new Map();
    this.className = '';
    this.classList = new ClassList(this);
    this.style = {};
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.isContentEditable = false;
    this.shadow = null;
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get children() { return this.childNodes.filter(node => node.nodeType === ELEMENT_NODE); }

  getAttribute(name) {
    if (name === 'class') return this.className || null;
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    if (name === 'class') { this.className = String(value); return; }
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) { return name === 'class' ? !!this.className : this.attributes.has(name); }
  removeAttribute(name) { if (name === 'class') this.className = ''; else this.attributes.delete(name); }

  matches(selector) {
    return selector.split(',').some(part => matchesCompound(this, parseCompound(part)));
  }

  closest(selector) {
    for (let node = this; node && node.nodeType === ELEMENT_NODE; node = node.parentNode) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.childNodes) {
        if (child.nodeType !== ELEMENT_NODE) continue;
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }

  dispatch(type, init = {}) {
    const event = {
      type, isTrusted: true, target: this, defaultPrevented: false, ...init,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
    };
    for (let node = this; node && !event.stopped; node = node.parentNode || node.host) {
      for (const handler of [...(node.listeners?.get(type) || [])]) handler.call(node, event);
    }
    return event;
  }

  click() { return this.dispatch('click'); }
  focus() {}
  getBoundingClientRect() { return { top: 10, bottom: 30, left: 10, right: 80, width: 70, height: 20 }; }

  attachShadow() {
    this.shadow = new MiniFragment(this.ownerDocument);
    this.shadow.host = this;
    this.shadow.append = (...nodes) => nodes.forEach(node => this.shadow.appendChild(node));
    this.shadow.querySelectorAll = selector => MiniElement.prototype.querySelectorAll.call(this.shadow, selector);
    this.shadow.querySelector = selector => this.shadow.querySelectorAll(selector)[0] || null;
    return this.shadow;
  }
}

class TreeWalker {
  constructor(root, whatToShow, filter) {
    this.root = root;
    this.whatToShow = whatToShow;
    this.filter = filter;
    this.currentNode = root;
  }

  _shows(node) {
    const bit = node.nodeType === ELEMENT_NODE ? NodeFilter.SHOW_ELEMENT : node.nodeType === TEXT_NODE ? NodeFilter.SHOW_TEXT : 0;
    return (this.whatToShow & bit) !== 0;
  }

  _accept(node) {
    if (!this._shows(node)) return NodeFilter.FILTER_SKIP;
    if (!this.filter) return NodeFilter.FILTER_ACCEPT;
    return typeof this.filter === 'function' ? this.filter(node) : this.filter.acceptNode(node);
  }

  nextNode() {
    let node = this.currentNode;
    let descend = true;
    for (;;) {
      let next = null;
      if (descend && node.childNodes.length) next = node.childNodes[0];
      else {
        for (let current = node; current && current !== this.root; current = current.parentNode) {
          if (current.nextSibling) { next = current.nextSibling; break; }
        }
      }
      if (!next) return null;
      const verdict = this._accept(next);
      node = next;
      descend = verdict !== NodeFilter.FILTER_REJECT;
      if (verdict === NodeFilter.FILTER_ACCEPT) {
        this.currentNode = next;
        return next;
      }
    }
  }
}

class MiniDocument extends MiniNode {
  constructor() {
    super(null, DOCUMENT_NODE);
    this.ownerDocument = this;
    this.readyState = 'complete';
    this.hidden = false;
    this.listeners = new Map();
    this.documentElement = this.createElement('html');
    this.appendChild(this.documentElement);
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
  }

  createElement(tag) { return new MiniElement(this, tag); }
  createElementNS(_namespace, tag) { return new MiniElement(this, tag); }
  createTextNode(text) { return new MiniText(this, text); }
  createDocumentFragment() { return new MiniFragment(this); }
  createTreeWalker(root, whatToShow, filter) { return new TreeWalker(root, whatToShow, filter); }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
}

// Builds elements from a tiny HTML subset: <tag attr="v">text</tag>, nested.
export function parseHtml(document, html, parent) {
  const stack = [parent];
  const pattern = /<\/([a-z0-9]+)>|<([a-z0-9]+)((?:\s+[\w-]+="[^"]*")*)\s*>|([^<]+)/gi;
  for (const match of html.matchAll(pattern)) {
    const top = stack[stack.length - 1];
    if (match[1]) stack.pop();
    else if (match[2]) {
      const element = document.createElement(match[2]);
      for (const [, name, value] of match[3].matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(name, value);
      top.appendChild(element);
      stack.push(element);
    } else top.appendChild(document.createTextNode(match[4]));
  }
}

const ROOT = new URL('../', import.meta.url);
const SCRIPTS = ['content/request-coordinator.js', 'content/grammar-rules.js', 'content/matcher.js', 'content/popup.js', 'content/content.js'];

export async function loadContentPage({ html, words, storage = {}, validate, audio = {}, whitelist = [], location, navigation }) {
  const document = new MiniDocument();
  parseHtml(document, html, document.body);
  const state = { vocabWords: words, rotation_salt: '', frontendUrl: 'https://langsly.com', ...storage };
  const sent = [];
  const spoken = [];
  const played = [];
  const storageListeners = [];
  const browser = {
    storage: {
      local: {
        get: async (keys) => {
          const list = keys === undefined ? Object.keys(state) : Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter(key => key in state).map(key => [key, state[key]]));
        },
        set: async (values) => { Object.assign(state, values); },
      },
      onChanged: { addListener: listener => storageListeners.push(listener) },
    },
    runtime: {
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener: listener => { browser.runtime.listener = listener; } },
      sendMessage: async (message) => {
        sent.push(message);
        if (message.type === 'GET_WHITELIST') return { domains: whitelist };
        if (message.type === 'VALIDATE_REPLACEMENTS') return { results: await validate(message.items) };
        if (message.type === 'FETCH_AUDIO') return { success: false };
        return { success: true };
      },
    },
  };
  class FakeAudio {
    constructor(url) { this.url = url; }
    addEventListener() {}
    removeEventListener() {}
    play() {
      played.push(this.url);
      return audio.fail ? Promise.reject(new Error('404')) : Promise.resolve();
    }
  }
  const observers = new Set();
  const intervals = new Set();
  const window = {
    document, browser, NodeFilter, Node: { ELEMENT_NODE, TEXT_NODE },
    location: location || { href: 'https://news.example.test/article', hostname: 'news.example.test', pathname: '/article' },
    navigation,
    innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0,
    history: { pushState() {}, replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ backgroundColor: 'rgb(255, 255, 255)' }),
    matchMedia: () => ({ matches: false }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    setInterval: (handler, ms) => { const id = setInterval(handler, ms); id.unref?.(); intervals.add(id); return id; },
    clearInterval: (id) => { intervals.delete(id); clearInterval(id); },
    Audio: FakeAudio,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    speechSynthesis: { speak: utterance => spoken.push(utterance) },
    setTimeout, clearTimeout, queueMicrotask, Promise, console, URL, Intl, Date, Math, JSON,
  };
  window.window = window;
  window.globalThis = window;
  window.self = window;
  const context = vm.createContext(window);
  for (const script of SCRIPTS) {
    vm.runInContext(await readFile(new URL(script, ROOT), 'utf8'), context, { filename: script });
  }
  return {
    document, window, state, sent, spoken, played, observers, intervals,
    changeStorage: (values) => {
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: state[key], newValue }]));
      Object.assign(state, values);
      for (const listener of storageListeners) listener(changes, 'local');
    },
    settle: async (rounds = 12) => { for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setTimeout(resolve, 15)); },
    islands: () => document.querySelectorAll('.lp-zh-island'),
    popup: () => {
      const host = document.body.childNodes.find(node => node.shadow);
      return host ? host.shadow.childNodes.find(node => node.className && node.className.includes('lp-vocab-popup')) : null;
    },
  };
}
