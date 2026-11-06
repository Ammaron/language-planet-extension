// Chromium smoke test: Chinese islands on an English page of trap sentences,
// against a mocked backend. Asserts the DOM, takes screenshots, and checks the
// glyphs of 直骨角 with and without lang (Japanese and Simplified forms differ).
//
//   LANGSLY_PLAYWRIGHT_MODULE=<path to playwright> node test/browser/zh-target-chromium-smoke.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.LANGSLY_PLAYWRIGHT_MODULE || 'playwright');
const { prepareExtension, assertUsingMock, removeExtensionCopy } = require('./prepare-extension.cjs');

const extensionPath = prepareExtension(path.resolve(__dirname, '../../dist/chrome'));
const outputPath = path.resolve(process.env.LANGSLY_SMOKE_OUTPUT || path.resolve(__dirname, '../../output/playwright/zh-target-smoke'));
const profilePath = path.resolve(outputPath, 'profile');

function row(id, term, gloss, partOfSpeech, triggers, citation, extra = {}) {
  const reading = { citation, spoken: extra.spoken || null, tone_note: extra.tone_note || '' };
  const profile = {
    version: 1, reading, measure_words: extra.measure_words || { countable: null, items: [] }, gloss,
    usage_note: extra.usage_note || `Reviewed usage note for ${term}.`, chunk: extra.chunk || null,
    review: { state: 'approved' },
  };
  return {
    id, term, translation: gloss, term_language: 'zh-Hans', term_script: 'Hans', search_language: 'en',
    part_of_speech: partOfSpeech, source_forms: triggers, effective_runtime_triggers: triggers, searchable_forms: [],
    pronunciation_audio: `/media/${id}.mp3`, validation_version: 2, reading, measure_words: profile.measure_words,
    pinyin_stage: extra.pinyin_stage || 'full', zh_target: profile, example_sentence: '', example_translation: '',
  };
}

const WORDS = [
  row('c-thanks', '谢谢', 'thank you', 'phrase', ['thank you', 'thanks'], ['xiè', 'xie']),
  row('c-hello', '你好', 'hello', 'phrase', ['hello'], ['nǐ', 'hǎo'], { spoken: ['ní', 'hǎo'], tone_note: 'Written nǐ hǎo, said ní hǎo.' }),
  row('c-book', '书', 'book', 'noun', ['book'], ['shū'], {
    measure_words: { countable: true, items: [{ hanzi: '本', pinyin: ['běn'], preferred: true, example: '一本书',
      example_citation: ['yī', 'běn', 'shū'], example_spoken: ['yì', 'běn', 'shū'] }] },
    chunk: { zh: '一本书', citation: ['yī', 'běn', 'shū'], spoken: ['yì', 'běn', 'shū'], en: 'a book' },
  }),
  row('c-renshi', '认识', 'to know (a person)', 'verb', ['know'], ['rèn', 'shi'],
    { chunk: { zh: '我认识他', citation: ['wǒ', 'rèn', 'shi', 'tā'], spoken: null, en: 'I know him' } }),
  row('c-zhidao', '知道', 'to know (a fact)', 'verb', ['know'], ['zhī', 'dao'],
    { chunk: { zh: '我知道', citation: ['wǒ', 'zhī', 'dao'], spoken: null, en: 'I know' } }),
  row('c-gao', '高', 'tall', 'adjective', ['tall'], ['gāo'], { pinyin_stage: 'faded',
    chunk: { zh: '他很高', citation: ['tā', 'hěn', 'gāo'], spoken: null, en: 'he is tall' } }),
  row('c-hao', '好', 'good', 'adjective', ['good'], ['hǎo'], { pinyin_stage: 'hidden',
    chunk: { zh: '很好', citation: ['hěn', 'hǎo'], spoken: null, en: 'very good' } }),
  row('c-chi', '吃', 'to eat', 'verb', ['eat', 'eats'], ['chī'],
    { chunk: { zh: '吃饭', citation: ['chī', 'fàn'], spoken: null, en: 'to eat a meal' } }),
  row('c-kaixin', '开心', 'happy', 'adjective', ['happy'], ['kāi', 'xīn'],
    { chunk: { zh: '很开心', citation: ['hěn', 'kāi', 'xīn'], spoken: null, en: 'very happy' } }),
  row('c-jiao', '角', 'corner', 'noun', ['corner'], ['jiǎo'], {
    measure_words: { countable: true, items: [{ hanzi: '个', pinyin: ['gè'], preferred: true, example: '一个角',
      example_citation: ['yī', 'gè', 'jiǎo'], example_spoken: ['yí', 'gè', 'jiǎo'] }] },
    chunk: { zh: '一个角', citation: ['yī', 'gè', 'jiǎo'], spoken: ['yí', 'gè', 'jiǎo'], en: 'a corner' },
  }),
  row('c-wuyue', '五月', 'May', 'noun', [], ['wǔ', 'yuè']),
];
const TERMS = Object.fromEntries(WORDS.map(word => [word.id, word.term]));

