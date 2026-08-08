/* global browser */
const DEFAULTS = { syncInterval: 60 };

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
const resetPreferencesBtn = document.getElementById('reset-preferences');
const saveBtn = document.getElementById('save-btn');
const saveStatus = document.getElementById('save-status');

function applyPreferenceValues({
  syncInterval = DEFAULTS.syncInterval,
}) {
  syncIntervalSlider.value = syncInterval;
  syncIntervalLabel.textContent = formatMinutes(syncInterval);
}

async function loadSettings() {
  const { syncInterval } = await browser.storage.local.get([
    'syncInterval',
  ]);

  applyPreferenceValues({
    syncInterval: syncInterval || DEFAULTS.syncInterval,
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
