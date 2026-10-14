// LP-253: changing one Options setting must not refetch (or blank) the vocabulary.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [optionsJs, sourceLanguageJs] = await Promise.all([read('popup/options.js'), read('shared/source-language.js')]);

async function loadOptions(storage) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        id, value: '', checked: false, textContent: '', disabled: false, listeners,
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener: (type, handler) => listeners.set(type, handler),
      });
    }
    return elements.get(id);
  };
  const sent = [];
  const context = {
    console, setTimeout, clearTimeout, Promise, Date, Number,
    document: { getElementById: element, documentElement: {} },
    browser: {
      runtime: {
        getManifest: () => ({ version: 'test' }),
        sendMessage: async message => { sent.push(message); return message.type === 'GET_STATUS' ? { isLoggedIn: true } : { success: true }; },
      },
      storage: {
        local: {
          get: async keys => Object.fromEntries([].concat(keys).filter(key => key in storage).map(key => [key, storage[key]])),
          set: async values => { Object.assign(storage, values); },
        },
        onChanged: { addListener() {} },
      },
      tabs: { create() {} },
    },
  };
  context.window = context;
  context.window.addEventListener = () => {};
  vm.createContext(context);
  vm.runInContext(sourceLanguageJs, context);
  vm.runInContext(optionsJs, context);
  await new Promise(resolve => setTimeout(resolve, 10));
  sent.length = 0;
  const change = async (id, value) => {
    const target = element(id);
    if (typeof value === 'boolean') target.checked = value; else target.value = value;
    target.listeners.get('change')();
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  return { sent, change, storage };
}

const types = sent => sent.map(message => message.type);

test('pinyin and writing-practice changes are saved without any worker refetch', async () => {
  const { sent, change, storage } = await loadOptions({ syncInterval: 60, extensionSourceLanguage: 'zh', zhPinyinMode: 'auto' });
  await change('zh-pinyin-mode', 'always');
  await change('writing-practice-enabled', false);
  assert.deepEqual(types(sent), []);
  assert.equal(storage.zhPinyinMode, 'always');
  assert.equal(storage.hanziWritingPracticeEnabled, false);
});

test('only the setting that changed reaches the worker', async () => {
  const { sent, change } = await loadOptions({ syncInterval: 60, extensionSourceLanguage: 'en' });
  await change('sync-interval', '120');
  assert.deepEqual(types(sent), ['UPDATE_CONFIG']);
  assert.equal(sent[0].syncInterval, 120);
  sent.length = 0;
  await change('page-source-language', 'es');
  assert.deepEqual(types(sent), ['SET_SOURCE_LANGUAGE']);
  assert.equal(sent[0].sourceLanguage, 'es');
});
