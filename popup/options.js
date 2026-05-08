/* global browser */
const DEFAULTS = { syncInterval: 60, excludeSensitive: true };

function t(key, substitutions, fallback) {
  if (window.LangslyI18n) return window.LangslyI18n.t(key, substitutions, fallback);
  if (fallback === undefined && typeof substitutions === 'string') return substitutions;
  return fallback || key;
}

function formatMinutes(value) {
  return t('minuteLabel', [value], `${value} min`);
}

const syncIntervalSlider = document.getElementById('sync-interval');
const syncIntervalLabel = document.getElementById('sync-interval-label');
const excludeSensitiveToggle = document.getElementById('exclude-sensitive');
const resetPreferencesBtn = document.getElementById('reset-preferences');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

function applyPreferenceValues({
  syncInterval = DEFAULTS.syncInterval,
  excludeSensitive = DEFAULTS.excludeSensitive,
}) {
  syncIntervalSlider.value = syncInterval;
  syncIntervalLabel.textContent = formatMinutes(syncInterval);
  excludeSensitiveToggle.checked = excludeSensitive;
}

async function loadSettings() {
  const { syncInterval, excludeSensitive } = await browser.storage.local.get([
    'syncInterval',
    'excludeSensitive',
  ]);

  applyPreferenceValues({
    syncInterval: syncInterval || DEFAULTS.syncInterval,
    excludeSensitive: excludeSensitive !== undefined ? excludeSensitive : DEFAULTS.excludeSensitive,
  });
}

syncIntervalSlider.addEventListener('input', () => {
  syncIntervalLabel.textContent = formatMinutes(syncIntervalSlider.value);
});

resetPreferencesBtn.addEventListener('click', () => {
  applyPreferenceValues(DEFAULTS);
});

saveBtn.addEventListener('click', async () => {
  const settings = {
    syncInterval: parseInt(syncIntervalSlider.value, 10),
    excludeSensitive: excludeSensitiveToggle.checked,
  };

  await browser.storage.local.set(settings);

  await browser.runtime.sendMessage({
    type: 'UPDATE_CONFIG',
    syncInterval: settings.syncInterval,
  });

  saveStatus.classList.remove('hidden');
  setTimeout(() => saveStatus.classList.add('hidden'), 2000);
});

loadSettings();
