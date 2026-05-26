/* global browser */
try {
  if (typeof importScripts === 'function') {
    importScripts('../vendor/browser-polyfill.min.js');
  }
} catch {
  // Polyfill already available (Firefox background scripts load it via manifest)
}

if (typeof importScripts === 'function') {
  if (!globalThis.LangslyI18n) {
    importScripts('../shared/i18n.js');
  }
  if (!globalThis.LangslyTheme) {
    importScripts('theme-utils.js');
  }
}

function t(key, substitutions, fallback) {
  if (globalThis.LangslyI18n) return globalThis.LangslyI18n.t(key, substitutions, fallback);
  if (fallback === undefined && typeof substitutions === 'string') return substitutions;
  return fallback || key;
}

// ─── Configurable API URLs ──────────────────────
const LEGACY_DEFAULTS = { apiBase: 'http://localhost:8000/api', frontendUrl: 'http://localhost:3000' };
const DEFAULTS = { apiBase: 'https://api.langsly.com/api', frontendUrl: 'https://langsly.com' };
const MAX_EXTENSION_AUDIO_FETCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXTENSION_SOURCE_LANGUAGE = 'en';

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function resolveConfigValue(value, fallback) {
  const normalized = normalizeUrl(value);
  const normalizedLegacy = normalizeUrl(LEGACY_DEFAULTS[fallback]);
  return !normalized || normalized === normalizedLegacy ? DEFAULTS[fallback] : normalized;
}

async function getConfig() {
  const { apiBase, frontendUrl } = await browser.storage.local.get(['apiBase', 'frontendUrl']);
  return {
    apiBase: resolveConfigValue(apiBase, 'apiBase'),
    frontendUrl: resolveConfigValue(frontendUrl, 'frontendUrl'),
  };
}

async function migrateLegacyConfig() {
  const { apiBase, frontendUrl } = await browser.storage.local.get(['apiBase', 'frontendUrl']);
  const resolvedApiBase = resolveConfigValue(apiBase, 'apiBase');
  const resolvedFrontendUrl = resolveConfigValue(frontendUrl, 'frontendUrl');
  const updates = {};

  if (normalizeUrl(apiBase) !== resolvedApiBase) {
    updates.apiBase = resolvedApiBase;
  }
  if (normalizeUrl(frontendUrl) !== resolvedFrontendUrl) {
    updates.frontendUrl = resolvedFrontendUrl;
  }

  if (Object.keys(updates).length > 0) {
    await browser.storage.local.set(updates);
  }
}

// ─── Token Management ───────────────────────────
async function getTokens() {
  const { authToken, refreshToken } = await browser.storage.local.get(['authToken', 'refreshToken']);
  return { access: authToken, refresh: refreshToken };
}

async function setTokens(access, refresh) {
  await browser.storage.local.set({ authToken: access, refreshToken: refresh });
}

async function clearTokens() {
  await browser.storage.local.remove([
    'authToken',
    'refreshToken',
    'vocabWords',
    'lastSync',
    'matchableWordCount',
    'difficulty',
    'rotation_salt',
    'themePacks',
    'activeThemeSlug',
    'activeThemeName',
    'themeTokens',
    'themeSyncStatus',
  ]);
}

function normalizeLanguageCode(value) {
  return String(value || '').trim().toLowerCase().replace(/_/g, '-').split('-')[0] || '';
}

async function getExtensionSourceLanguage() {
  const { extensionSourceLanguage } = await browser.storage.local.get('extensionSourceLanguage');
  return normalizeLanguageCode(extensionSourceLanguage) || DEFAULT_EXTENSION_SOURCE_LANGUAGE;
}

function countMatchableWords(words) {
  if (!Array.isArray(words)) return 0;
  return words.filter((word) => {
    if (!word) return false;
    if (typeof word.translation === 'string' && word.translation.trim()) return true;
    if (Array.isArray(word.searchable_forms) && word.searchable_forms.some(form => String(form || '').trim())) return true;
    if (Array.isArray(word.source_forms) && word.source_forms.some(form => String(form || '').trim())) return true;
    return false;
  }).length;
}

function _generateRotationSalt() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

async function _ensureRotationSalt() {
  const { rotation_salt } = await browser.storage.local.get('rotation_salt');
  if (!rotation_salt) {
    await browser.storage.local.set({ rotation_salt: _generateRotationSalt() });
  }
}

