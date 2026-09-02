/* global browser, LangslyEncounterCoordinator */
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
  if (!globalThis.LangslyEncounterCoordinator) {
    importScripts('encounter-coordinator.js');
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
const AUTO_BUDGET_WINDOW_MS = 60 * 1000;
const automaticBudgetBuckets = new Map();
const activeAuthControllers = new Set();
let authGeneration = 0;
let encounterCoordinator = null;
let refreshPromise = null;
let refreshPromiseGeneration = -1;
let sessionMutationTail = Promise.resolve();

function _withSessionMutation(task) {
  const result = sessionMutationTail.then(task, task);
  sessionMutationTail = result.catch(() => {});
  return result;
}

function _setSessionStorage(values, expectedGeneration = authGeneration) {
  return _withSessionMutation(async () => {
    if (expectedGeneration !== authGeneration) return false;
    await browser.storage.local.set(values);
    return true;
  });
}

function _getSessionSnapshot() {
  return _withSessionMutation(async () => {
    const generation = authGeneration;
    const { authToken, refreshToken } = await browser.storage.local.get(['authToken', 'refreshToken']);
    if (generation !== authGeneration) return { access: null, refresh: null, generation: authGeneration };
    return { access: authToken, refresh: refreshToken, generation };
  });
}

function _consumeAutomaticBudget(sender, type, cost, pageLimit, originLimit) {
  const now = Date.now();
  let origin = 'unknown';
  try { origin = new URL(sender && sender.url ? sender.url : '').origin; } catch { /* unknown */ }
  const documentKey = sender && sender.documentId
    ? sender.documentId
    : `${sender && sender.tab ? sender.tab.id : 'extension'}:${sender && Number.isInteger(sender.frameId) ? sender.frameId : 0}`;
  const keys = [[`document:${documentKey}:${type}`, pageLimit], [`origin:${origin}:${type}`, originLimit]];
  for (const [key, limit] of keys) {
    const current = automaticBudgetBuckets.get(key);
    const bucket = !current || now - current.startedAt >= AUTO_BUDGET_WINDOW_MS ? { startedAt: now, used: 0 } : current;
    if (bucket.used + cost > limit) return false;
  }
  for (const [key] of keys) {
    const current = automaticBudgetBuckets.get(key);
    const bucket = !current || now - current.startedAt >= AUTO_BUDGET_WINDOW_MS ? { startedAt: now, used: 0 } : current;
    bucket.used += cost;
    automaticBudgetBuckets.set(key, bucket);
  }
  return true;
}

function _safeEncounter(encounter) {
  const domain = String(encounter && encounter.domain || '').trim().toLowerCase();
  const wordId = String(encounter && encounter.word_id || '').trim();
  if (!wordId || wordId.length > 64 || !/^[a-z0-9.-]{1,253}$/i.test(domain)) return null;
  return {
    word_id: wordId,
    domain,
    interaction: encounter.interaction === 'trusted_tap' ? 'trusted_tap' : 'automatic_view',
  };
}

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

async function setTokens(access, refresh, expectedGeneration = authGeneration) {
  return _setSessionStorage({ authToken: access, refreshToken: refresh }, expectedGeneration);
}

async function clearTokens() {
  authGeneration += 1;
  for (const controller of activeAuthControllers) controller.abort();
  activeAuthControllers.clear();
  automaticBudgetBuckets.clear();
  await _withSessionMutation(async () => {
    if (encounterCoordinator) await encounterCoordinator.clear();
    const all = await browser.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter(key => (
      key.startsWith('phrase_')
      || key.startsWith('disambig_')
      || key.startsWith('contextual_')
    ));
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
    'wordCount',
    'syncStatus',
    'pendingEncounters',
    'extensionDeviceAuthorization',
    'extensionSourceLanguage',
      ...cacheKeys,
    ]);
  });
}

async function broadcastAuthCleared() {
  await browser.runtime.sendMessage({ type: 'AUTH_CLEARED' }).catch(() => {});
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.allSettled(tabs
    .filter((tab) => tab.id)
    .map((tab) => browser.tabs.sendMessage(tab.id, { type: 'AUTH_CLEARED' })));
}

