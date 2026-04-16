/* global browser */
const LEGACY_DEFAULTS = { apiBase: 'http://localhost:8000/api', frontendUrl: 'http://localhost:3000' };
const DEFAULTS = { apiBase: 'https://api.langsly.com/api', frontendUrl: 'https://langsly.com', syncInterval: 60, excludeSensitive: true };

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function resolveUrl(value, key) {
  const normalized = normalizeUrl(value);
  const normalizedLegacy = normalizeUrl(LEGACY_DEFAULTS[key]);
  return !normalized || normalized === normalizedLegacy ? DEFAULTS[key] : normalized;
}

const apiBaseInput = document.getElementById('api-base');
const frontendUrlInput = document.getElementById('frontend-url');
const syncIntervalSlider = document.getElementById('sync-interval');
const syncIntervalLabel = document.getElementById('sync-interval-label');
const excludeSensitiveToggle = document.getElementById('exclude-sensitive');
const resetBtn = document.getElementById('reset-urls');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

// ─── Load current settings ──────────────────
async function loadSettings() {
  const { apiBase, frontendUrl, syncInterval, excludeSensitive } = await browser.storage.local.get([
    'apiBase', 'frontendUrl', 'syncInterval', 'excludeSensitive',
  ]);
  apiBaseInput.value = resolveUrl(apiBase, 'apiBase');
  frontendUrlInput.value = resolveUrl(frontendUrl, 'frontendUrl');
  syncIntervalSlider.value = syncInterval || DEFAULTS.syncInterval;
  syncIntervalLabel.textContent = `${syncInterval || DEFAULTS.syncInterval} min`;
  excludeSensitiveToggle.checked = excludeSensitive !== undefined ? excludeSensitive : DEFAULTS.excludeSensitive;
}

// ─── Sync interval slider ────────────────────
syncIntervalSlider.addEventListener('input', () => {
  syncIntervalLabel.textContent = `${syncIntervalSlider.value} min`;
});

// ─── Reset to defaults ──────────────────────
resetBtn.addEventListener('click', () => {
  apiBaseInput.value = DEFAULTS.apiBase;
  frontendUrlInput.value = DEFAULTS.frontendUrl;
  syncIntervalSlider.value = DEFAULTS.syncInterval;
  syncIntervalLabel.textContent = `${DEFAULTS.syncInterval} min`;
  excludeSensitiveToggle.checked = DEFAULTS.excludeSensitive;
});

// ─── Save ────────────────────────────────────
saveBtn.addEventListener('click', async () => {
  const settings = {
    apiBase: apiBaseInput.value.trim(),
    frontendUrl: frontendUrlInput.value.trim(),
    syncInterval: parseInt(syncIntervalSlider.value, 10),
    excludeSensitive: excludeSensitiveToggle.checked,
  };

  await browser.storage.local.set(settings);

  // Update service worker alarm interval
  await browser.runtime.sendMessage({
    type: 'UPDATE_CONFIG',
    syncInterval: settings.syncInterval,
  });

  saveStatus.classList.remove('hidden');
  setTimeout(() => saveStatus.classList.add('hidden'), 2000);
});

loadSettings();