async function completeLoginWithTokens(data) {
  if (!data || !data.access) {
    return { success: false, error: t('unexpectedServerResponse', 'Unexpected server response') };
  }

  await setTokens(data.access, data.refresh);
  await _ensureRotationSalt();
  await browser.storage.local.set({ syncStatus: 'success' });
  await Promise.allSettled([syncVocabulary(), syncThemes()]);
  return { success: true };
}

function _base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function _createRandomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return _base64UrlEncodeBytes(bytes);
}

function _getExtensionRedirectUri() {
  if (browser.identity && typeof browser.identity.getRedirectURL === 'function') {
    return browser.identity.getRedirectURL('langsly');
  }
  if (globalThis.chrome && chrome.identity && typeof chrome.identity.getRedirectURL === 'function') {
    return chrome.identity.getRedirectURL('langsly');
  }
  throw new Error(t('googleLoginUnavailable', 'Google sign-in is not available in this browser.'));
}

function _buildWebsiteLoginUrl({ frontendUrl, redirectUri, state }) {
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
  });
  return `${normalizeUrl(frontendUrl)}/extension-login?${params.toString()}`;
}

function _launchWebAuthFlow(url) {
  if (browser.identity && typeof browser.identity.launchWebAuthFlow === 'function') {
    return browser.identity.launchWebAuthFlow({ url, interactive: true });
  }

  if (globalThis.chrome && chrome.identity && typeof chrome.identity.launchWebAuthFlow === 'function') {
    return new Promise((resolve, reject) => {
      chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message));
          return;
        }
        resolve(redirectUrl);
      });
    });
  }

  return Promise.reject(new Error(t('googleLoginUnavailable', 'Google sign-in is not available in this browser.')));
}

function _extractExtensionLoginCode(redirectUrl, expectedState) {
  if (!redirectUrl) {
    throw new Error(t('googleLoginCancelled', 'Google sign-in was cancelled.'));
  }

  const parsedUrl = new URL(redirectUrl);
  const error = parsedUrl.searchParams.get('error');
  if (error) {
    throw new Error(t('googleLoginFailed', [error], `Google sign-in failed: ${error}`));
  }

  const state = parsedUrl.searchParams.get('state');
  if (state !== expectedState) {
    throw new Error(t('googleLoginFailed', 'Google sign-in failed.'));
  }

  const code = parsedUrl.searchParams.get('code');
  if (!code) {
    throw new Error(t('googleLoginFailed', 'Google sign-in failed.'));
  }

  return code;
}

async function loginWithGoogle() {
  try {
    const redirectUri = _getExtensionRedirectUri();
    const state = _createRandomBase64Url(24);
    const { apiBase, frontendUrl } = await getConfig();
    const authUrl = _buildWebsiteLoginUrl({ frontendUrl, redirectUri, state });
    const redirectUrl = await _launchWebAuthFlow(authUrl);
    const code = _extractExtensionLoginCode(redirectUrl, state);
    const res = await fetch(`${apiBase}/auth/extension-login/redeem/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return { success: false, error: data.detail || t('googleLoginFailed', 'Google sign-in failed.') };
    }

    return completeLoginWithTokens(data);
  } catch (err) {
    const message = err && err.message ? err.message : t('googleLoginFailed', 'Google sign-in failed.');
    return { success: false, error: message };
  }
}

async function refreshAccessToken() {
  const { refresh } = await getTokens();
  if (!refresh) return null;

  try {
    const { apiBase } = await getConfig();
    const res = await fetch(`${apiBase}/users/token/refresh/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
    });
    if (!res.ok) {
      await clearTokens();
      return null;
    }
    const data = await res.json();
    await setTokens(data.access, data.refresh || refresh);
    return data.access;
  } catch {
    return null;
  }
}

async function authFetch(url, options = {}) {
  let { access } = await getTokens();
  if (!access) return null;

  const headers = { ...options.headers, Authorization: `Bearer ${access}` };
  let res;
  try {
    res = await fetch(url, { ...options, headers });
  } catch {
    await browser.storage.local.set({ syncStatus: 'offline' });
    return null;
  }

  if (res.status === 401) {
    access = await refreshAccessToken();
    if (!access) return null;
    headers.Authorization = `Bearer ${access}`;
    res = await fetch(url, { ...options, headers });
  }

  return res;
}