const TRAPS = [
  ['three-books', 'I bought three books today.', []],
  ['two-books', 'We need two books for class.', []],
  ['one-book', 'Please bring one book tomorrow.', []],
  ['tall', 'She is tall.', ['高']],
  ['know-him', 'I know him well.', ['认识']],
  ['raining', "It's raining again.", []],
  ['ate', 'I ate already.', []],
  ['piano', 'They play piano and wear glasses.', []],
  ['bigger', 'This one is bigger.', []],
  ['you-are-good', 'You are good at this.', ['好']],
  ['eats-rice', 'He eats rice every day.', ['吃']],
  ['may', 'We met in May last year.', []],
  ['not-happy', 'I am not happy about it.', ['开心']],
  ['thank-you', 'Thank you for the books.', ['谢谢']],
  ['corner', 'Turn left at the corner.', ['角']],
];

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trap sentences</title>
<style>body{font:18px/2 Georgia,serif;max-width:760px;margin:24px}.glyphs span{font-size:72px;margin-right:24px}</style></head>
<body><main>
${TRAPS.map(([id, sentence]) => `<p id="${id}">${sentence}</p>`).join('\n')}
<p id="bridge"><b>Thank you.</b> <i>Hello!</i></p>
<p id="cjk-block">Thank you (谢谢) for coming.</p>
<section class="glyphs"><span id="glyph-none">直骨角</span><span id="glyph-ja" lang="ja">直骨角</span><span id="glyph-hans" lang="zh-Hans">直骨角</span></section>
</main></body></html>`;

const paragraphs = sentences => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Limits</title></head>
<body><main>${sentences.map(sentence => `<p>${sentence}</p>`).join('\n')}</main></body></html>`;
const WITH_TRIGGERS = ['she is tall', 'I am happy', 'it is good', 'turn at the corner', 'they eat', 'bring the book'];
const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index}: ${WITH_TRIGGERS[index % WITH_TRIGGERS.length]}.`);
const SPANISH_PARAGRAPHS = Array.from({ length: 30 }, () => '<p>La mañana estaba tranquila en el pueblo y todos los vecinos caminaban por la plaza mientras hablaban del tiempo, de la cosecha y de las fiestas que se acercaban. The book is here.</p>').join('');
// An app-style page: nothing to read when it opens, the text is fetched afterwards.
const lateShell = (title, source) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main id="app"></main>
<script>setTimeout(() => fetch('${source}').then(response => response.text()).then(html => { document.getElementById('app').innerHTML = html; }), 2500);</script></body></html>`;
const PAGES = {
  '/rejections': paragraphs([...lines(10, 'Skip'), ...lines(3, 'See')]),
  '/same-paragraph': paragraphs(['Skip this corner now. She is tall.']),
  '/many-rejections': paragraphs(lines(60, 'Skip')),
  '/in-app': paragraphs(lines(24, 'See')),
  '/long-page': paragraphs(Array.from({ length: 400 }, (_, index) => `Filler words about the weather and the road ahead go here so that each block takes room on the screen. Line ${index}: ${WITH_TRIGGERS[index % WITH_TRIGGERS.length]}.`)),
  '/spanish-no-lang': paragraphs(Array.from({ length: 30 }, () => 'La mañana estaba tranquila en el pueblo y todos los vecinos caminaban por la plaza mientras hablaban del tiempo, de la cosecha y de las fiestas que se acercaban. The book is here.')),
  '/script-first-spanish': `<!doctype html><html><head><meta charset="utf-8"><title>Noticias</title></head><body>
<script>window.pageData = ${JSON.stringify(Array.from({ length: 120 }, () => 'the people of the town walk along the road and talk about the weather every morning').join(' '))};</script>
<main>${SPANISH_PARAGRAPHS}</main></body></html>`,
  '/late-spanish': lateShell('Cargando', '/text-spanish'),
  '/text-spanish': SPANISH_PARAGRAPHS,
  '/late-english': lateShell('Loading', '/text-english'),
  '/text-english': Array.from({ length: 12 }, (_, index) => `<p>Everyone in the town walks along the road each morning and talks about the weather. Line ${index}: bring the book.</p>`).join(''),
  '/glued': paragraphs(["The book's cover is blue.", 'A book-lover came by.', 'She read the book today.']),
};