async function clearSession() {
  await clearTokens();
  await broadcastAuthCleared();
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

function getApiErrorMessage(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  const candidates = [data.detail, data.message, data.email, data.password, data.non_field_errors];
  for (const candidate of candidates) {
    const value = Array.isArray(candidate) ? candidate[0] : candidate;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

function _generateRotationSalt() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

async function _ensureRotationSalt(expectedGeneration = authGeneration) {
  const { rotation_salt } = await browser.storage.local.get('rotation_salt');
  if (!rotation_salt) {
    await _withSessionMutation(async () => {
      if (expectedGeneration !== authGeneration) return;
      await browser.storage.local.set({ rotation_salt: _generateRotationSalt() });
    });
  }
}

async function completeLoginWithTokens(data) {
  if (!data || !data.access) {
    return { success: false, error: t('unexpectedServerResponse', 'Unexpected server response') };
  }

  const generation = authGeneration;
  if (!await setTokens(data.access, data.refresh, generation)) return { success: false, error: 'cancelled' };
  await _ensureRotationSalt(generation);
  await _withSessionMutation(async () => {
    if (generation === authGeneration) await browser.storage.local.set({ syncStatus: 'success' });
  });
  await Promise.allSettled([syncVocabulary(), syncThemes()]);
  return generation === authGeneration ? { success: true } : { success: false, error: 'cancelled' };
}

async function openDeviceConnectionPage() {
  const url = browser.runtime.getURL('popup/connect.html');
  const existing = await browser.tabs.query({ url: `${url}*` });
  if (existing.length > 0 && existing[0].id) {
    await browser.tabs.update(existing[0].id, { active: true });
    return { success: true, tabId: existing[0].id };
  }
  const tab = await browser.tabs.create({ url });
  return { success: true, tabId: tab && tab.id };
}

async function refreshAccessToken() {
  const snapshot = await _getSessionSnapshot();
  if (!snapshot.refresh) return null;
  if (refreshPromise && refreshPromiseGeneration === snapshot.generation) return refreshPromise;
  const currentPromise = _refreshAccessToken(snapshot).finally(() => {
    if (refreshPromise === currentPromise) {
      refreshPromise = null;
      refreshPromiseGeneration = -1;
    }
  });
  refreshPromise = currentPromise;
  refreshPromiseGeneration = snapshot.generation;
  return currentPromise;
}

function isExtensionRefreshToken(token) {
  try {
    const encodedPayload = String(token || '').split('.')[1];
    if (!encodedPayload) return false;
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(atob(padded)).extension_session === true;
  } catch {
    return false;
  }
}

async function _refreshAccessToken({ refresh, generation }) {
  const controller = new AbortController();
  activeAuthControllers.add(controller);

  try {
    const { apiBase } = await getConfig();
    // Sessions created before the longer extension policy do not carry the
    // extension claim. Let them keep rotating on the original route so an
    // extension update never forces an otherwise-valid user to sign in again.
    const refreshPath = isExtensionRefreshToken(refresh)
      ? '/auth/extension-token/refresh/'
      : '/auth/token/refresh/';
    const res = await fetch(`${apiBase}${refreshPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Only an authentication rejection proves this session is no longer valid.
      // Keep the rotating refresh token through rate limits and server outages so
      // a temporary backend problem never turns into an unnecessary sign-in.
      if ([400, 401, 403].includes(res.status) && generation === authGeneration) {
        await clearSession();
      }
      return null;
    }
    const data = await res.json();
    if (generation !== authGeneration) return null;
    if (!await setTokens(data.access, data.refresh || refresh, generation)) return null;
    return data.access;
  } catch {
    return null;
  } finally {
    activeAuthControllers.delete(controller);
  }
}

async function authFetch(url, options = {}) {
  const snapshot = await _getSessionSnapshot();
  let { access } = snapshot;
  if (!access) return null;
  const { generation } = snapshot;
  const controller = new AbortController();
  activeAuthControllers.add(controller);

  if (generation !== authGeneration) {
    activeAuthControllers.delete(controller);
    controller.abort();
    return null;
  }

  const headers = { ...options.headers, Authorization: `Bearer ${access}` };
  let res;
  try {
    res = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch {
    if (generation === authGeneration && !controller.signal.aborted) {
      await _setSessionStorage({ syncStatus: 'offline' }, generation);
    }
    return null;
  } finally {
    activeAuthControllers.delete(controller);
  }

  if (generation !== authGeneration) return null;

  if (res.status === 401) {
    access = await refreshAccessToken();
    if (!access) return null;
    headers.Authorization = `Bearer ${access}`;
    const retryController = new AbortController();
    activeAuthControllers.add(retryController);
    try {
      res = await fetch(url, { ...options, headers, signal: retryController.signal });
    } catch {
      return null;
    } finally {
      activeAuthControllers.delete(retryController);
    }
    if (generation !== authGeneration) return null;
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

async function persistThemeState(themeState, expectedGeneration = authGeneration) {
  const normalizedState = {
    themePacks: Array.isArray(themeState.themePacks) ? themeState.themePacks : [],
    activeThemeSlug: themeState.activeThemeSlug || 'system',
    activeThemeName: themeState.activeThemeName || t('systemThemeName', 'System'),
    themeTokens: LangslyTheme.normalizeThemeTokens(themeState.themeTokens),
    themeSyncStatus: themeState.themeSyncStatus || 'success',
  };
  return await _setSessionStorage(normalizedState, expectedGeneration) ? normalizedState : null;
}

async function syncThemes() {
  const generation = authGeneration;
  const { access } = await getTokens();
  if (!access) return getStoredThemeState();
  const { apiBase } = await getConfig();
  const [userRes, themesRes] = await Promise.all([
    authFetch(`${apiBase}/users/current/`),
    authFetch(`${apiBase}/users/themes/`),
  ]);

  if (!userRes || !themesRes || !userRes.ok || !themesRes.ok) {
    const currentState = await getStoredThemeState();
    const stored = await _setSessionStorage({ themeSyncStatus: 'failed' }, generation);
    return stored ? { ...currentState, themeSyncStatus: 'failed' } : currentState;
  }

  const currentUser = await userRes.json();
  const themePacks = await themesRes.json();
  if (generation !== authGeneration) return getStoredThemeState();
  const activeTheme = LangslyTheme.resolveActiveTheme({
    currentUser,
    themePacks,
    fallbackSlug: 'system',
  });

  const persisted = await persistThemeState({
    themePacks,
    activeThemeSlug: activeTheme.slug,
    activeThemeName: activeTheme.name,
    themeTokens: activeTheme.tokens,
    themeSyncStatus: 'success',
  }, generation);
  return persisted || getStoredThemeState();
}

async function applyTheme(themeSlug) {
  const generation = authGeneration;
  const { access } = await getTokens();
  if (!access) return { success: false, ...(await getStoredThemeState()) };
  const { apiBase } = await getConfig();
  const requestedSlug = themeSlug && themeSlug !== 'system' ? themeSlug : null;
  const res = await authFetch(`${apiBase}/users/themes/apply/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme_slug: requestedSlug }),
  });

  if (!res || !res.ok) {
    const currentState = await getStoredThemeState();
    const stored = await _setSessionStorage({ themeSyncStatus: 'failed' }, generation);
    return { success: false, ...currentState, ...(stored ? { themeSyncStatus: 'failed' } : {}) };
  }

  const themeState = await syncThemes();
  return { success: true, ...themeState };
}

async function syncVocabulary() {
  const generation = authGeneration;
  const { access } = await getTokens();
  if (!access) return;
  const { apiBase } = await getConfig();
  const { difficulty } = await browser.storage.local.get('difficulty');
  const level = difficulty || 'normal';
  const sourceLanguage = await getExtensionSourceLanguage();

  const res = await authFetch(`${apiBase}/lessons/vocabpass/words/?difficulty=${level}&source_language=${encodeURIComponent(sourceLanguage)}`);
  if (!res) {
    await _setSessionStorage({ syncStatus: 'failed' }, generation);
    return;
  }
  if (!res.ok) {
    await _setSessionStorage({ syncStatus: 'failed' }, generation);
    return;
  }

  const data = await res.json();
  if (generation !== authGeneration) return;
  const matchableWordCount = countMatchableWords(data.words);
  const stored = await _setSessionStorage({
    vocabWords: data.words,
    lastSync: new Date().toISOString(),
    wordCount: data.count,
    matchableWordCount,
    extensionSourceLanguage: sourceLanguage,
    syncStatus: 'success',
  }, generation);
  if (!stored) return;

  // Notify all content scripts to refresh (only web pages, not internal tabs)
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id) {
      browser.tabs.sendMessage(tab.id, { type: 'VOCAB_UPDATED', words: data.words }).catch(() => {});
    }
  }
}

