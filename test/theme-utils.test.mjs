import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../background/theme-utils.js', import.meta.url), 'utf8');
const sandbox = { globalThis: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'theme-utils.js' });

const themeUtils = sandbox.LangslyTheme;

test('normalizes missing theme tokens with defaults', () => {
  const tokens = themeUtils.normalizeThemeTokens({
    'color-page-bg': '#101827',
    'color-accent': '#06b6d4',
  });

  assert.equal(tokens['color-page-bg'], '#101827');
  assert.equal(tokens['color-accent'], '#06b6d4');
  assert.equal(tokens['color-surface'], '#ffffff');
  assert.equal(tokens['color-text-primary'], '#0f172a');
});

test('resolves active theme from current user and available packs', () => {
  const result = themeUtils.resolveActiveTheme({
    currentUser: { active_theme_slug: 'midnight' },
    themePacks: [
      { slug: 'system', name: 'System', tokens: {} },
      { slug: 'midnight', name: 'Midnight', tokens: { 'color-page-bg': '#0b1220' } },
    ],
  });

  assert.equal(result.slug, 'midnight');
  assert.equal(result.name, 'Midnight');
  assert.equal(result.tokens['color-page-bg'], '#0b1220');
});

test('falls back to system when active theme is unavailable', () => {
  const result = themeUtils.resolveActiveTheme({
    currentUser: { active_theme_slug: 'missing' },
    themePacks: [
      { slug: 'light', name: 'Light', tokens: { 'color-page-bg': '#f0f4ff' } },
    ],
  });

  assert.equal(result.slug, 'system');
  assert.equal(result.name, 'System');
  assert.equal(result.tokens['color-page-bg'], '#eef4ff');
});

test('maps normalized tokens to local extension CSS variables', () => {
  const cssVars = themeUtils.toCssVariables({
    'color-page-bg': '#111827',
    'color-surface': '#1f2937',
    'color-surface-elevated': '#334155',
    'color-text-primary': '#f8fafc',
    'color-text-secondary': '#cbd5e1',
    'color-text-muted': '#94a3b8',
    'color-border': '#475569',
    'color-border-strong': '#64748b',
    'color-accent': '#22d3ee',
    'color-accent-hover': '#06b6d4',
    'color-accent-text': '#082f49',
    'color-success': '#34d399',
    'color-warning': '#fbbf24',
    'color-danger': '#f87171',
    'color-header-bg': '#0f172a',
    'color-sidebar-bg': '#111827',
    'color-sidebar-text': '#e2e8f0',
    'color-button-primary-bg': '#22d3ee',
    'color-button-primary-text': '#082f49',
  });

  assert.equal(cssVars['--lp-page-bg'], '#111827');
  assert.equal(cssVars['--lp-surface'], '#1f2937');
  assert.equal(cssVars['--lp-accent'], '#22d3ee');
  assert.equal(cssVars['--lp-button-primary-text'], '#082f49');
});