function _isAllowedExtensionAudioUrl(rawUrl, apiBase) {
  let url;
  let apiUrl;
  try {
    url = new URL(String(rawUrl || ''));
    apiUrl = new URL(apiBase);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.origin !== apiUrl.origin) return false;

  return (
    url.pathname.startsWith('/media/') ||
    /^\/api\/media\/assets\/[^/]+\/content\/?$/.test(url.pathname)
  );
}

function _arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchAudioAsDataUrl(rawUrl) {
  const { apiBase } = await getConfig();
  if (!_isAllowedExtensionAudioUrl(rawUrl, apiBase)) {
    return { success: false, error: 'Audio URL is not allowed.' };
  }

  let res;
  try {
    res = await fetch(rawUrl, { credentials: 'omit' });
  } catch {
    return { success: false, error: 'Audio request failed.' };
  }

  if (!res.ok) {
    return { success: false, error: 'Audio request failed.' };
  }

  const contentLength = Number(res.headers.get('content-length') || '0');
  if (contentLength > MAX_EXTENSION_AUDIO_FETCH_BYTES) {
    return { success: false, error: 'Audio file is too large.' };
  }

  const contentType = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim().toLowerCase();
  if (contentType && !contentType.startsWith('audio/')) {
    return { success: false, error: 'URL did not return audio.' };
  }

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength > MAX_EXTENSION_AUDIO_FETCH_BYTES) {
    return { success: false, error: 'Audio file is too large.' };
  }

  return {
    success: true,
    dataUrl: `data:${contentType || 'audio/mpeg'};base64,${_arrayBufferToBase64(buffer)}`,
  };
}

// ─── Vocabulary Sync ─────────────────────────────
function getFallbackThemeState() {
  return {
    themePacks: [],
    activeThemeSlug: 'system',
    activeThemeName: t('systemThemeName', 'System'),
    themeTokens: LangslyTheme.getDefaultThemeTokens(),
    themeSyncStatus: 'unknown',
  };
}

async function getStoredThemeState() {
  const stored = await browser.storage.local.get([
    'themePacks',
    'activeThemeSlug',
    'activeThemeName',
    'themeTokens',
    'themeSyncStatus',
  ]);
  const fallback = getFallbackThemeState();

  return {
    themePacks: Array.isArray(stored.themePacks) ? stored.themePacks : fallback.themePacks,
    activeThemeSlug: stored.activeThemeSlug || fallback.activeThemeSlug,
    activeThemeName: stored.activeThemeName || fallback.activeThemeName,
    themeTokens: LangslyTheme.normalizeThemeTokens(stored.themeTokens),
    themeSyncStatus: stored.themeSyncStatus || fallback.themeSyncStatus,
  };
}

async function persistThemeState(themeState) {
  const normalizedState = {
    themePacks: Array.isArray(themeState.themePacks) ? themeState.themePacks : [],
    activeThemeSlug: themeState.activeThemeSlug || 'system',
    activeThemeName: themeState.activeThemeName || t('systemThemeName', 'System'),
    themeTokens: LangslyTheme.normalizeThemeTokens(themeState.themeTokens),
    themeSyncStatus: themeState.themeSyncStatus || 'success',
  };
  await browser.storage.local.set(normalizedState);
  return normalizedState;
}

async function syncThemes() {
  const { apiBase } = await getConfig();
  const [userRes, themesRes] = await Promise.all([
    authFetch(`${apiBase}/users/current/`),
    authFetch(`${apiBase}/users/themes/`),
  ]);

  if (!userRes || !themesRes || !userRes.ok || !themesRes.ok) {
    const currentState = await getStoredThemeState();
    await browser.storage.local.set({ themeSyncStatus: 'failed' });
    return { ...currentState, themeSyncStatus: 'failed' };
  }

  const currentUser = await userRes.json();
  const themePacks = await themesRes.json();
  const activeTheme = LangslyTheme.resolveActiveTheme({
    currentUser,
    themePacks,
    fallbackSlug: 'system',
  });

  return persistThemeState({
    themePacks,
    activeThemeSlug: activeTheme.slug,
    activeThemeName: activeTheme.name,
    themeTokens: activeTheme.tokens,
    themeSyncStatus: 'success',
  });
}