// ─── Encounter Flush ─────────────────────────────
encounterCoordinator = LangslyEncounterCoordinator.create({
  batchSize: 50,
  maxStored: 1000,
  load: async () => {
    const { pendingEncounters = [] } = await browser.storage.local.get('pendingEncounters');
    return pendingEncounters;
  },
  save: (pendingEncounters) => browser.storage.local.set({ pendingEncounters }),
  send: async (encounters) => {
    const { apiBase } = await getConfig();
    const res = await authFetch(`${apiBase}/lessons/vocabpass/encounters/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encounters }),
    });
    return !!(res && res.ok);
  },
});

function flushEncounters() {
  return encounterCoordinator.flush();
}

function appendEncountersForSession(encounters, expectedGeneration = authGeneration) {
  return _withSessionMutation(async () => {
    if (expectedGeneration !== authGeneration) return null;
    const { access } = await getTokens();
    if (!access || expectedGeneration !== authGeneration) return null;
    return encounterCoordinator.append(encounters);
  });
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
browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'START_DEVICE_LOGIN') {
    return openDeviceConnectionPage();
  }

  if (message.type === 'COMPLETE_DEVICE_LOGIN') {
    return completeLoginWithTokens(message.tokens).then(async (result) => {
      if (result.success) await browser.storage.local.remove('extensionDeviceAuthorization');
      return result;
    });
  }

  if (message.type === 'LOGOUT') {
    return clearSession().then(() => ({ success: true }));
  }

  if (message.type === 'SYNC_NOW') {
    return Promise.allSettled([syncVocabulary(), syncThemes()]).then(() => ({ success: true }));
  }

  if (message.type === 'FETCH_AUDIO') {
    return fetchAudioAsDataUrl(message.url);
  }

  if (message.type === 'SET_DIFFICULTY') {
    return (async () => {
      const generation = authGeneration;
      const { access } = await getTokens();
      if (!access) return { success: false, error: 'unauthenticated' };
      if (!await _setSessionStorage({ difficulty: message.difficulty }, generation)) {
        return { success: false, error: 'cancelled' };
      }
      await syncVocabulary();
      return generation === authGeneration ? { success: true } : { success: false, error: 'cancelled' };
    })();
  }

  // Single encounter (legacy support)
  if (message.type === 'RECORD_ENCOUNTER') {
    return (async () => {
      const generation = authGeneration;
      const encounter = _safeEncounter({
        word_id: message.word_id,
        domain: message.domain,
        interaction: message.interaction,
      });
      if (!encounter) return { success: false, error: 'invalid_encounter' };
      if (encounter.interaction === 'automatic_view' && !_consumeAutomaticBudget(sender, 'encounter', 1, 500, 2000)) {
        return { success: false, error: 'quota_exceeded' };
      }
      const pendingCount = await appendEncountersForSession([encounter], generation);
      if (pendingCount === null) return { success: false, error: 'unauthenticated' };
      return { success: true };
    })();
  }

  // Batched encounters from content script
  if (message.type === 'RECORD_ENCOUNTERS_BATCH') {
    return (async () => {
      const generation = authGeneration;
      const raw = Array.isArray(message.encounters) ? message.encounters.slice(0, 50) : [];
      const safe = raw.map(_safeEncounter).filter(Boolean);
      const automaticCount = safe.filter((encounter) => encounter.interaction === 'automatic_view').length;
      if (automaticCount > 0 && !_consumeAutomaticBudget(sender, 'encounter', automaticCount, 500, 2000)) {
        return { success: false, error: 'quota_exceeded' };
      }
      const pendingCount = await appendEncountersForSession(safe, generation);
      if (pendingCount === null) return { success: false, error: 'unauthenticated' };

      // Auto-flush if buffer is large
      if (pendingCount >= 100) {
        void flushEncounters();
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
        const generation = authGeneration;
        if (!_consumeAutomaticBudget(sender, 'phrase', 1, 20, 100)) return { success: false, error: 'quota_exceeded' };
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
        if (generation !== authGeneration) return { success: false, error: 'cancelled' };

        // 3. Store in local cache (LRU eviction handled by periodic cleanup)
        if (data.translated_phrase) {
          const entry = {
            translated_phrase: data.translated_phrase,
            source: data.source,
            model_used: data.model_used || '',
            cache_entry_id: data.cache_entry_id || '',
            cached_at: Date.now(),
          };
          if (!await _setSessionStorage({ [cacheKey]: entry }, generation)) {
            return { success: false, error: 'cancelled' };
          }

          // LRU eviction: cap at ~1000 phrase cache entries
          void _evictPhraseCacheIfNeeded(generation);
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

  // ─── Spanish contextual subject recovery ──────
  if (message.type === 'CONTEXTUAL_REWRITE') {
    return (async () => {
      try {
        const generation = authGeneration;
        if (!_consumeAutomaticBudget(sender, 'contextual', 1, 30, 150)) {
          return { replacement_text: '', uncertain: true, error: 'quota_exceeded' };
        }

        const payload = {
          sentence: String(message.sentence || '').slice(0, 500),
          matched_text: String(message.matched_text || '').slice(0, 255),
          match_offset: Number(message.match_offset) || 0,
          candidate_ids: Array.isArray(message.candidate_ids) ? message.candidate_ids.slice(0, 20) : [],
          source_language: message.source_language || 'es',
          target_language: message.target_language || 'en',
        };
        const cacheKey = await _contextualCacheKey(payload);
        const cached = await browser.storage.local.get(cacheKey);
        if (cached[cacheKey]) return cached[cacheKey];

        const { apiBase } = await getConfig();
        const res = await authFetch(`${apiBase}/lessons/vocabpass/contextual-rewrite/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res || !res.ok) {
          return { replacement_text: '', uncertain: true, error: 'request_failed' };
        }

        const data = await res.json();
        if (generation !== authGeneration) {
          return { replacement_text: '', uncertain: true, error: 'cancelled' };
        }
        const entry = { ...data, cached_at: Date.now() };
        if (!await _setSessionStorage({ [cacheKey]: entry }, generation)) {
          return { replacement_text: '', uncertain: true, error: 'cancelled' };
        }
        void _evictContextualCacheIfNeeded(generation);
        return entry;
      } catch (err) {
        return { replacement_text: '', uncertain: true, error: err.message };
      }
    })();
  }

  // ─── Word Sense Disambiguation ───────────────
  if (message.type === 'DISAMBIGUATE') {
    return (async () => {
      try {
        const generation = authGeneration;
        const { items } = message;
        if (!items || items.length === 0) return { results: [] };
        if (!_consumeAutomaticBudget(sender, 'disambiguate', Math.min(items.length, 50), 60, 300)) return { results: [], error: 'quota_exceeded' };

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
        if (generation !== authGeneration) return { results: [], error: 'cancelled' };
        const backendResults = data.results || [];

        // 3. Merge backend results and cache them
        const cacheUpdates = {};
        for (let j = 0; j < uncached.length; j++) {
          const originalIdx = uncached[j];
          const result = backendResults[j];
          if (result) {
            results[originalIdx] = result;
            // Cache in browser storage
            const cacheKey = _disambigCacheKey(items[originalIdx]);
            const entry = { ...result, cached_at: Date.now() };
            cacheUpdates[cacheKey] = entry;
          }
        }
        if (Object.keys(cacheUpdates).length > 0 && !await _setSessionStorage(cacheUpdates, generation)) {
          return { results: [], error: 'cancelled' };
        }

        // 4. Evict old disambiguation cache entries
        void _evictDisambigCacheIfNeeded(generation);

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
async function _evictPhraseCacheIfNeeded(expectedGeneration = authGeneration) {
  const PHRASE_CACHE_MAX = 1000;
  const PHRASE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  try {
    await _withSessionMutation(async () => {
      if (expectedGeneration !== authGeneration) return;
      const all = await browser.storage.local.get(null);
      const phraseKeys = Object.keys(all).filter(k => k.startsWith('phrase_'));

    // Remove expired entries
    const now = Date.now();
    const expired = phraseKeys.filter(k => {
      const entry = all[k];
      return entry && entry.cached_at && (now - entry.cached_at) > PHRASE_CACHE_TTL_MS;
    });
      if (expired.length > 0) await browser.storage.local.remove(expired);

    // LRU eviction if still over limit
    const remaining = phraseKeys.filter(k => !expired.includes(k));
      if (remaining.length > PHRASE_CACHE_MAX) {
        const sorted = remaining
          .map(k => ({ key: k, time: all[k]?.cached_at || 0 }))
          .sort((a, b) => a.time - b.time);
        const toRemove = sorted.slice(0, remaining.length - PHRASE_CACHE_MAX).map(e => e.key);
        await browser.storage.local.remove(toRemove);
      }
    });
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

async function _contextualCacheKey(item) {
  const candidatesSorted = [...(item.candidate_ids || [])].sort().join(',');
  const raw = `${item.sentence || ''}|${item.matched_text || ''}|${item.match_offset || 0}|${item.source_language || 'es'}|${item.target_language || 'en'}|${candidatesSorted}`;
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return `contextual_${hash}`;
  } catch {
    // Preserve the complete bounded request key material if WebCrypto is unavailable.
    return `contextual_${btoa(unescape(encodeURIComponent(raw)))}`;
  }
}

async function _evictDisambigCacheIfNeeded(expectedGeneration = authGeneration) {
  const DISAMBIG_CACHE_MAX = 2000;
  const DISAMBIG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  try {
    await _withSessionMutation(async () => {
      if (expectedGeneration !== authGeneration) return;
      const all = await browser.storage.local.get(null);
      const disambigKeys = Object.keys(all).filter(k => k.startsWith('disambig_'));

    // Remove expired entries
    const now = Date.now();
    const expired = disambigKeys.filter(k => {
      const entry = all[k];
      return entry && entry.cached_at && (now - entry.cached_at) > DISAMBIG_CACHE_TTL_MS;
    });
      if (expired.length > 0) await browser.storage.local.remove(expired);

    // LRU eviction if still over limit
    const remaining = disambigKeys.filter(k => !expired.includes(k));
      if (remaining.length > DISAMBIG_CACHE_MAX) {
        const sorted = remaining
          .map(k => ({ key: k, time: all[k]?.cached_at || 0 }))
          .sort((a, b) => a.time - b.time);
        const toRemove = sorted.slice(0, remaining.length - DISAMBIG_CACHE_MAX).map(e => e.key);
        await browser.storage.local.remove(toRemove);
      }
    });
  } catch {
    // Non-critical — eviction failure doesn't break functionality
  }
}

async function _evictContextualCacheIfNeeded(expectedGeneration = authGeneration) {
  const CACHE_MAX = 1000;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  try {
    await _withSessionMutation(async () => {
      if (expectedGeneration !== authGeneration) return;
      const all = await browser.storage.local.get(null);
      const keys = Object.keys(all).filter(key => key.startsWith('contextual_'));
      const now = Date.now();
      const expired = keys.filter(key => (
        all[key] && all[key].cached_at && (now - all[key].cached_at) > CACHE_TTL_MS
      ));
      if (expired.length > 0) await browser.storage.local.remove(expired);
      const remaining = keys.filter(key => !expired.includes(key));
      if (remaining.length > CACHE_MAX) {
        const toRemove = remaining
          .map(key => ({ key, time: all[key]?.cached_at || 0 }))
          .sort((a, b) => a.time - b.time)
          .slice(0, remaining.length - CACHE_MAX)
          .map(entry => entry.key);
        await browser.storage.local.remove(toRemove);
      }
    });
  } catch {
    // Cache cleanup is non-critical.
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
  browser.storage.local.get('extensionDeviceAuthorization').then(({ extensionDeviceAuthorization }) => {
    if (extensionDeviceAuthorization && extensionDeviceAuthorization.expiresAt > Date.now()) {
      openDeviceConnectionPage().catch(() => {});
    }
  });
});
