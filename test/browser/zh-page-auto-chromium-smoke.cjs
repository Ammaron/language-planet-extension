// Automatic page language in real Chromium, against a local mock API only.
// A learner of English whose course is taught in Chinese sets nothing: a page
// written in Simplified Chinese (even without a lang tag) swaps 你好 to "hello";
// Traditional Chinese and English pages are left alone; the popup speaks Chinese
// when the browser does.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.LANGSLY_PLAYWRIGHT_MODULE || 'playwright');
const { prepareExtension, assertUsingMock, removeExtensionCopy } = require('./prepare-extension.cjs');

const extensionPath = prepareExtension(path.resolve(__dirname, '../../dist/chrome'));
const outputPath = path.resolve(process.env.LANGSLY_SMOKE_OUTPUT || path.resolve(__dirname, '../../output/playwright/zh-page-auto'));
const profilePath = path.resolve(outputPath, 'profile');
const chromePath = process.env.LANGSLY_CHROMIUM_EXECUTABLE;
const zhWord = {
  id: 'en-hello', term: 'hello', translation: '你好',
  source_forms: ['你好'], effective_runtime_triggers: ['你好'],
  search_language: 'zh', term_language: 'en', validation_version: 2,
};
const requests = { en: 0, zh: 0, validations: 0 };
const filler = '今天天气很好，我们一起去公园散步，看看花，聊聊天，然后回家吃晚饭。';
const pages = {
  '/zh': `<!doctype html><html><head><meta charset="utf-8"><title>新闻</title></head><body><main><p id="t">你好，朋友。${filler}</p><p>${filler}</p></main></body></html>`,
  '/zh-tw': `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"></head><body><main><p id="t">你好，朋友。${filler}</p></main></body></html>`,
  '/en': '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main><p id="t">Hello, friend. The weather is nice today, so we walk in the park.</p></main></body></html>',
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (pages[url.pathname]) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(pages[url.pathname]);
    return;
  }
  const json = (body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === '/api/lessons/vocabpass/whitelist/') return json([]);
  if (url.pathname === '/api/lessons/vocabpass/words/') {
    if (url.searchParams.get('source_language') === 'zh') {
      requests.zh += 1;
      return json({ source_language: 'zh', source_language_ready: true, validation_versions: [2], words: [zhWord], count: 1 });
    }
    requests.en += 1;
    // The English course has nothing to match on English pages for this learner.
    return json({ source_language: 'en', source_language_ready: true, words: [], count: 0 });
  }
  if (url.pathname === '/api/lessons/vocabpass/disambiguate/') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.validations += 1;
      const payload = JSON.parse(body);
      json({ validation_version: 2, results: payload.items.map(item => ({
        item_id: item.item_id, validation_version: 2, decision: 'replace',
        replacement_text: 'hello', vocabulary_ids: [zhWord.id], method: 'local-browser-smoke',
      })) });
    });
    return;
  }
  if (url.pathname === '/api/lessons/vocabpass/encounters/batch/') return json({ success: true });
  response.writeHead(404);
  response.end();
});

(async () => {
  fs.rmSync(profilePath, { recursive: true, force: true });
  fs.mkdirSync(outputPath, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const apiBase = `http://127.0.0.1:${port}/api`;
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      executablePath: chromePath,
      headless: true,
      locale: 'zh-CN',
      args: ['--lang=zh-CN', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;
    await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { apiBase: current } = await browser.storage.local.get('apiBase');
        if (current && current !== LEGACY_DEFAULTS.apiBase) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Extension default API migration did not complete');
    });
    // No page-language setting at all: automatic is the default.
    await worker.evaluate(async ({ token, apiBase }) => browser.storage.local.set({
      authToken: token, apiBase, frontendUrl: 'https://langsly.com',
      difficulty: 'normal', rotation_salt: 'local-smoke', syncStatus: 'syncing',
    }), { token, apiBase });
    await assertUsingMock(worker, apiBase);
    await worker.evaluate(() => syncVocabulary());
    const stored = await worker.evaluate(async () => browser.storage.local.get(['vocabWords', 'vocabWordsZhPage', 'syncStatus', 'pageLanguageAuto']));
    assert.equal(stored.syncStatus, 'success');
    assert.equal(stored.pageLanguageAuto, undefined);
    assert.deepEqual(stored.vocabWords, []);
    assert.equal(stored.vocabWordsZhPage.length, 1);
    assert.deepEqual(requests.en > 0 && requests.zh > 0, true);

    // Simplified Chinese without a lang tag: found by its visible text.
    const zhPage = await context.newPage();
    await zhPage.goto(`http://127.0.0.1:${port}/zh`);
    await zhPage.locator('.lp-vocab-word').first().waitFor({ timeout: 15000 });
    assert.match(await zhPage.locator('#t').innerText(), /^hello，朋友。/);
    await zhPage.screenshot({ path: path.resolve(outputPath, 'zh-page.png') });

    // Traditional Chinese and English pages: nothing to swap.
    for (const route of ['/zh-tw', '/en']) {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}${route}`);
      await page.waitForTimeout(5000);
      assert.equal(await page.locator('.lp-vocab-word').count(), 0, `${route} should stay as it is`);
      await page.close();
    }

    // The popup in a Chinese browser.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    const uiLanguage = await popup.evaluate(() => chrome.i18n.getUILanguage());
    const settingsText = await popup.evaluate(() => chrome.i18n.getMessage('settingsLink'));
    await popup.waitForTimeout(800);
    await popup.screenshot({ path: path.resolve(outputPath, 'popup-zh.png') });
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/popup/options.html`);
    await options.waitForTimeout(800);
    const selected = await options.locator('#page-source-language').inputValue();
    const autoLabel = await options.locator('#page-source-language option[value="auto"]').innerText();
    await options.screenshot({ path: path.resolve(outputPath, 'options-zh.png'), fullPage: true });
    assert.equal(selected, 'auto');
    if (/^zh/i.test(uiLanguage)) {
      assert.equal(settingsText, '设置');
      assert.equal(autoLabel, '自动');
    }
    console.log(JSON.stringify({ passed: true, browser: 'Chromium', uiLanguage, settingsText, autoLabel, requests }));
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    removeExtensionCopy(extensionPath);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
