/* global browser */
const DEFAULTS = { syncInterval: 60, extensionSourceLanguage: 'en', hanziWritingPracticeEnabled: true, zhPinyinMode: 'auto' };
const PINYIN_MODES = ['auto', 'always', 'popup'];
const LEGACY_FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_FRONTEND_URL = 'https://langsly.com';

function t(key, substitutions, fallback) {
  if (window.LangslyI18n) return window.LangslyI18n.t(key, substitutions, fallback);
  if (fallback === undefined && typeof substitutions === 'string') return substitutions;
  return fallback || key;
}

function formatMinutes(value) {
  return t('minuteLabel', [value], `${value} min`);
}

function resolveFrontendUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  return !normalized || normalized === LEGACY_FRONTEND_URL ? DEFAULT_FRONTEND_URL : normalized;
}

const syncIntervalSlider = document.getElementById('sync-interval');
const syncIntervalLabel = document.getElementById('sync-interval-label');
const pageSourceLanguage = document.getElementById('page-source-language');
const writingPracticeEnabled = document.getElementById('writing-practice-enabled');
const zhPinyinModeSelect = document.getElementById('zh-pinyin-mode');
const resetPreferencesBtn = document.getElementById('reset-preferences');
const saveStatus = document.getElementById('save-status');
const accountStatus = document.getElementById('account-status');
const accountEmail = document.getElementById('account-email');
const accountConnect = document.getElementById('account-connect');
const accountLogout = document.getElementById('account-logout');
const planRow = document.getElementById('plan-row');
const planStatus = document.getElementById('plan-status');
const managePlan = document.getElementById('manage-plan');
const subscriptionRequired = document.getElementById('subscription-required');
const subscribeBtn = document.getElementById('subscribe-btn');
const subscriptionRecheck = document.getElementById('subscription-recheck');
const aboutVersion = document.getElementById('about-version');
let subscribeUrl = '';
let saveToastTimer = null;

function applyThemeTokens(tokens) {
  if (window.LangslyTheme) window.LangslyTheme.applyThemeTokensToDocument(document.documentElement, tokens);
}

