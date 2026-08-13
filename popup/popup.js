/* global browser */
const loginView = document.getElementById('login-view');
const settingsView = document.getElementById('settings-view');
const loginError = document.getElementById('login-error');
const accountConnectBtn = document.getElementById('account-connect-btn');
const logoutBtn = document.getElementById('logout-btn');
const syncBtn = document.getElementById('sync-btn');
const wordCountEl = document.getElementById('word-count');
const lastSyncEl = document.getElementById('last-sync');
const sourceLanguageEl = document.getElementById('source-language');
const matchableWordCountEl = document.getElementById('matchable-word-count');
const currentDomainEl = document.getElementById('current-domain');
const siteToggle = document.getElementById('site-toggle');
const openVocabpass = document.getElementById('open-vocabpass');
const openSettings = document.getElementById('open-settings');
const diffBtns = document.querySelectorAll('.diff-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusBanner = document.getElementById('status-banner');
const themeRow = document.getElementById('theme-row');
const themeSelect = document.getElementById('theme-select');
const themeStatus = document.getElementById('theme-status');
const LEGACY_FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_FRONTEND_URL = 'https://langsly.com';

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
}

function setLoginControlsDisabled(disabled) {
  if (accountConnectBtn) accountConnectBtn.disabled = disabled;
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

  // Get current tab domain
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.url) {
    try {
      const domain = new URL(tab.url).hostname;
      currentDomainEl.textContent = domain;

      // Check if domain is whitelisted (whitelisted = extension disabled there)
      const response = await browser.runtime.sendMessage({ type: 'GET_WHITELIST' });
      if (response && response.domains) {
        const isWhitelisted = response.domains.some(d => domain.includes(d) || d.includes(domain));
        siteToggle.checked = !isWhitelisted;
      }
    } catch {
      currentDomainEl.textContent = t('notAvailable', 'N/A');
    }
  }
}

function updateStatus(status) {
  wordCountEl.textContent = status.wordCount || 0;
  const matchableWordCount = Number.isFinite(status.matchableWordCount)
    ? status.matchableWordCount
    : 0;
  if (sourceLanguageEl) {
    sourceLanguageEl.textContent = String(status.extensionSourceLanguage || 'en').toUpperCase();
  }
  if (matchableWordCountEl) {
    matchableWordCountEl.textContent = matchableWordCount;
  }
  if (statusBanner) {
    statusBanner.classList.add('hidden');
    statusBanner.textContent = '';
  }

  if (status.lastSync) {
    const syncDate = new Date(status.lastSync);
    lastSyncEl.textContent = syncDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Check for stale data (>24h)
    const hoursSinceSync = (Date.now() - syncDate.getTime()) / (1000 * 60 * 60);
    if (hoursSinceSync > 24 && statusBanner) {
      statusBanner.textContent = t('dataStaleWarning', 'Data may be stale - last synced over 24h ago');
      statusBanner.className = 'status-banner warning';
      statusBanner.classList.remove('hidden');
    }
  } else {
    lastSyncEl.textContent = '\u2014';
  }

  if ((status.wordCount || 0) > 0 && matchableWordCount === 0 && statusBanner) {
    statusBanner.textContent = t('noMatchableWordsWarning', 'Words synced, but none have page text triggers for the selected source language.');
    statusBanner.className = 'status-banner warning';
    statusBanner.classList.remove('hidden');
  }

  // Update difficulty buttons
  diffBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.level === (status.difficulty || 'normal'));
  });

  // Connection health indicator
  if (statusIndicator) {
    if (status.syncStatus === 'success') {
      statusIndicator.className = 'status-dot connected';
      statusIndicator.title = t('statusConnected', 'Connected');
    } else if (status.syncStatus === 'offline') {
      statusIndicator.className = 'status-dot offline';
      statusIndicator.title = t('statusOffline', 'Offline');
      if (statusBanner) {
        statusBanner.textContent = t('offlineCachedVocabulary', 'Offline - using cached vocabulary');
        statusBanner.className = 'status-banner offline';
        statusBanner.classList.remove('hidden');
      }
    } else if (status.syncStatus === 'failed') {
      statusIndicator.className = 'status-dot error';
      statusIndicator.title = t('statusSyncFailed', 'Sync failed');
    } else {
      statusIndicator.className = 'status-dot unknown';
      statusIndicator.title = t('statusUnknown', 'Unknown');
    }
  }
}

// ─── Login ───────────────────────────────────
if (accountConnectBtn) {
  accountConnectBtn.addEventListener('click', async () => {
    loginError.classList.add('hidden');
    setLoginControlsDisabled(true);
    accountConnectBtn.textContent = t('deviceLoginOpening', 'Opening secure connection...');

    const response = await browser.runtime.sendMessage({ type: 'START_DEVICE_LOGIN' });

    if (response.success) {
      window.close();
    } else {
      loginError.textContent = response.error || t('accountConnectionFailed', 'Could not connect your Langsly account.');
      loginError.classList.remove('hidden');
    }

    setLoginControlsDisabled(false);
    accountConnectBtn.textContent = t('connectLangslyAccount', 'Connect Langsly account');
  });
}

// ─── Logout ──────────────────────────────────
logoutBtn.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'LOGOUT' });
  showLogin();
});

// ─── Sync ────────────────────────────────────
syncBtn.addEventListener('click', async () => {
  syncBtn.textContent = t('syncing', 'Syncing...');
  syncBtn.disabled = true;

  await browser.runtime.sendMessage({ type: 'SYNC_NOW' });
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
  updateStatus(status);
  syncAndRenderThemes(status);

  syncBtn.textContent = t('syncNow', 'Sync now');
  syncBtn.disabled = false;
});

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
  if (!domain || domain === t('notAvailable', 'N/A')) return;
  siteToggle.disabled = true;

  try {
    await browser.runtime.sendMessage({ type: 'TOGGLE_WHITELIST', domain, add: !siteToggle.checked });
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
  }
});

// ─── Open Dashboard ──────────────────────────
openVocabpass.addEventListener('click', async (e) => {
  e.preventDefault();
  const { frontendUrl } = await browser.storage.local.get('frontendUrl');
  const url = resolveFrontendUrl(frontendUrl);
  browser.tabs.create({ url: `${url}/vocab-pass` });
});

if (openSettings) {
  openSettings.addEventListener('click', () => browser.runtime.openOptionsPage());
}

// ─── Start ───────────────────────────────────
init();
