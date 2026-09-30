// Minimal DOM for driving the vendored Hanzi Writer build and the practice
// panel in Node. It counts listeners so tests can prove full teardown.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Counts registrations the way EventTarget stores them: the same handler,
// type and capture flag registered twice is one listener.
class CountingTarget extends EventTarget {
  constructor() {
    super();
    this.registered = new Map();
  }

  static key(type, options) {
    const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
    return `${type}|${capture}`;
  }

  addEventListener(type, handler, options) {
    super.addEventListener(type, handler, options);
    const key = CountingTarget.key(type, options);
    if (!this.registered.has(key)) this.registered.set(key, new Set());
    this.registered.get(key).add(handler);
  }

  removeEventListener(type, handler, options) {
    super.removeEventListener(type, handler, options);
    this.registered.get(CountingTarget.key(type, options))?.delete(handler);
  }

  get listenerCounts() {
    const counts = new Map();
    for (const [key, handlers] of this.registered) {
      const type = key.split('|')[0];
      counts.set(type, (counts.get(type) || 0) + handlers.size);
    }
    return counts;
  }

  get listenerTotal() {
    return [...this.registered.values()].reduce((sum, handlers) => sum + handlers.size, 0);
  }
}

class FakeClassList {
  constructor(element) { this.element = element; }

  get set() { return new Set(String(this.element.className || '').split(/\s+/).filter(Boolean)); }

  add(...names) { const set = this.set; names.forEach(n => set.add(n)); this.element.className = [...set].join(' '); }

  remove(...names) { const set = this.set; names.forEach(n => set.delete(n)); this.element.className = [...set].join(' '); }

  contains(name) { return this.set.has(name); }

  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : !!force;
    if (on) this.add(name); else this.remove(name);
    return on;
  }
}

export class FakeElement extends CountingTarget {
  constructor(tagName, ownerDocument, size) {
    super();
    this.nodeName = tagName.toUpperCase();
    this.tagName = this.nodeName;
    this.ownerDocument = ownerDocument;
    this.attributes = {};
    this.childNodes = [];
    this.parentNode = null;
    this.style = { removeProperty(name) { delete this[name]; } };
    this.size = size;
    this.captured = null;
    this.className = '';
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.type = '';
    this.ownText = '';
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }

  setAttributeNS(_ns, name, value) { this.setAttribute(name, value); }

  getAttribute(name) { return this.attributes[name]; }

  hasAttribute(name) { return name in this.attributes; }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    this.ownerDocument.notify();
    return child;
  }

  append(...children) { for (const child of children) this.appendChild(child); }

  removeChild(child) {
    this.childNodes = this.childNodes.filter(node => node !== child);
    child.parentNode = null;
    this.ownerDocument.notify();
    return child;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  get children() { return this.childNodes; }

  get firstChild() { return this.childNodes[0] || null; }

  set innerHTML(_value) { this.childNodes = []; }

  get textContent() { return this.ownText + this.childNodes.map(child => child.textContent).join(''); }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.ownText = String(value ?? '');
    this.ownerDocument.notify();
  }

  get isConnected() {
    let node = this;
    while (node.parentNode || node.host) node = node.parentNode || node.host;
    return node === this.ownerDocument.body;
  }

  attachShadow() {
    this.shadowRoot = new FakeElement('#shadow-root', this.ownerDocument, this.size);
    this.shadowRoot.host = this;
    return this.shadowRoot;
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  focus() { this.ownerDocument.activeElement = this; }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.size, height: this.size, right: this.size, bottom: this.size };
  }

  setPointerCapture(id) { this.captured = id; }

  releasePointerCapture() { this.captured = null; }

  hasPointerCapture(id) { return this.captured === id; }

  get allDescendants() { return this.childNodes.flatMap(child => [child, ...child.allDescendants]); }

  find(predicate) { return this.allDescendants.find(predicate); }

  /** Dispatch a trusted-looking click (EventTarget events are never isTrusted). */
  click() {
    const event = new Event('click', { cancelable: true });
    Object.defineProperty(event, 'isTrusted', { value: true });
    this.dispatchEvent(event);
  }
}

export class FakeDocument extends CountingTarget {
  constructor(size = 300) {
    super();
    this.size = size;
    this.visibilityState = 'visible';
    this.observers = new Set();
    this.defaultView = new CountingTarget();
    this.body = new FakeElement('body', this, size);
    this.activeElement = null;
  }

  createElementNS(_ns, tagName) { return new FakeElement(tagName, this, this.size); }

  createElement(tagName) { return new FakeElement(tagName, this, this.size); }

  getElementById() { return null; }

  notify() { for (const observer of this.observers) observer.pending = true; }

  flushObservers() {
    for (const observer of [...this.observers]) {
      if (observer.pending) {
        observer.pending = false;
        observer.callback([]);
      }
    }
  }

  get MutationObserver() {
    const doc = this;
    return class FakeMutationObserver {
      constructor(callback) { this.callback = callback; this.pending = false; }

      observe() { doc.observers.add(this); }

      disconnect() { doc.observers.delete(this); }
    };
  }
}

/** Load the vendored UMD build into its own context, as scripting.executeScript does. */
export async function loadVendoredHanziWriter(doc) {
  const source = await readFile(new URL('../vendor/hanzi-writer/hanzi-writer.min.js', import.meta.url), 'utf8');
  const context = vm.createContext({
    window: { location: { href: 'chrome-extension://test/' }, document: doc },
    document: doc,
    performance,
    requestAnimationFrame: callback => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: handle => clearTimeout(handle),
    setTimeout,
    clearTimeout,
    console,
    Promise,
    Math,
    Date,
  });
  context.window.requestAnimationFrame = context.requestAnimationFrame;
  context.window.cancelAnimationFrame = context.cancelAnimationFrame;
  context.window.performance = performance;
  vm.runInContext(`${source}\n;globalThis.__HW = HanziWriter;`, context);
  return context.__HW;
}

export async function readPackagedData(character) {
  const file = `${character.codePointAt(0).toString(16)}.json`;
  return JSON.parse(await readFile(new URL(`../vendor/hanzi-writer-data/2.0.1/${file}`, import.meta.url), 'utf8'));
}

const pointerEvent = (type, x, y, pointerId = 1, pointerType = 'touch') => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId, pointerType, button: 0 });
  return event;
};

export const toSurfacePoints = (positioner, points) => points.map(([x, y]) => ({
  x: x * positioner.scale + positioner.xOffset,
  y: positioner.height - positioner.yOffset - y * positioner.scale,
}));

const densify = (points, steps = 6) => {
  const result = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      result.push({ x: points[i].x + (points[i + 1].x - points[i].x) * t, y: points[i].y + (points[i + 1].y - points[i].y) * t });
    }
  }
  result.push(points[points.length - 1]);
  return result;
};

export const drawStroke = (surface, points, { pointerId = 1, end = 'pointerup' } = {}) => {
  const path = densify(points);
  surface.dispatchEvent(pointerEvent('pointerdown', path[0].x, path[0].y, pointerId));
  for (const point of path.slice(1)) surface.dispatchEvent(pointerEvent('pointermove', point.x, point.y, pointerId));
  const last = path[path.length - 1];
  surface.dispatchEvent(pointerEvent(end, last.x, last.y, pointerId));
};

export const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