function formatDate(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// One line that says what the account's Vocab Pass is doing.
function describePlan(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const end = plan.currentPeriodEnd ? formatDate(plan.currentPeriodEnd) : '';
  if (plan.source === 'admin' || plan.status === 'comp') return t('planComplimentary', 'Vocab Pass · complimentary');
  if (!plan.hasAccess) return t('planInactive', 'No active Vocab Pass');
  if (plan.status === 'trialing' && end) return t('planTrialUntil', [end], `Free trial · until ${end}`);
  if (end && plan.cancelAtPeriodEnd) return t('planEnds', [end], `Vocab Pass · ends ${end}`);
  if (end) return t('planRenews', [end], `Vocab Pass · renews ${end}`);
  return t('planActive', 'Vocab Pass · active');
}

async function renderAccountState() {
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
  applyThemeTokens(status && status.themeTokens);
  const isLoggedIn = Boolean(status && status.isLoggedIn);
  const { extensionDeviceAuthorization: pending } = await browser.storage.local.get('extensionDeviceAuthorization');
  const unfinished = pending && !['connected', 'cancelled'].includes(pending.status);
  const expired = unfinished && (pending.expiresAt <= Date.now() || pending.status === 'denied');
  accountStatus.textContent = isLoggedIn
    ? t('accountConnected', 'Connected to Langsly.')
    : t('accountNotConnected', 'Not connected to Langsly.');
  if (!isLoggedIn && unfinished) accountStatus.textContent = t('accountPending', 'Setup unfinished. Continue to sign in and approve.');
  accountEmail.textContent = isLoggedIn ? (status.accountEmail || '') : '';
  accountConnect.textContent = expired ? t('connectRestart', 'Restart connection') : unfinished ? t('connectContinue', 'Continue connection') : t('connectLangslyAccount', 'Sign in with Langsly');
  accountConnect.classList.toggle('hidden', isLoggedIn);
  accountLogout.classList.toggle('hidden', !isLoggedIn);
  subscribeUrl = (status && status.subscribeUrl) || '';
  subscriptionRequired.classList.toggle('hidden', !(isLoggedIn && status.subscriptionRequired));

  const planText = isLoggedIn ? describePlan(status.plan) : '';
  planRow.classList.toggle('hidden', !planText);
  planStatus.textContent = planText;
}

managePlan.addEventListener('click', async (event) => {
  event.preventDefault();
  const { frontendUrl } = await browser.storage.local.get('frontendUrl');
  browser.tabs.create({ url: `${resolveFrontendUrl(frontendUrl)}/vocab-pass` });
});

subscribeBtn.addEventListener('click', () => {
  if (subscribeUrl) browser.tabs.create({ url: subscribeUrl });
});

subscriptionRecheck.addEventListener('click', async () => {
  subscriptionRecheck.disabled = true;
  try {
    await browser.runtime.sendMessage({ type: 'SYNC_NOW' });
    await renderAccountState();
  } finally {
    subscriptionRecheck.disabled = false;
  }
});

function applyPreferenceValues({
  syncInterval = DEFAULTS.syncInterval,
  extensionSourceLanguage = DEFAULTS.extensionSourceLanguage,
  hanziWritingPracticeEnabled = DEFAULTS.hanziWritingPracticeEnabled,
  zhPinyinMode = DEFAULTS.zhPinyinMode,
}) {
  zhPinyinModeSelect.value = PINYIN_MODES.includes(zhPinyinMode) ? zhPinyinMode : DEFAULTS.zhPinyinMode;
  syncIntervalSlider.value = syncInterval;
  writingPracticeEnabled.checked = hanziWritingPracticeEnabled !== false;
  syncIntervalLabel.textContent = formatMinutes(syncInterval);
  const source = window.LangslySourceLanguage.resolve(extensionSourceLanguage);
  pageSourceLanguage.value = ['en', 'es', 'zh'].includes(source) ? source : DEFAULTS.extensionSourceLanguage;
}

async function loadSettings() {
  const { syncInterval, extensionSourceLanguage, hanziWritingPracticeEnabled, zhPinyinMode } = await browser.storage.local.get([
    'syncInterval',
    'extensionSourceLanguage',
    'hanziWritingPracticeEnabled',
    'zhPinyinMode',
  ]);

  applyPreferenceValues({
    syncInterval: syncInterval || DEFAULTS.syncInterval,
    extensionSourceLanguage: extensionSourceLanguage || DEFAULTS.extensionSourceLanguage,
    hanziWritingPracticeEnabled: hanziWritingPracticeEnabled !== false,
    zhPinyinMode: zhPinyinMode || DEFAULTS.zhPinyinMode,
  });
  await renderAccountState();
}

accountConnect.addEventListener('click', async () => {
  accountConnect.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ type: 'START_DEVICE_LOGIN' });
    if (!result?.success) throw new Error('connection_failed');
  } catch {
    accountStatus.textContent = t('accountConnectionFailed', 'Could not connect your Langsly account. Please try again.');
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

function showSaved() {
  saveStatus.classList.remove('hidden');
  clearTimeout(saveToastTimer);
  saveToastTimer = setTimeout(() => saveStatus.classList.add('hidden'), 1800);
}

// Settings save themselves the moment they change; there is no Save button.
async function persistPreferences() {
  const settings = {
    syncInterval: parseInt(syncIntervalSlider.value, 10),
    hanziWritingPracticeEnabled: writingPracticeEnabled.checked,
    zhPinyinMode: PINYIN_MODES.includes(zhPinyinModeSelect.value) ? zhPinyinModeSelect.value : DEFAULTS.zhPinyinMode,
  };

  await browser.storage.local.set(settings);

  await browser.runtime.sendMessage({
    type: 'UPDATE_CONFIG',
    syncInterval: settings.syncInterval,
  });
  const sourceResult = await browser.runtime.sendMessage({
    type: 'SET_SOURCE_LANGUAGE',
    sourceLanguage: pageSourceLanguage.value,
  });
  if (!sourceResult?.success) return;
  showSaved();
}

syncIntervalSlider.addEventListener('input', () => {
  syncIntervalLabel.textContent = formatMinutes(syncIntervalSlider.value);
});
syncIntervalSlider.addEventListener('change', () => void persistPreferences());
pageSourceLanguage.addEventListener('change', () => void persistPreferences());
zhPinyinModeSelect.addEventListener('change', () => void persistPreferences());
writingPracticeEnabled.addEventListener('change', () => void persistPreferences());

resetPreferencesBtn.addEventListener('click', () => {
  applyPreferenceValues(DEFAULTS);
  void persistPreferences();
});

if (aboutVersion) {
  const manifest = browser.runtime.getManifest ? browser.runtime.getManifest() : null;
  aboutVersion.textContent = manifest ? `Vocab Pass ${manifest.version}` : 'Vocab Pass';
}

loadSettings();

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.authToken || changes.extensionDeviceAuthorization || changes.subscriptionRequired || changes.vocabPassPlan)) void renderAccountState();
});

window.addEventListener('focus', () => void renderAccountState());
