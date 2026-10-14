/* global browser, LangslyHosts */
const loginView = document.getElementById('login-view');
const settingsView = document.getElementById('settings-view');
const loginError = document.getElementById('login-error');
const accountConnectBtn = document.getElementById('account-connect-btn');
const syncBtn = document.getElementById('sync-btn');
const wordCountEl = document.getElementById('word-count');
const lastSyncEl = document.getElementById('last-sync');
const sourceLanguageEl = document.getElementById('source-language');
const matchableWordCountEl = document.getElementById('matchable-word-count');
const currentDomainEl = document.getElementById('current-domain');
const siteHelpEl = document.getElementById('site-help');
const siteSection = document.querySelector('.pp-site');
const siteToggle = document.getElementById('site-toggle');
const pageStateEl = document.getElementById('page-state');
const pageWordCountEl = document.getElementById('page-word-count');
const pageWordLabelEl = document.getElementById('page-word-label');
const openVocabpass = document.getElementById('open-vocabpass');
const openSettings = document.getElementById('open-settings');
const diffBtns = document.querySelectorAll('.diff-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusBanner = document.getElementById('status-banner');
const themeRow = document.getElementById('theme-row');
const themeSelect = document.getElementById('theme-select');
const themeStatus = document.getElementById('theme-status');
const subscriptionRequiredEl = document.getElementById('subscription-required');
const subscribeBtn = document.getElementById('subscribe-btn');
const subscriptionRecheck = document.getElementById('subscription-recheck');
const learnMoreLink = document.getElementById('login-learn-more');
let subscribeUrl = '';
const LEGACY_FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_FRONTEND_URL = 'https://langsly.com';

// What the content script reports for the active tab, if it is reachable.
let pageState = { reachable: false, lifecycleState: null, wordCount: 0 };
let siteEnabled = true;
let latestStatus = null;

function t(key, substitutions, fallback) {
  if (window.LangslyI18n) return window.LangslyI18n.t(key, substitutions, fallback);
  if (fallback === undefined && typeof substitutions === 'string') return substitutions;
  return fallback || key;
}

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function resolveFrontendUrl(value) {
  const normalized = normalizeUrl(value);
  return !normalized || normalized === normalizeUrl(LEGACY_FRONTEND_URL)
    ? DEFAULT_FRONTEND_URL
    : normalized;
}

async function frontendUrl() {
  const { frontendUrl: stored } = await browser.storage.local.get('frontendUrl');
  return resolveFrontendUrl(stored);
}

function applyThemeTokens(tokens) {
  if (window.LangslyTheme) {
    window.LangslyTheme.applyThemeTokensToDocument(document.documentElement, tokens);
  }
}

async function applyStoredTheme() {
  const { themeTokens } = await browser.storage.local.get('themeTokens');
  applyThemeTokens(themeTokens);
}

function getAvailableThemes(themePacks) {
  return Array.isArray(themePacks)
    ? themePacks.filter((theme) => theme && (theme.is_free || theme.is_unlocked))
    : [];
}

function updateThemeControls(status) {
  if (!themeRow || !themeSelect) return;

  const availableThemes = getAvailableThemes(status.themePacks);
  if (!availableThemes.length) {
    themeRow.classList.add('hidden');
    return;
  }

  themeSelect.innerHTML = '';
  availableThemes.forEach((theme) => {
    const option = document.createElement('option');
    option.value = theme.slug;
    option.textContent = theme.name || theme.slug;
    themeSelect.appendChild(option);
  });

  themeSelect.value = status.activeThemeSlug || 'system';
  themeSelect.dataset.previousValue = themeSelect.value;
  themeRow.classList.remove('hidden');
  if (themeStatus) {
    themeStatus.textContent = status.themeSyncStatus === 'failed'
      ? t('themeUsingLastSynced', 'Using last synced theme')
      : t('themeSynced', 'Synced from dashboard');
  }
}

async function syncAndRenderThemes(status) {
  applyThemeTokens(status && status.themeTokens);
  updateThemeControls(status || {});

  try {
    const themeStatusResponse = await browser.runtime.sendMessage({ type: 'SYNC_THEMES' });
    if (themeStatusResponse && themeStatusResponse.success !== false) {
      applyThemeTokens(themeStatusResponse.themeTokens);
      updateThemeControls(themeStatusResponse);
    }
  } catch {
    // Theme sync is cosmetic; keep the popup usable with stored/default tokens.
  }
}

// ─── View Management ─────────────────────────
function showLogin() {
  loginView.classList.remove('hidden');
  settingsView.classList.add('hidden');
  void browser.storage.local.get('extensionDeviceAuthorization').then(({ extensionDeviceAuthorization: pending }) => {
    const unfinished = pending && !['connected', 'cancelled'].includes(pending.status);
    accountConnectBtn.textContent = unfinished
      ? (pending.expiresAt <= Date.now() || pending.status === 'denied' ? t('connectRestart', 'Restart connection') : t('connectContinue', 'Continue connection'))
      : t('connectLangslyAccount', 'Sign in with Langsly');
  });
}

function showSettings() {
  loginView.classList.add('hidden');
  settingsView.classList.remove('hidden');
}

async function renderLoggedInState() {
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
  showSettings();
  updateStatus(status);
  syncAndRenderThemes(status);
  await loadActiveTab();
}

function setLoginControlsDisabled(disabled) {
  if (accountConnectBtn) accountConnectBtn.disabled = disabled;
}

// ─── Active tab ──────────────────────────────
async function loadActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  pageState = { reachable: false, lifecycleState: null, wordCount: 0 };
  let domain = '';
  if (tab && tab.url) {
    try {
      const url = new URL(tab.url);
      if (['http:', 'https:'].includes(url.protocol)) domain = url.hostname;
    } catch {
      domain = '';
    }
  }
  currentDomainEl.textContent = domain || t('thisPage', 'This page');
  siteToggle.disabled = !domain;

  if (domain) {
    // Whitelisted here means "paused on this site".
    const response = await browser.runtime.sendMessage({ type: 'GET_WHITELIST', refresh: true }).catch(() => null);
    if (response && Array.isArray(response.domains) && response.known !== false) {
      // Same rule as the content script: the entry itself or one of its subdomains.
      siteEnabled = !LangslyHosts.matchesAnyDomain(domain, response.domains);
      siteToggle.checked = siteEnabled;
    }
    if (tab.id) {
      try {
        const reply = await browser.tabs.sendMessage(tab.id, { type: 'GET_PAGE_STATE' });
        if (reply && typeof reply === 'object') {
          pageState = { reachable: true, lifecycleState: reply.lifecycleState || null, wordCount: Number(reply.wordCount) || 0 };
        }
      } catch {
        // No content script on this page (store pages, PDFs, browser UI).
      }
    }
  }
  renderPageState();
}

function formatRelativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '–';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return t('justNow', 'just now');
  if (minutes < 60) return t('minutesAgo', [String(minutes)], `${minutes} min ago`);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('hoursAgo', [String(hours)], `${hours} h ago`);
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// One sentence that says what Vocab Pass is doing on this tab right now.
function renderPageState() {
  const status = latestStatus || {};
  const domainKnown = !siteToggle.disabled;
  let dot = 'on';
  let label = t('pageStateOn', 'On');
  let help = t('siteHelpOn', 'Words from your Langsly course appear here while you read.');
  let countVisible = true;

  siteSection.classList.remove('is-off', 'is-protected', 'is-unavailable');

  if (status.subscriptionRequired) {
    dot = 'off';
    label = t('pageStateSubscription', 'Pass ended');
  } else if (!domainKnown || (!pageState.reachable && !['offline', 'failed'].includes(status.syncStatus))) {
    dot = '';
    label = t('pageStateUnavailable', 'Unavailable');
    help = t('siteHelpUnavailable', 'Vocab Pass works on regular web pages, not browser or store pages.');
    countVisible = false;
    siteSection.classList.add('is-unavailable');
  } else if (!siteEnabled || pageState.lifecycleState === 'disabled') {
    dot = '';
    label = t('pageStatePaused', 'Paused here');
    help = t('siteHelpOff', 'Turn it back on to highlight words on this site.');
    siteSection.classList.add('is-off');
  } else if (pageState.lifecycleState === 'excluded') {
    dot = 'warn';
    label = t('pageStateProtected', 'Protected page');
    help = t('siteHelpProtected', 'Sign-in, banking and similar pages are never read.');
    siteSection.classList.add('is-protected');
  } else if (status.syncStatus === 'offline') {
    dot = 'warn';
    label = t('pageStateOffline', 'Offline');
  } else if (['failed', 'unsupported_locale', 'source_unavailable'].includes(status.syncStatus)) {
    dot = 'off';
    label = t('statusSyncFailed', 'Sync failed');
  }

  statusIndicator.className = `lp-dot ${dot}`.trim();
  statusIndicator.title = label;
  pageStateEl.textContent = label;
  siteHelpEl.textContent = help;

  if (countVisible && pageState.reachable) {
    const n = pageState.wordCount;
    pageWordCountEl.textContent = String(n);
    pageWordLabelEl.textContent = n === 1 ? t('wordOnThisPage', 'word on this page') : t('wordsOnThisPage', 'words on this page');
  } else {
    pageWordCountEl.textContent = '–';
    pageWordLabelEl.textContent = t('wordsOnThisPage', 'words on this page');
  }
}