let validationRequests = 0;
const seenItems = [];
const feedbackPosts = [];
let syncUrl = '';
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  } else if (PAGES[url.pathname]) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGES[url.pathname]);
  } else if (url.pathname === '/api/lessons/vocabpass/disambiguate/feedback/') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      // The real serializer refuses a blank sentence.
      const status = String(payload.sentence || '').trim() ? 201 : 400;
      feedbackPosts.push({ status, payload });
      json(status, {});
    });
  } else if (url.pathname === '/api/lessons/vocabpass/whitelist/') json(200, []);
  else if (url.pathname === '/api/lessons/vocabpass/words/') {
    syncUrl = request.url;
    json(200, { source_language: 'en', source_language_ready: true, validation_versions: [2, 3],
      zh_target_enabled: url.searchParams.get('capabilities') === 'zh_target_v1', words: WORDS, count: WORDS.length });
  } else if (url.pathname === '/api/lessons/vocabpass/disambiguate/') {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      validationRequests += 1;
      const payload = JSON.parse(body);
      seenItems.push(...payload.items);
      // Approve everything (the client guards must still hold). For "know",
      // pick 认识 because the object is a person.
      json(200, { validation_version: 2, results: payload.items.map(item => {
        if (/skip/i.test(item.sentence)) {
          return { item_id: item.item_id, validation_version: 2, decision: 'keep', reason: 'none_fit', method: 'validation_v2' };
        }
        const id = item.candidate_ids.includes('c-renshi') ? 'c-renshi' : item.candidate_ids[0];
        return { item_id: item.item_id, validation_version: 2, decision: 'replace', replacement_text: TERMS[id],
          vocabulary_ids: [id], method: 'model:smoke' };
      }) });
    });
  } else if (url.pathname.startsWith('/api/lessons/vocabpass/')) json(200, { success: true });
  else { response.writeHead(404); response.end(); }
});

