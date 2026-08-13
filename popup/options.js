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
const accountStatus = document.getElementById('account-status');
const accountConnect = document.getElementById('account-connect');
const accountLogout = document.getElementById('account-logout');

async function renderAccountState() {
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
  const isLoggedIn = Boolean(status && status.isLoggedIn);
  accountStatus.textContent = isLoggedIn
    ? t('accountConnected', 'Connected to Langsly.')
    : t('accountNotConnected', 'Not connected to Langsly.');
  accountConnect.classList.toggle('hidden', isLoggedIn);
  accountLogout.classList.toggle('hidden', !isLoggedIn);
}

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
  await renderAccountState();
}

accountConnect.addEventListener('click', async () => {
  accountConnect.disabled = true;
  try {
    await browser.runtime.sendMessage({ type: 'START_DEVICE_LOGIN' });
  } finally {
    accountConnect.disabled = false;
  }
});

accountLogout.addEventListener('click', async () => {
  accountLogout.disabled = true;
  try {
    await browser.runtime.sendMessage({ type: 'LOGOUT' });
    await renderAccountState();
  } finally {
    accountLogout.disabled = false;
  }
});

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

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.authToken) void renderAccountState();
});