// ─── Init ────────────────────────────────────
async function init() {
  await applyStoredTheme();
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
  applyThemeTokens(status.themeTokens);

  if (!status.isLoggedIn) {
    showLogin();
    return;
  }

  showSettings();
  updateStatus(status);
  syncAndRenderThemes(status);
  await loadActiveTab();
}

function updateStatus(status) {
  latestStatus = status;
  wordCountEl.textContent = status.wordCount || 0;
  const matchableWordCount = Number.isFinite(status.matchableWordCount)
    ? status.matchableWordCount
    : 0;
  if (sourceLanguageEl) {
    sourceLanguageEl.textContent = String(status.pageTextLanguage || status.extensionSourceLanguage || 'en').toUpperCase();
  }
  if (matchableWordCountEl) {
    matchableWordCountEl.textContent = matchableWordCount;
  }
  if (statusBanner) {
    statusBanner.classList.add('hidden');
    statusBanner.textContent = '';
  }

  if (status.lastSync) {
    lastSyncEl.textContent = formatRelativeTime(status.lastSync);

    // Check for stale data (>24h)
    const hoursSinceSync = (Date.now() - new Date(status.lastSync).getTime()) / (1000 * 60 * 60);
    if (hoursSinceSync > 24 && statusBanner) {
      statusBanner.textContent = t('dataStaleWarning', 'Your words were last synced over a day ago.');
      statusBanner.className = 'lp-note';
      statusBanner.classList.remove('hidden');
    }
  } else {
    lastSyncEl.textContent = '–';
  }

  if ((status.wordCount || 0) > 0 && matchableWordCount === 0 && statusBanner) {
    statusBanner.textContent = t('noMatchableWordsWarning', 'Words synced, but none have page text triggers for the selected source language.');
    statusBanner.className = 'lp-note';
    statusBanner.classList.remove('hidden');
  }
  if (statusBanner && ['unsupported_locale', 'source_unavailable'].includes(status.syncStatus)) {
    statusBanner.textContent = status.syncStatus === 'unsupported_locale'
      ? t('sourceLanguageUnsupported', 'This page language is not supported. Choose a supported language in Langsly.')
      : t('sourceLanguageUnavailable', 'Reviewed vocabulary is not yet available for this page language and course.');
    statusBanner.className = 'lp-note';
    statusBanner.classList.remove('hidden');
  }
  if (status.syncStatus === 'offline' && statusBanner) {
    statusBanner.textContent = t('offlineCachedVocabulary', 'Offline. Using the words saved on this device.');
    statusBanner.className = 'lp-note';
    statusBanner.classList.remove('hidden');
  }

  // Vocab Pass needs an active subscription (sync answered 402).
  subscribeUrl = status.subscribeUrl || '';
  if (subscriptionRequiredEl) {
    subscriptionRequiredEl.classList.toggle('hidden', !status.subscriptionRequired);
    settingsView.classList.toggle('pp-paywalled', Boolean(status.subscriptionRequired));
  }

  // Update difficulty buttons
  diffBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.level === (status.difficulty || 'normal'));
  });

  renderPageState();
}

// ─── Login ───────────────────────────────────
if (accountConnectBtn) {
  accountConnectBtn.addEventListener('click', async () => {
    loginError.classList.add('hidden');
    setLoginControlsDisabled(true);
    accountConnectBtn.textContent = t('deviceLoginOpening', 'Opening secure connection...');

    const response = await browser.runtime.sendMessage({ type: 'START_DEVICE_LOGIN' }).catch(() => ({ success: false }));

    if (response.success) {
      window.close();
    } else {
      loginError.textContent = response.error || t('accountConnectionFailed', 'Could not connect your Langsly account.');
      loginError.classList.remove('hidden');
    }

    setLoginControlsDisabled(false);
    accountConnectBtn.textContent = t('connectLangslyAccount', 'Sign in with Langsly');
  });
}

if (learnMoreLink) {
  learnMoreLink.addEventListener('click', async (e) => {
    e.preventDefault();
    browser.tabs.create({ url: `${await frontendUrl()}/vocab-pass` });
  });
}