(async () => {
  fs.rmSync(profilePath, { recursive: true, force: true });
  fs.mkdirSync(outputPath, { recursive: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'chromium',
      executablePath: process.env.LANGSLY_CHROMIUM_EXECUTABLE || undefined,
      headless: true,
      viewport: { width: 900, height: 1400 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.x`;
    await worker.evaluate(async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const { apiBase } = await browser.storage.local.get('apiBase');
        if (apiBase && apiBase !== LEGACY_DEFAULTS.apiBase) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Extension default API migration did not complete');
    });
    await worker.evaluate(async ({ token, apiBase }) => browser.storage.local.set({
      authToken: token, apiBase, frontendUrl: 'https://langsly.com', extensionSourceLanguage: 'en',
      difficulty: 'normal', rotation_salt: 'zh-smoke', zhPinyinMode: 'auto',
      vocabWords: [], wordCount: 0, matchableWordCount: 0, lastSync: null, syncStatus: 'syncing',
    }), { token, apiBase: `http://127.0.0.1:${port}/api` });
    await assertUsingMock(worker, `http://127.0.0.1:${port}/api`);
    await worker.evaluate(() => syncVocabulary());
    const stored = await worker.evaluate(async () => browser.storage.local.get(['vocabWords', 'syncStatus']));
    assert.equal(stored.syncStatus, 'success');
    assert.match(syncUrl, /capabilities=zh_target_v1/);
    // 五月 has no reviewed trigger, so the readiness check drops it.
    assert.deepEqual(stored.vocabWords.map(word => word.id).sort(), WORDS.map(word => word.id).filter(id => id !== 'c-wuyue').sort());

    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.locator('.lp-zh-island').first().waitFor({ timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.lp-validation-pending').length === 0, null, { timeout: 15000 });

    const islands = await page.evaluate(() => [...document.querySelectorAll('.lp-zh-island')].map(island => ({
      paragraph: island.closest('p').id,
      term: [...island.querySelectorAll('ruby')].length
        ? [...island.querySelector('ruby').childNodes].filter(node => node.nodeType === 3).map(node => node.data).join('')
        : island.textContent,
      lang: island.getAttribute('lang'), translate: island.getAttribute('translate'),
      pinyin: island.getAttribute('data-lp-pinyin'),
      rt: [...island.querySelectorAll('rt')].map(rt => rt.textContent),
      font: getComputedStyle(island).fontFamily,
    })));
    const byParagraph = id => islands.filter(island => island.paragraph === id).map(island => island.term);
    for (const [id, sentence, expected] of TRAPS) assert.deepEqual(byParagraph(id), expected, sentence);
    assert.deepEqual(byParagraph('bridge'), ['谢谢'], 'leftmost island wins across nodes and punctuation');
    assert.deepEqual(byParagraph('cjk-block'), [], 'no islands in blocks that already contain Chinese');
    for (const island of islands) {
      assert.equal(island.lang, 'zh-Hans');
      assert.equal(island.translate, 'no');
      assert.match(island.font, /PingFang SC|Microsoft YaHei|Noto Sans SC/);
    }
    const tall = islands.find(island => island.term === '高');
    const good = islands.find(island => island.term === '好');
    const thanks = islands.find(island => island.term === '谢谢');
    assert.equal(tall.pinyin, 'faded');
    assert.equal(good.pinyin, 'hidden');
    assert.deepEqual(thanks.rt, ['xiè', 'xie']);
    const visible = await page.evaluate(() => {
      const clone = document.querySelector('main').cloneNode(true);
      clone.querySelectorAll('rt').forEach(rt => rt.remove());
      return clone.innerText;
    });
    for (const composed of ['是高', '书们', '三书', '二本', '你好 at', '吃了']) assert.equal(visible.includes(composed), false, composed);
    assert.match(visible, /^He 吃 rice/m);
    assert.match(visible, /not 开心/);
    assert.ok(seenItems.every(item => item.phrase === false && item.component_ids.length === 1), 'singles only');
    assert.ok(seenItems.every(item => item.target_language === 'zh-Hans'));
    const knowItem = seenItems.find(item => item.matched_text === 'know');
    assert.deepEqual([...knowItem.candidate_ids].sort(), ['c-renshi', 'c-zhidao']);

    await page.screenshot({ path: path.join(outputPath, 'trap-page.png'), fullPage: true });

    // Glyph check: the same code points with no lang, Japanese and Simplified Chinese.
    const shots = {};
    for (const id of ['glyph-none', 'glyph-ja', 'glyph-hans']) {
      shots[id] = await page.locator(`#${id}`).screenshot({ path: path.join(outputPath, `${id}.png`) });
    }
    const corner = page.locator('#corner .lp-zh-island');
    await corner.screenshot({ path: path.join(outputPath, 'glyph-island-jiao.png') });
    const glyphFonts = await page.evaluate(() => Object.fromEntries(['glyph-none', 'glyph-ja', 'glyph-hans']
      .map(id => [id, getComputedStyle(document.getElementById(id)).fontFamily])));
    const japaneseDiffers = !shots['glyph-ja'].equals(shots['glyph-hans']);

    // Phrase-first popup for 书 (closed shadow root: verified by screenshot).
    await page.locator('#corner .lp-zh-island').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outputPath, 'popup-jiao.png'), clip: { x: 0, y: 0, width: 900, height: 1400 } });

    // "Wrong meaning?" reports the sentence and says "Flagged" once it is saved.
    const popup = page.locator('.lp-zh-popup');
    await popup.getByText('Wrong meaning?').click();
    await popup.getByText('Flagged').waitFor({ timeout: 5000 });
    assert.equal(feedbackPosts.length, 1);
    assert.equal(feedbackPosts[0].status, 201);
    assert.equal(feedbackPosts[0].payload.sentence, 'Turn left at the corner.');
    assert.equal(feedbackPosts[0].payload.match_offset, 'Turn left at the '.length);

    const open = async (route, { everythingNearby = true } = {}) => {
      const opened = await context.newPage();
      await opened.goto(`http://127.0.0.1:${port}${route}`);
      await opened.waitForTimeout(2500);
      if (everythingNearby) await opened.waitForFunction(() => document.querySelectorAll('.lp-validation-pending').length === 0, null, { timeout: 15000 });
      return opened;
    };
    const islandCount = target => target.locator('.lp-zh-island').count();

    // Rejected words give their slots to later sentences.
    const rejections = await open('/rejections');
    assert.equal(await islandCount(rejections), 3, 'three approved sentences after ten rejected ones');
    await rejections.close();

    // A rejected sentence does not cost the next sentence in its paragraph.
    const sameParagraph = await open('/same-paragraph');
    assert.deepEqual(await sameParagraph.locator('.lp-zh-island').evaluateAll(nodes => nodes.map(node => node.getAttribute('lang'))), ['zh-Hans']);
    assert.match(await sameParagraph.locator('p').innerText(), /^Skip this corner now\. She is /);
    await sameParagraph.close();

    // Rejections alone cannot send a long page to the paid validator.
    seenItems.length = 0;
    const manyRejections = await open('/many-rejections');
    await manyRejections.waitForTimeout(2500);
    const attempts = seenItems.length;
    assert.ok(attempts > 10 && attempts <= 30, `${attempts} validation attempts`);
    assert.equal(await islandCount(manyRejections), 0);
    await manyRejections.close();

    // Writing practice has stroke data for the whole course, checked against its hash.
    const strokes = await worker.evaluate(async () => {
      const manifest = await (await fetch(browser.runtime.getURL('vendor/hanzi-writing-manifest.json'))).json();
      const entry = manifest.characters.find(row => row.character === '学');
      const loaded = await hanziPractice.characterData({ character: '学', data_version: entry.data_version, sha256: entry.sha256 });
      const tampered = await hanziPractice.characterData({ character: '学', data_version: entry.data_version, sha256: 'x' });
      return { packaged: manifest.characters.length, success: loaded.success, strokes: loaded.data?.strokes?.length, tampered: tampered.error };
    });
    assert.ok(strokes.packaged > 200, `${strokes.packaged} characters packaged`);
    assert.equal(strokes.success, true);
    assert.equal(strokes.strokes, 8);
    assert.equal(strokes.tampered, 'version_mismatch');

    // A long page: only text near the screen is validated, and words keep coming as the reader scrolls.
    seenItems.length = 0;
    const longPage = await open('/long-page', { everythingNearby: false });
    const firstScreen = await islandCount(longPage);
    const checkedAtFirst = seenItems.length;
    assert.ok(firstScreen > 0, 'words near the top');
    assert.ok(checkedAtFirst < 120, `${checkedAtFirst} occurrences checked before any scrolling`);
    await longPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await longPage.waitForFunction(count => document.querySelectorAll('.lp-zh-island').length > count, firstScreen, { timeout: 8000 });
    assert.ok(seenItems.length > checkedAtFirst, 'scrolling asks about more');
    assert.ok(await islandCount(longPage) > 10, 'more than ten on a long page');
    await longPage.close();

    // A page in another language with no lang attribute.
    const spanish = await open('/spanish-no-lang');
    assert.equal(await islandCount(spanish), 0, 'browser language detection blocks Spanish pages');
    await spanish.close();

    // Page code in front of the text must not stand in for the page's language.
    const beforeScriptFirst = seenItems.length;
    const scriptFirst = await open('/script-first-spanish');
    assert.equal(await islandCount(scriptFirst), 0, 'English in a script does not make a Spanish page English');
    assert.equal(seenItems.length, beforeScriptFirst, 'nothing from the script-first page was sent');
    await scriptFirst.close();

    // Text that arrives after the page opened, as on an app-style site.
    const beforeLate = seenItems.length;
    const lateSpanish = await open('/late-spanish');
    await lateSpanish.waitForFunction(() => document.querySelectorAll('main p').length > 0, null, { timeout: 8000 });
    await lateSpanish.waitForTimeout(2500);
    assert.equal(await islandCount(lateSpanish), 0, 'late Spanish text gets no Chinese words');
    assert.equal(seenItems.length, beforeLate, 'nothing from the late Spanish page was sent');
    await lateSpanish.close();

    const lateEnglish = await open('/late-english');
    await lateEnglish.waitForFunction(() => document.querySelectorAll('.lp-zh-island').length > 0, null, { timeout: 8000 });
    await lateEnglish.close();

    // "book's" and "book-lover" stay in English.
    const glued = await open('/glued');
    assert.equal(await islandCount(glued), 1);
    assert.match(await glued.locator('p').first().innerText(), /^The book's cover/);
    await glued.close();

    // In-app navigation is a new page for the limits, with or without the old content.
    const inApp = await open('/in-app');
    const firstPage = await islandCount(inApp);
    assert.ok(firstPage > 0 && firstPage <= 10, `${firstPage} islands`);
    await inApp.evaluate(() => {
      history.pushState({}, '', '/in-app/two');
      document.querySelector('main').insertAdjacentHTML('beforeend', '<p>Added: she is tall today.</p>');
    });
    await inApp.waitForFunction(() => [...document.querySelectorAll('p')].at(-1).querySelector('.lp-zh-island'), null, { timeout: 8000 });
    await inApp.evaluate(() => {
      history.pushState({}, '', '/in-app/three');
      document.querySelector('main').innerHTML = '<p>New: I am happy.</p><p>New: it is good.</p><p>New: turn at the corner.</p>';
    });
    await inApp.waitForFunction(() => document.querySelectorAll('.lp-zh-island').length === 3, null, { timeout: 8000 });
    await inApp.close();

    const result = {
      passed: true, browser: 'Chromium', islands: islands.map(island => `${island.paragraph}:${island.term}`),
      validationRequests, glyphFonts, japaneseAndSimplifiedGlyphsDiffer: japaneseDiffers, attemptsOnLongRejectedPage: attempts,
      screenshots: fs.readdirSync(outputPath).filter(name => name.endsWith('.png')),
    };
    fs.writeFileSync(path.join(outputPath, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    removeExtensionCopy(extensionPath);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