async function applyTheme(themeSlug) {
  const { apiBase } = await getConfig();
  const requestedSlug = themeSlug && themeSlug !== 'system' ? themeSlug : null;
  const res = await authFetch(`${apiBase}/users/themes/apply/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme_slug: requestedSlug }),
  });

  if (!res || !res.ok) {
    const currentState = await getStoredThemeState();
    await browser.storage.local.set({ themeSyncStatus: 'failed' });
    return { success: false, ...currentState, themeSyncStatus: 'failed' };
  }

  const themeState = await syncThemes();
  return { success: true, ...themeState };
}

async function syncVocabulary() {
  const { apiBase } = await getConfig();
  const { difficulty } = await browser.storage.local.get('difficulty');
  const level = difficulty || 'normal';
  const sourceLanguage = await getExtensionSourceLanguage();

  const res = await authFetch(`${apiBase}/lessons/vocabpass/words/?difficulty=${level}&source_language=${encodeURIComponent(sourceLanguage)}`);
  if (!res) {
    await browser.storage.local.set({ syncStatus: 'failed' });
    return;
  }
  if (!res.ok) {
    await browser.storage.local.set({ syncStatus: 'failed' });
    return;
  }

  const data = await res.json();
  const matchableWordCount = countMatchableWords(data.words);
  await browser.storage.local.set({
    vocabWords: data.words,
    lastSync: new Date().toISOString(),
    wordCount: data.count,
    matchableWordCount,
    extensionSourceLanguage: sourceLanguage,
    syncStatus: 'success',
  });

  // Notify all content scripts to refresh (only web pages, not internal tabs)
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id) {
      browser.tabs.sendMessage(tab.id, { type: 'VOCAB_UPDATED', words: data.words }).catch(() => {});
    }
  }
}

// ─── Encounter Flush ─────────────────────────────
async function flushEncounters() {
  const { pendingEncounters } = await browser.storage.local.get('pendingEncounters');
  if (!pendingEncounters || pendingEncounters.length === 0) return;

  const { apiBase } = await getConfig();
  const res = await authFetch(`${apiBase}/lessons/vocabpass/encounters/batch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ encounters: pendingEncounters }),
  });

  if (res && res.ok) {
    await browser.storage.local.set({ pendingEncounters: [] });
  }
}

// ─── Alarms ──────────────────────────────────────
async function setupAlarms() {
  const { syncInterval } = await browser.storage.local.get('syncInterval');
  const interval = syncInterval || 60;
  browser.alarms.create('vocab-sync', { periodInMinutes: interval });
  browser.alarms.create('encounter-flush', { periodInMinutes: 5 });
}

setupAlarms();
migrateLegacyConfig().catch(() => {});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vocab-sync') {
    syncVocabulary();
    syncThemes();
  }
  if (alarm.name === 'encounter-flush') flushEncounters();
});