// ─── Sync ────────────────────────────────────
syncBtn.addEventListener('click', async () => {
  syncBtn.textContent = t('syncing', 'Syncing...');
  syncBtn.disabled = true;

  // A fast sync would otherwise flash by unseen and look like a dead button.
  const minimumFeedback = new Promise(resolve => setTimeout(resolve, 700));
  await browser.runtime.sendMessage({ type: 'SYNC_NOW' }).catch(() => null);
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
  updateStatus(status);
  syncAndRenderThemes(status);
  await loadActiveTab();
  await minimumFeedback;

  const failed = ['failed', 'offline'].includes(status.syncStatus);
  if (failed) {
    syncBtn.textContent = t('statusSyncFailed', 'Sync failed');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  syncBtn.textContent = t('syncNow', 'Sync now');
  syncBtn.disabled = false;
});

if (subscriptionRecheck) {
  subscriptionRecheck.addEventListener('click', async () => {
    subscriptionRecheck.disabled = true;
    subscriptionRecheck.textContent = t('syncing', 'Syncing...');
    try {
      await browser.runtime.sendMessage({ type: 'SYNC_NOW' }).catch(() => null);
      const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
      updateStatus(status);
      await loadActiveTab();
    } finally {
      subscriptionRecheck.textContent = t('syncNow', 'Sync now');
      subscriptionRecheck.disabled = false;
    }
  });
}

if (themeSelect) {
  themeSelect.addEventListener('change', async () => {
    const previousValue = themeSelect.dataset.previousValue || 'system';
    const nextValue = themeSelect.value;
    themeSelect.disabled = true;
    if (themeStatus) themeStatus.textContent = t('themeApplying', 'Applying...');

    try {
      const response = await browser.runtime.sendMessage({ type: 'APPLY_THEME', themeSlug: nextValue });
      if (!response || response.success === false) {
        themeSelect.value = previousValue;
        if (themeStatus) themeStatus.textContent = t('themeCouldNotApply', 'Could not apply theme');
        return;
      }

      applyThemeTokens(response.themeTokens);
      updateThemeControls(response);
      themeSelect.dataset.previousValue = response.activeThemeSlug || nextValue;
    } catch {
      themeSelect.value = previousValue;
      if (themeStatus) themeStatus.textContent = t('themeCouldNotApply', 'Could not apply theme');
    } finally {
      themeSelect.disabled = false;
    }
  });
}

// ─── Difficulty ──────────────────────────────
diffBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    const level = btn.dataset.level;
    diffBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    await browser.runtime.sendMessage({ type: 'SET_DIFFICULTY', difficulty: level });
  });
});

// ─── Site Toggle (whitelist) ─────────────────
siteToggle.addEventListener('change', async () => {
  const domain = currentDomainEl.textContent;
  if (!domain || siteToggle.disabled) return;
  siteToggle.disabled = true;
  siteEnabled = siteToggle.checked;
  renderPageState();

  try {
    const result = await browser.runtime.sendMessage({ type: 'TOGGLE_WHITELIST', domain, add: !siteToggle.checked })
      .catch(() => null);
    if (!result || !result.success) {
      // The server did not take the change: show the state that is really in effect.
      if (result && typeof result.paused === 'boolean') siteToggle.checked = !result.paused;
      else siteToggle.checked = !siteToggle.checked;
      siteEnabled = siteToggle.checked;
      renderPageState();
      return;
    }
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      try {
        await browser.tabs.sendMessage(tab.id, { type: 'SITE_ACCESS_CHANGED', enabled: siteToggle.checked });
      } catch {
        await browser.tabs.reload(tab.id);
      }
    }
  } finally {
    siteToggle.disabled = false;
    // Give the page a moment to re-scan before counting its words again.
    setTimeout(() => { void loadActiveTab(); }, 900);
  }
});

// ─── Subscribe ───────────────────────────────
if (subscribeBtn) {
  subscribeBtn.addEventListener('click', async () => {
    const url = subscribeUrl || `${await frontendUrl()}/vocab-pass/subscribe`;
    browser.tabs.create({ url });
  });
}

// ─── Open Dashboard ──────────────────────────
openVocabpass.addEventListener('click', async (e) => {
  e.preventDefault();
  browser.tabs.create({ url: `${await frontendUrl()}/vocab-pass` });
});

if (openSettings) {
  openSettings.addEventListener('click', () => browser.runtime.openOptionsPage());
}

document.getElementById('login-open-settings').addEventListener('click', () => browser.runtime.openOptionsPage());
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.authToken?.newValue) void renderLoggedInState();
  else if (changes.subscriptionRequired) void browser.runtime.sendMessage({ type: 'GET_STATUS' }).then(status => { if (status.isLoggedIn) updateStatus(status); });
  else if (changes.authToken || changes.extensionDeviceAuthorization) void browser.runtime.sendMessage({ type: 'GET_STATUS' }).then(status => { if (!status.isLoggedIn) showLogin(); });
});

// ─── Start ───────────────────────────────────
init();
