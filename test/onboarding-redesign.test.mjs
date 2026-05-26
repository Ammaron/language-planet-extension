import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readText(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('onboarding feature copy is not styled as the badge', async () => {
  const html = await readText('popup/onboarding.html');
  const css = await readText('popup/onboarding.css');

  assert.match(html, /class="feature-badge"/);
  assert.match(html, /class="feature-copy"/);
  assert.doesNotMatch(css, /\.feature-row\s+span\s*\{/);
});

test('onboarding defaults use the website warm theme instead of blue extension fallback', async () => {
  const css = await readText('popup/onboarding.css');
  const themeUtils = await readText('background/theme-utils.js');

  assert.match(css, /--lp-page-bg:\s*#F7F6F2/i);
  assert.match(css, /--lp-button-primary-bg:\s*#B73A48/i);
  assert.doesNotMatch(css, /#eef4ff/i);
  assert.doesNotMatch(css, /#2563eb/i);
  assert.match(themeUtils, /'color-page-bg': '#F7F6F2'/);
  assert.match(themeUtils, /'color-button-primary-bg': '#B73A48'/);
});

test('onboarding uses a frontend-like setup shell with stable unclipped panels', async () => {
  const html = await readText('popup/onboarding.html');
  const css = await readText('popup/onboarding.css');

  assert.match(html, /class="setup-shell"/);
  assert.match(css, /\.step\s*\{[^}]*overflow:\s*visible/s);
  assert.match(css, /\.feature-copy\s*\{[^}]*flex:\s*1/s);
  assert.match(css, /font-family:\s*var\(--lp-font-body\)/);
});
