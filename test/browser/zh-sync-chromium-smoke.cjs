const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.LANGSLY_PLAYWRIGHT_MODULE || 'playwright');

const extensionPath = path.resolve(__dirname, '../../dist/chrome');
const outputPath = path.resolve(__dirname, '../../output/playwright/zh-sync-live');
const profilePath = path.resolve(outputPath, process.env.LANGSLY_BROWSER_PROFILE || 'profile-portable');
const chromePath = process.env.LANGSLY_CHROMIUM_EXECUTABLE;
const word = {
  id: 'reviewed-hello', term: 'hola', translation: '你好',
  source_forms: ['你好'], effective_runtime_triggers: ['你好'],
  search_language: 'zh', term_language: 'es', validation_version: 2,
};
let syncMode = 'ready';
let syncRequests = 0;
let validationRequests = 0;
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html lang="zh-Hans"><body><main><p id="chinese">你好，朋友。</p></main></body></html>');
    return;
  }
  if (pathname === '/api/lessons/vocabpass/whitelist/') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('[]');
    return;
  }
  if (pathname === '/api/lessons/vocabpass/words/') {
    syncRequests += 1;
    if (syncMode === 'fail') {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end('{"detail":"temporary test failure"}');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      source_language: 'zh', source_language_ready: true,
      validation_versions: [2], words: [word], count: 1,
    }));
    return;
  }
  if (pathname === '/api/lessons/vocabpass/disambiguate/') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      validationRequests += 1;
      const payload = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        validation_version: 2,
        results: payload.items.map(item => ({
          item_id: item.item_id, validation_version: 2,
          decision: 'replace', replacement_text: 'hola',
          vocabulary_ids: [word.id], method: 'local-browser-smoke',
        })),
      }));
    });
    return;
  }
  if (pathname === '/api/lessons/vocabpass/encounters/batch/') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"success":true}');
    return;
  }
  response.writeHead(404);
  response.end();
});

(async () => {
  fs.mkdirSync(outputPath, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      executablePath: chromePath,
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    const extensionId = new URL(worker.url()).host;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;
    // Startup migrates an empty or legacy API default asynchronously. Wait for
    // a settled value before installing the loopback mock so it cannot overwrite it.
    await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { apiBase } = await browser.storage.local.get('apiBase');
        if (apiBase && apiBase !== LEGACY_DEFAULTS.apiBase) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Extension default API migration did not complete');
    });
    await worker.evaluate(async ({ token, apiBase }) => browser.storage.local.set({
      authToken: token, apiBase, frontendUrl: 'https://langsly.com',
      extensionSourceLanguage: 'zh', difficulty: 'normal', rotation_salt: 'local-smoke',
      vocabWords: [], wordCount: 0, matchableWordCount: 0,
      lastSync: null, syncStatus: 'syncing',
    }), { token, apiBase: `http://127.0.0.1:${port}/api` });
    await worker.evaluate(() => syncVocabulary());
    const initial = await worker.evaluate(async () => browser.storage.local.get(['vocabWords', 'syncStatus']));
    if (initial.syncStatus !== 'success') {
      const diagnostic = await worker.evaluate(async () => ({
        config: await getConfig(),
        stored: await browser.storage.local.get([
          'extensionSourceLanguage', 'syncStatus', 'wordCount', 'matchableWordCount',
        ]),
      }));
      console.error(JSON.stringify({ phase: 'initial-sync', diagnostic,
        syncRequests, validationRequests }));
    }
    assert.equal(initial.syncStatus, 'success');
    assert.equal(initial.vocabWords.length, 1);

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    try {
      await page.locator('.lp-vocab-word').waitFor({ timeout: 10000 });
    } catch (error) {
      const stored = await worker.evaluate(async () => browser.storage.local.get([
        'vocabWords', 'syncStatus', 'extensionSourceLanguage',
      ]));
      console.error(JSON.stringify({ phase: 'initial-match',
        text: await page.locator('#chinese').innerText(),
        pending: await page.locator('.lp-validation-pending').count(),
        syncRequests, validationRequests,
        wordCount: stored.vocabWords?.length, syncStatus: stored.syncStatus,
        source: stored.extensionSourceLanguage }));
      throw error;
    }
    assert.equal(await page.locator('#chinese').innerText(), 'hola，朋友。');
    assert.ok(validationRequests > 0);
    await page.screenshot({ path: path.resolve(outputPath, 'before-failed-sync.png') });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
    syncMode = 'fail';
    await popup.evaluate(() => browser.runtime.sendMessage({ type: 'SYNC_NOW' }));
    await page.waitForFunction(() => document.querySelectorAll('.lp-vocab-word').length === 0);
    assert.equal(await page.locator('#chinese').innerText(), '你好，朋友。');
    const failed = await worker.evaluate(async () => browser.storage.local.get([
      'vocabWords', 'wordCount', 'matchableWordCount', 'lastSync', 'syncStatus',
    ]));
    assert.deepEqual(failed.vocabWords, []);
    assert.equal(failed.wordCount, 0);
    assert.equal(failed.matchableWordCount, 0);
    assert.equal(failed.lastSync, null);
    assert.equal(failed.syncStatus, 'failed');
    await page.screenshot({ path: path.resolve(outputPath, 'after-failed-sync.png') });

    syncMode = 'ready';
    await popup.evaluate(() => browser.runtime.sendMessage({ type: 'SYNC_NOW' }));
    await page.locator('.lp-vocab-word').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('#chinese').innerText(), 'hola，朋友。');
    const recovered = await worker.evaluate(async () => browser.storage.local.get(['vocabWords', 'syncStatus']));
    assert.equal(recovered.syncStatus, 'success');
    assert.equal(recovered.vocabWords.length, 1);
    await page.screenshot({ path: path.resolve(outputPath, 'after-recovery.png') });
    console.log(JSON.stringify({ passed: true, browser: 'Chromium',
      extensionId, syncRequests, validationRequests,
      failedStatus: failed.syncStatus, recoveredStatus: recovered.syncStatus }));
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