// ─── Message Handling ────────────────────────────
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'LOGIN') {
    return (async () => {
      try {
        const { apiBase } = await getConfig();
        const res = await fetch(`${apiBase}/users/login/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: message.email, password: message.password }),
        });

        if (!res.ok) {
          let errorMsg = t('loginFailed', 'Login failed');
          try {
            const data = await res.json();
            errorMsg = data.detail || t('invalidEmailOrPassword', 'Invalid email or password');
          } catch { /* use default */ }
          return { success: false, error: errorMsg };
        }

        const data = await res.json();
        return completeLoginWithTokens(data);
      } catch (err) {
        const isConnectionRefused = err.message && (
          err.message.includes('Failed to fetch') ||
          err.message.includes('NetworkError') ||
          err.message.includes('Network request failed')
        );
        if (isConnectionRefused) {
          await browser.storage.local.set({ syncStatus: 'offline' });
          return { success: false, error: t('cannotReachServer', 'Cannot reach server. Check your connection or server URL in options.') };
        }
        return { success: false, error: t('networkError', [err.message], `Network error: ${err.message}`) };
      }
    })();
  }

  if (message.type === 'GOOGLE_LOGIN') {
    return loginWithGoogle();
  }

  if (message.type === 'LOGOUT') {
    return clearTokens().then(() => ({ success: true }));
  }

  if (message.type === 'SYNC_NOW') {
    return Promise.allSettled([syncVocabulary(), syncThemes()]).then(() => ({ success: true }));
  }

  if (message.type === 'FETCH_AUDIO') {
    return fetchAudioAsDataUrl(message.url);
  }

  if (message.type === 'SET_DIFFICULTY') {
    return browser.storage.local.set({ difficulty: message.difficulty })
      .then(() => syncVocabulary())
      .then(() => ({ success: true }));
  }

  // Single encounter (legacy support)
  if (message.type === 'RECORD_ENCOUNTER') {
    return (async () => {
      const { pendingEncounters = [] } = await browser.storage.local.get('pendingEncounters');
      pendingEncounters.push({
        word_id: message.word_id,
        domain: message.domain,
        was_clicked: message.was_clicked || false,
      });
      await browser.storage.local.set({ pendingEncounters });
      return { success: true };
    })();
  }

  // Batched encounters from content script
  if (message.type === 'RECORD_ENCOUNTERS_BATCH') {
    return (async () => {
      const { pendingEncounters = [] } = await browser.storage.local.get('pendingEncounters');
      pendingEncounters.push(...(message.encounters || []));
      await browser.storage.local.set({ pendingEncounters });

      // Auto-flush if buffer is large
      if (pendingEncounters.length >= 100) {
        flushEncounters();
      }
      return { success: true };
    })();
  }

  if (message.type === 'GET_STATUS') {
    return (async () => {
      const {
        authToken,
        lastSync,
        wordCount,
        difficulty,
        syncStatus,
        extensionSourceLanguage,
        matchableWordCount,
        themePacks,
        activeThemeSlug,
        activeThemeName,
        themeTokens,
        themeSyncStatus,
      } = await browser.storage.local.get([
        'authToken',
        'lastSync',
        'wordCount',
        'difficulty',
        'syncStatus',
        'extensionSourceLanguage',
        'matchableWordCount',
        'themePacks',
        'activeThemeSlug',
        'activeThemeName',
        'themeTokens',
        'themeSyncStatus',
      ]);
      return {
        isLoggedIn: !!authToken,
        lastSync: lastSync || null,
        wordCount: wordCount || 0,
        difficulty: difficulty || 'normal',
        syncStatus: syncStatus || 'unknown',
        extensionSourceLanguage: extensionSourceLanguage || DEFAULT_EXTENSION_SOURCE_LANGUAGE,
        matchableWordCount: Number.isFinite(matchableWordCount) ? matchableWordCount : 0,
        themePacks: Array.isArray(themePacks) ? themePacks : [],
        activeThemeSlug: activeThemeSlug || 'system',
        activeThemeName: activeThemeName || t('systemThemeName', 'System'),
        themeTokens: LangslyTheme.normalizeThemeTokens(themeTokens),
        themeSyncStatus: themeSyncStatus || 'unknown',
      };
    })();
  }

  if (message.type === 'GET_THEME_STATUS') {
    return getStoredThemeState().then((themeState) => ({ success: true, ...themeState }));
  }

  if (message.type === 'SYNC_THEMES') {
    return syncThemes().then((themeState) => ({ success: true, ...themeState }));
  }

  if (message.type === 'APPLY_THEME') {
    return applyTheme(message.themeSlug);
  }

  if (message.type === 'GET_WHITELIST') {
    return (async () => {
      const { apiBase } = await getConfig();
      const res = await authFetch(`${apiBase}/lessons/vocabpass/whitelist/`);
      if (res && res.ok) {
        const data = await res.json();
        return {
          domains: data.map(d => d.domain),
          entries: data,
        };
      }
      return { domains: [], entries: [] };
    })();
  }

  if (message.type === 'TOGGLE_WHITELIST') {
    return (async () => {
      const { apiBase } = await getConfig();
      const domain = message.domain;
      if (message.add) {
        await authFetch(`${apiBase}/lessons/vocabpass/whitelist/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain }),
        });
      } else {
        // Remove matching whitelist entries so users can re-enable a site
        // directly from the popup toggle.
        const listRes = await authFetch(`${apiBase}/lessons/vocabpass/whitelist/`);
        if (listRes && listRes.ok) {
          const entries = await listRes.json();
          const normalizedDomain = String(domain || '').toLowerCase();
          const matchesDomain = (entryDomain) => {
            const d = String(entryDomain || '').toLowerCase();
            return (
              normalizedDomain === d ||
              normalizedDomain.endsWith(`.${d}`) ||
              d.endsWith(`.${normalizedDomain}`)
            );
          };

          const toDelete = entries.filter((entry) => matchesDomain(entry.domain));
          await Promise.all(
            toDelete.map((entry) =>
              authFetch(`${apiBase}/lessons/vocabpass/whitelist/${entry.id}/delete/`, {
                method: 'DELETE',
              })
            )
          );
        }
      }
      return { success: true };
    })();
  }

  if (message.type === 'UPDATE_CONFIG') {
    return (async () => {
      const updates = {};
      if (message.apiBase) updates.apiBase = message.apiBase;
      if (message.frontendUrl) updates.frontendUrl = message.frontendUrl;
      if (message.syncInterval) {
        updates.syncInterval = message.syncInterval;
        // Recreate alarm with new interval
        await browser.alarms.clear('vocab-sync');
        browser.alarms.create('vocab-sync', { periodInMinutes: message.syncInterval });
      }
      await browser.storage.local.set(updates);
      return { success: true };
    })();
  }

  // ─── Phrase Translation ───────────────────────
  if (message.type === 'PHRASE_TRANSLATE') {
    return (async () => {
      try {
        const { source_phrase, source_language, target_language, word_ids } = message;
        const cacheKey = `phrase_${source_phrase}_${source_language}_${target_language}`;

        // 1. Check local browser cache first
        const cached = await browser.storage.local.get(cacheKey);
        if (cached[cacheKey]) {
          return { success: true, ...cached[cacheKey] };
        }

        // 2. Call backend
        const { apiBase } = await getConfig();
        const res = await authFetch(`${apiBase}/lessons/vocabpass/phrase-translate/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source_phrase, source_language, target_language, word_ids }),
        });

        if (!res || !res.ok) {
          return { success: false, error: t('translationRequestFailed', 'Translation request failed') };
        }

        const data = await res.json();

        // 3. Store in local cache (LRU eviction handled by periodic cleanup)
        if (data.translated_phrase) {
          const entry = {
            translated_phrase: data.translated_phrase,
            source: data.source,
            model_used: data.model_used || '',
            cache_entry_id: data.cache_entry_id || '',
            cached_at: Date.now(),
          };
          await browser.storage.local.set({ [cacheKey]: entry });

          // LRU eviction: cap at ~1000 phrase cache entries
          _evictPhraseCacheIfNeeded();
        }

        return { success: true, ...data };
      } catch (err) {
        return { success: false, error: err.message };
      }
    })();
  }

  if (message.type === 'PHRASE_FLAG') {
    return (async () => {
      try {
        const { apiBase } = await getConfig();
        const res = await authFetch(`${apiBase}/lessons/vocabpass/phrase-translate/flag/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cache_entry_id: message.cache_entry_id,
            reason: message.reason || '',
          }),
        });
        return { success: res && res.ok };
      } catch {
        return { success: false };
      }
    })();
  }

  // ─── Word Sense Disambiguation ───────────────
  if (message.type === 'DISAMBIGUATE') {
    return (async () => {
      try {
        const { items } = message;
        if (!items || items.length === 0) return { results: [] };

        // 1. Check browser cache for each item
        const results = new Array(items.length).fill(null);
        const uncached = [];

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const cacheKey = _disambigCacheKey(item);
          const cached = await browser.storage.local.get(cacheKey);
          if (cached[cacheKey]) {
            results[i] = cached[cacheKey];
          } else {
            uncached.push(i);
          }
        }

        // All cached — return early
        if (uncached.length === 0) {
          return { results };
        }

        // 2. Call backend for uncached items
        const uncachedItems = uncached.map(i => items[i]);
        const { apiBase } = await getConfig();
        const res = await authFetch(`${apiBase}/lessons/vocabpass/disambiguate/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: uncachedItems }),
        });

        if (!res || !res.ok) {
          return { results };
        }

        const data = await res.json();
        const backendResults = data.results || [];

        // 3. Merge backend results and cache them
        for (let j = 0; j < uncached.length; j++) {
          const originalIdx = uncached[j];
          const result = backendResults[j];
          if (result) {
            results[originalIdx] = result;
            // Cache in browser storage
            const cacheKey = _disambigCacheKey(items[originalIdx]);
            const entry = { ...result, cached_at: Date.now() };
            await browser.storage.local.set({ [cacheKey]: entry });
          }
        }

        // 4. Evict old disambiguation cache entries
        _evictDisambigCacheIfNeeded();

        return { results };
      } catch (err) {
        return { results: [], error: err.message };
      }
    })();
  }

  if (message.type === 'DISAMBIG_FEEDBACK') {
    return (async () => {
      try {
        const { apiBase } = await getConfig();
        const res = await authFetch(`${apiBase}/lessons/vocabpass/disambiguate/feedback/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sentence: message.sentence || '',
            matched_text: message.matched_text || '',
            match_offset: message.match_offset || 0,
            candidate_ids: message.candidate_ids || [],
            source_language: message.source_language || 'en',
            target_language: message.target_language || 'es',
            shown_word_id: message.shown_word_id || '',
            chosen_word_id: message.chosen_word_id || '',
            was_uncertain: !!message.was_uncertain,
            method_used: message.method_used || 'spacy',
          }),
        });

        return { success: !!(res && res.ok) };
      } catch {
        return { success: false };
      }
    })();
  }
});

