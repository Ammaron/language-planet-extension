import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const viewport = /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/;

test('every extension UI has the responsive Android viewport contract', async () => {
  for (const page of ['popup/popup.html', 'popup/onboarding.html', 'popup/options.html', 'popup/connect.html']) {
    assert.match(await read(page), viewport, page);
  }
});

test('Android action surfaces use safe areas, coarse-pointer responsiveness, and 44px controls', async () => {
  const popup = await read('popup/popup.css');
  const onboarding = await read('popup/onboarding.css');
  const options = await read('popup/options.css');
  const content = await read('content/content.css');
  assert.match(popup, /env\(safe-area-inset-top\)/);
  assert.match(popup, /@media \(max-width: 480px\), \(pointer: coarse\)/);
  assert.match(popup, /\.switch[\s\S]*?height:\s*44px/);
  assert.match(popup, /\.link-btn[\s\S]*?min-height:\s*44px/);
  assert.match(popup, /\.diff-btn[\s\S]*?min-height:\s*44px/);
  assert.match(popup, /\.theme-select[\s\S]*?min-height:\s*44px/);
  assert.match(popup, /padding-inline-start:\s*max\(10px, env\(safe-area-inset-left\)\)/);
  assert.match(popup, /padding-inline-end:\s*max\(10px, env\(safe-area-inset-right\)\)/);
  assert.match(onboarding, /min-height:\s*44px/);
  assert.match(options, /\.slider-row input\[type="range"\][\s\S]*?min-height:\s*44px/);
  assert.match(content, /@media \(pointer: coarse\)[\s\S]*?min-height:\s*44px/);
  assert.match(content, /max-height:\s*calc\(100dvh - 20px\)/);
});

test('in-page popup flips above low anchors and clamps both viewport axes', async () => {
  const popupRuntime = await read('content/popup.js');
  assert.match(popupRuntime, /rect\.top - popupRect\.height - gap/);
  assert.match(popupRuntime, /below \+ popupRect\.height <= window\.innerHeight - margin/);
  assert.match(popupRuntime, /window\.innerWidth - popupRect\.width - margin/);
});

test('closed-shadow stylesheet is the only web-accessible runtime resource', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  assert.deepEqual(manifest.web_accessible_resources, [{
    resources: ['content/content.css'],
    matches: ['<all_urls>'],
  }]);
});