// ─── Phrase Cache Eviction ───────────────────────
async function _evictPhraseCacheIfNeeded() {
  const PHRASE_CACHE_MAX = 1000;
  const PHRASE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  try {
    const all = await browser.storage.local.get(null);
    const phraseKeys = Object.keys(all).filter(k => k.startsWith('phrase_'));

    // Remove expired entries
    const now = Date.now();
    const expired = phraseKeys.filter(k => {
      const entry = all[k];
      return entry && entry.cached_at && (now - entry.cached_at) > PHRASE_CACHE_TTL_MS;
    });
    if (expired.length > 0) {
      await browser.storage.local.remove(expired);
    }

    // LRU eviction if still over limit
    const remaining = phraseKeys.filter(k => !expired.includes(k));
    if (remaining.length > PHRASE_CACHE_MAX) {
      const sorted = remaining
        .map(k => ({ key: k, time: all[k]?.cached_at || 0 }))
        .sort((a, b) => a.time - b.time);
      const toRemove = sorted.slice(0, remaining.length - PHRASE_CACHE_MAX).map(e => e.key);
      await browser.storage.local.remove(toRemove);
    }
  } catch {
    // Non-critical — eviction failure doesn't break functionality
  }
}

// ─── Disambiguation Cache Helpers ────────────────
function _disambigCacheKey(item) {
  const candidatesSorted = [...(item.candidate_ids || [])].sort().join(',');
  const raw = `${item.sentence || ''}|${item.matched_text || ''}|${item.match_offset || 0}|${item.source_language || 'en'}|${candidatesSorted}`;
  // Simple hash using btoa (base64) — good enough for cache keys
  try {
    return `disambig_${btoa(unescape(encodeURIComponent(raw))).slice(0, 64)}`;
  } catch {
    return `disambig_${raw.length}_${candidatesSorted.slice(0, 32)}`;
  }
}

async function _evictDisambigCacheIfNeeded() {
  const DISAMBIG_CACHE_MAX = 2000;
  const DISAMBIG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  try {
    const all = await browser.storage.local.get(null);
    const disambigKeys = Object.keys(all).filter(k => k.startsWith('disambig_'));

    // Remove expired entries
    const now = Date.now();
    const expired = disambigKeys.filter(k => {
      const entry = all[k];
      return entry && entry.cached_at && (now - entry.cached_at) > DISAMBIG_CACHE_TTL_MS;
    });
    if (expired.length > 0) {
      await browser.storage.local.remove(expired);
    }

    // LRU eviction if still over limit
    const remaining = disambigKeys.filter(k => !expired.includes(k));
    if (remaining.length > DISAMBIG_CACHE_MAX) {
      const sorted = remaining
        .map(k => ({ key: k, time: all[k]?.cached_at || 0 }))
        .sort((a, b) => a.time - b.time);
      const toRemove = sorted.slice(0, remaining.length - DISAMBIG_CACHE_MAX).map(e => e.key);
      await browser.storage.local.remove(toRemove);
    }
  } catch {
    // Non-critical — eviction failure doesn't break functionality
  }
}

// ─── Install / Startup ──────────────────────────
browser.runtime.onInstalled.addListener((details) => {
  browser.storage.local.set({ pendingEncounters: [], difficulty: 'normal', syncStatus: 'unknown' });

  // Open onboarding page on first install
  if (details.reason === 'install') {
    browser.tabs.create({ url: browser.runtime.getURL('popup/onboarding.html') });
  }
});

browser.runtime.onStartup.addListener(() => {
  _ensureRotationSalt();
  syncVocabulary();
  syncThemes();
});
