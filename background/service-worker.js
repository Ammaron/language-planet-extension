/* global browser, LangslyEncounterCoordinator, LangslyHosts */
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
  if (!globalThis.LangslySourceLanguage) {
    importScripts('../shared/source-language.js');
  }
  if (!globalThis.LangslyHosts) {
    importScripts('../shared/hosts.js');
  }
  if (!globalThis.LangslyTheme) {
    importScripts('theme-utils.js');
  }
  if (!globalThis.LangslyEncounterCoordinator) {
    importScripts('encounter-coordinator.js');
  }
  if (!globalThis.createDeviceConnection) importScripts('device-connection.js');
  if (!globalThis.LangslyHanziPractice) importScripts('hanzi-practice.js');
}

function t(key, substitutions, fallback) {
  if (globalThis.LangslyI18n) return globalThis.LangslyI18n.t(key, substitutions, fallback);
  if (fallback === undefined && typeof substitutions === 'string') return substitutions;
  return fallback || key;
}

// ─── Configurable API URLs ──────────────────────
const LEGACY_DEFAULTS = { apiBase: 'http://localhost:8000/api', frontendUrl: 'http://localhost:3000' };
const DEFAULTS = { apiBase: 'https://api.langsly.com/api', frontendUrl: 'https://langsly.com' };
// Every API request names this build (X-Langsly-Client: extension/<version>) so the
// backend can log which versions are still active and publish minimum versions.
const CLIENT_HEADER_VALUE = (() => {
  try {
    const version = browser.runtime.getManifest().version;
    return /^[0-9A-Za-z.+-]{1,32}$/.test(version) ? `extension/${version}` : 'extension/0';
  } catch {
    return 'extension/0';
  }
})();
function withClientHeader(headers) {
  return { ...(headers || {}), 'X-Langsly-Client': CLIENT_HEADER_VALUE };
}
// For requests that carry no session (device sign-in start/poll).
const apiFetch = (url, options = {}) => fetch(url, { ...options, headers: withClientHeader(options.headers) });
const MAX_EXTENSION_AUDIO_FETCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_EXTENSION_SOURCE_LANGUAGE = 'en';
const AUTO_BUDGET_WINDOW_MS = 60 * 1000;
const activeAuthControllers = new Set();
let authGeneration = 0;
const automaticBudgetBuckets = new Map();
let sourceGeneration = 0;
let vocabularySyncGeneration = 0;
let encounterCoordinator = null;
let hanziPractice = null;
let refreshPromise = null;
let refreshPromiseGeneration = -1;
let sessionMutationTail = Promise.resolve();

function _withSessionMutation(task) {
  const result = sessionMutationTail.then(task, task);
  sessionMutationTail = result.catch(() => {});
  return result;
}

function _setSessionStorage(values, expectedGeneration = authGeneration, expectedSourceGeneration = null, expectedSyncGeneration = null) {
  return _withSessionMutation(async () => {
    if (expectedGeneration !== authGeneration) return false;
    if (expectedSourceGeneration !== null && expectedSourceGeneration !== sourceGeneration) return false;
    if (expectedSyncGeneration !== null && expectedSyncGeneration !== vocabularySyncGeneration) return false;
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

// storage.local is readable and writable by content scripts, so a stored endpoint
// is only honoured when it points at Langsly over https. Anything else falls back
// to the production default, so a compromised page cannot redirect token refreshes.
const ALLOWED_CONFIG_HOSTS = new Set(['langsly.com', 'www.langsly.com', 'api.langsly.com']);
function isAllowedConfigUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_CONFIG_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

function resolveConfigValue(value, fallback) {
  const normalized = normalizeUrl(value);
  const normalizedLegacy = normalizeUrl(LEGACY_DEFAULTS[fallback]);
  if (!normalized || normalized === normalizedLegacy || !isAllowedConfigUrl(normalized)) return DEFAULTS[fallback];
  return normalized;
}

// Popup, options, onboarding and connect pages; never a content script on a site.
const EXTENSION_PAGE_ONLY_MESSAGES = new Set([
  'LOGOUT', 'SYNC_NOW', 'SET_DIFFICULTY', 'UPDATE_CONFIG', 'TOGGLE_WHITELIST', 'GET_STATUS',
  'APPLY_THEME', 'SYNC_THEMES',
]);
function isExtensionPage(sender) {
  if (!sender || (sender.id && sender.id !== browser.runtime.id)) return false;
  const base = browser.runtime.getURL('');
  return typeof sender.url === 'string' && sender.url.startsWith(base);
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
    if (hanziPractice) await hanziPractice.clear();
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
    'hanziPracticeQueue',
    'extensionDeviceAuthorization',
    'extensionSourceLanguage',
    'pageTextLanguage',
    'subscriptionRequired',
    'vocabPassPlan',
    'accountEmail',
    'pausedSites',
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
  await deviceConnection.cancel();
  await clearTokens();
  await broadcastAuthCleared();
}

function normalizeLanguageCode(value) {
  return globalThis.LangslySourceLanguage.resolve(value);
}

async function getExtensionSourceLanguage() {
  const { extensionSourceLanguage } = await browser.storage.local.get('extensionSourceLanguage');
  const resolved = normalizeLanguageCode(extensionSourceLanguage);
  return resolved === null ? null : resolved || DEFAULT_EXTENSION_SOURCE_LANGUAGE;
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

// The language of the page text the synced words can match, e.g. "es" when
// Spanish triggers reveal English terms. Shown in the popup instead of the
// request parameter, which does not describe the triggers.
function dominantPageTextLanguage(words, fallback) {
  const counts = new Map();
  for (const word of Array.isArray(words) ? words : []) {
    const code = normalizeLanguageCode(word && word.search_language);
    if (code) counts.set(code, (counts.get(code) || 0) + 1);
  }
  let best = '';
  for (const [code, count] of counts) {
    if (!best || count > counts.get(best)) best = code;
  }
  return best || fallback;
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

async function completeLoginWithTokens(data, isCurrent = () => true) {
  if (!data || !data.access) {
    return { success: false, error: t('unexpectedServerResponse', 'Unexpected server response') };
  }

  const generation = authGeneration;
  const saved = await _withSessionMutation(async () => {
    if (generation !== authGeneration || !isCurrent()) return false;
    // A device approval can switch learners without a preceding logout.
    // Invalidate old validation responses and remove account-owned page state
    // before exposing the new credentials to background requests.
    authGeneration += 1;
    for (const controller of activeAuthControllers) controller.abort();
    activeAuthControllers.clear();
    automaticBudgetBuckets.clear();
    if (encounterCoordinator) await encounterCoordinator.clear();
    if (hanziPractice) await hanziPractice.clear();
    const all = await browser.storage.local.get(null);
    const cacheKeys = Object.keys(all).filter(key => (
      key.startsWith('phrase_') || key.startsWith('disambig_') || key.startsWith('contextual_')
    ));
    await browser.storage.local.remove([
      'vocabWords', 'lastSync', 'wordCount', 'matchableWordCount',
      'pendingEncounters', 'hanziPracticeQueue', 'rotation_salt', 'difficulty',
      'themePacks', 'activeThemeSlug', 'activeThemeName', 'themeTokens',
      'themeSyncStatus', 'extensionSourceLanguage', 'pageTextLanguage', 'pausedSites', ...cacheKeys,
    ]);
    await browser.storage.local.set({ authToken: data.access, refreshToken: data.refresh });
    return authGeneration;
  });
  if (!saved) return { success: false, error: 'cancelled' };
  await broadcastAuthCleared();
  await _ensureRotationSalt(saved);
  await _withSessionMutation(async () => {
    if (saved === authGeneration) await browser.storage.local.set({ syncStatus: 'success' });
  });
  void Promise.allSettled([syncVocabulary(), syncThemes()]);
  return saved === authGeneration ? { success: true } : { success: false, error: 'cancelled' };
}

async function broadcastVocabulary(words, isCurrent = () => true) {
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (!isCurrent()) return;
    if (tab.id) {
      browser.tabs.sendMessage(tab.id, { type: 'VOCAB_UPDATED', words }).catch(() => {});
    }
  }
}

const deviceConnection = globalThis.createDeviceConnection({ browser, fetch: apiFetch, getConfig, complete: completeLoginWithTokens });

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

function getJwtExpirationMs(token) {
  try {
    const encodedPayload = String(token || '').split('.')[1];
    if (!encodedPayload) return 0;
    const base64 = encodedPayload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const expirationSeconds = Number(JSON.parse(atob(padded)).exp);
    return Number.isFinite(expirationSeconds) ? expirationSeconds * 1000 : 0;
  } catch {
    return 0;
  }
}

function isAccessTokenFresh(token, now = Date.now()) {
  const expiresAt = getJwtExpirationMs(token);
  return Boolean(expiresAt && expiresAt > now + 60_000);
}

async function ensureAccessToken() {
  const { access, refresh } = await getTokens();
  if (access && isAccessTokenFresh(access)) return access;
  if (!refresh) return access || null;
  return refreshAccessToken();
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
      headers: withClientHeader({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ refresh }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Only an authentication rejection proves this session is no longer valid.
      // Keep the rotating refresh token through rate limits and server outages so
      // a temporary backend problem never turns into an unnecessary sign-in.
      if ([401, 403].includes(res.status) && generation === authGeneration) {
        await clearSession();
      }
      return null;
    }
    const data = await res.json();
    if (generation !== authGeneration) return null;
    if (!await setTokens(data.access, data.refresh || refresh, generation)) return null;
    return data.access;
  } catch (error) {
    if (!controller.signal.aborted) console.warn('[Langsly] token refresh failed', error);
    return null;
  } finally {
    activeAuthControllers.delete(controller);
  }
}

async function authFetch(url, options = {}) {
  const snapshot = await _getSessionSnapshot();
  let { access } = snapshot;
  if (!access || !isAccessTokenFresh(access)) {
    access = await ensureAccessToken();
  }
  if (!access) return null;
  const { generation } = snapshot;
  const controller = new AbortController();
  activeAuthControllers.add(controller);
  // A caller's own deadline (options.signal) aborts the same request.
  const linkDeadline = target => {
    const deadline = options.signal;
    if (!deadline) return;
    if (deadline.aborted) target.abort();
    else deadline.addEventListener('abort', () => target.abort(), { once: true });
  };
  linkDeadline(controller);

  if (generation !== authGeneration) {
    activeAuthControllers.delete(controller);
    controller.abort();
    return null;
  }

  const headers = withClientHeader({ ...options.headers, Authorization: `Bearer ${access}` });
  let res;
  try {
    res = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) console.warn('[Langsly] API request failed', error);
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
    linkDeadline(retryController);
    try {
      res = await fetch(url, { ...options, headers, signal: retryController.signal });
    } catch (error) {
      if (!retryController.signal.aborted) console.warn('[Langsly] API retry after refresh failed', error);
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
  const [userRes, themesRes, planRes] = await Promise.all([
    authFetch(`${apiBase}/users/current/`),
    authFetch(`${apiBase}/users/themes/`),
    // Plan status is shown in Settings; a failure here never blocks themes.
    authFetch(`${apiBase}/users/billing/vocab-pass/`).catch(() => null),
  ]);

  if (planRes && planRes.ok && generation === authGeneration) {
    try {
      const plan = await planRes.json();
      await _setSessionStorage({ vocabPassPlan: normalizePlan(plan) }, generation);
    } catch {
      // Keep whatever plan status was stored last.
    }
  }

  if (!userRes || !themesRes || !userRes.ok || !themesRes.ok) {
    const currentState = await getStoredThemeState();
    const stored = await _setSessionStorage({ themeSyncStatus: 'failed' }, generation);
    return stored ? { ...currentState, themeSyncStatus: 'failed' } : currentState;
  }

  const currentUser = await userRes.json();
  const themePacks = await themesRes.json();
  if (generation !== authGeneration) return getStoredThemeState();
  const accountEmail = currentUser && typeof currentUser.email === 'string' ? currentUser.email : '';
  await _setSessionStorage({ accountEmail }, generation);
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

async function failVocabularySync(sourceLanguage, generation, sourceRevision, syncRevision) {
  if (sourceLanguage !== 'zh') {
    // Cached English/Spanish words stay usable through a transient failure, but
    // Chinese targets need a fresh, reviewed sync: purge them from storage and pages.
    const { vocabWords } = await browser.storage.local.get('vocabWords');
    const cached = Array.isArray(vocabWords) ? vocabWords : [];
    const kept = withoutChineseTargets(cached);
    if (kept.length === cached.length) {
      await _setSessionStorage({ syncStatus: 'failed' }, generation, sourceRevision, syncRevision);
      return;
    }
    const stored = await _setSessionStorage({
      vocabWords: kept, wordCount: kept.length, matchableWordCount: countMatchableWords(kept), syncStatus: 'failed',
    }, generation, sourceRevision, syncRevision);
    if (stored && sourceRevision === sourceGeneration && syncRevision === vocabularySyncGeneration) {
      await broadcastVocabulary(kept, () => generation === authGeneration
        && sourceRevision === sourceGeneration && syncRevision === vocabularySyncGeneration);
    }
    return;
  }
  // A failed Chinese refresh cannot confirm that the old reviewed source
  // forms are still eligible. Remove them from storage and active pages.
  const stored = await _setSessionStorage({
    vocabWords: [], wordCount: 0, matchableWordCount: 0,
    lastSync: null, syncStatus: 'failed', extensionSourceLanguage: 'zh',
  }, generation, sourceRevision, syncRevision);
  if (stored && sourceRevision === sourceGeneration && syncRevision === vocabularySyncGeneration) {
    await broadcastVocabulary([], () => generation === authGeneration
      && sourceRevision === sourceGeneration && syncRevision === vocabularySyncGeneration);
  }
}

// Chinese as a target (English pages) is gated server-side by a switch, this
// capability and a per-user allowlist. Older builds never send it.
const ZH_TARGET_CAPABILITY = 'zh_target_v1';

// ─── Validation responses ──────────────────────
// A validation call is abandoned (and the request aborted) at this deadline.
const VALIDATION_DEADLINE_MS = 8000;
const RETRY_AFTER_DEFAULT_MS = 60_000;
const RETRY_AFTER_MAX_MS = 600_000;

// Milliseconds the server asked us to wait (429 Retry-After: seconds or an
// HTTP date); one minute when the header is missing or unreadable.
function _retryAfterMs(res) {
  const header = String(res?.headers?.get?.('Retry-After') || '').trim();
  let ms = 0;
  if (/^\d+$/.test(header)) ms = Number(header) * 1000;
  else if (header) ms = Date.parse(header) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) ms = RETRY_AFTER_DEFAULT_MS;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

// The field names a 400 body complains about ("items[3].match_offset"), for
// the console only. Never the messages, never the text that was sent.
async function _responseErrorFields(res) {
  let body;
  try {
    body = await res.json();
  } catch {
    return [];
  }
  const fields = [];
  const walk = (value, path) => {
    if (fields.length >= 40) return;
    if (Array.isArray(value)) {
      if (value.every(entry => typeof entry === 'string')) {
        if (path) fields.push(path);
        return;
      }
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walk(entry, path ? `${path}.${key}` : key);
    } else if (path) {
      fields.push(path);
    }
  };
  walk(body, '');
  return fields;
}

function withoutChineseTargets(words) {
  return words.filter(word => !globalThis.LangslySourceLanguage.isChineseTargetWord(word));
}

// Keep a Chinese target row only when the server says the gate is open for this
// client and the row carries complete reviewed data; drop it otherwise.
function readyVocabularyRows(words, data) {
  const source = globalThis.LangslySourceLanguage;
  const zhTargetEnabled = !!data && data.zh_target_enabled === true;
  return words.filter(word => !source.isChineseTargetWord(word)
    || (zhTargetEnabled && source.isReadyChineseTargetRow(word)));
}

// Key-order independent: browser.storage hands objects back with sorted keys.
function _stableJson(value) {
  return JSON.stringify(value, (key, entry) => (entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]]))
    : entry));
}

function _resetAutomaticBudget(type) {
  for (const key of [...automaticBudgetBuckets.keys()]) {
    if (key.endsWith(`:${type}`)) automaticBudgetBuckets.delete(key);
  }
}

async function syncVocabulary() {
  const generation = authGeneration;
  const sourceRevision = sourceGeneration;
  const syncRevision = ++vocabularySyncGeneration;
  const { access } = await getTokens();
  const sourceLanguage = await getExtensionSourceLanguage();
  if (!access) {
    if (sourceLanguage === 'zh') await failVocabularySync(sourceLanguage, generation, sourceRevision, syncRevision);
    return;
  }
  const { apiBase } = await getConfig();
  const { difficulty } = await browser.storage.local.get('difficulty');
  const level = difficulty || 'normal';
  if (sourceLanguage === null) {
    const stored = await _setSessionStorage({
      vocabWords: [], wordCount: 0, matchableWordCount: 0,
      lastSync: null, syncStatus: 'unsupported_locale',
    }, generation, sourceRevision, syncRevision);
    if (stored && sourceRevision === sourceGeneration && syncRevision === vocabularySyncGeneration) {
      await broadcastVocabulary([], () => generation === authGeneration
        && sourceRevision === sourceGeneration && syncRevision === vocabularySyncGeneration);
    }
    return;
  }

  let data;
  try {
    const res = await authFetch(`${apiBase}/lessons/vocabpass/words/?difficulty=${level}&source_language=${encodeURIComponent(sourceLanguage)}&validation_version=3&capabilities=${ZH_TARGET_CAPABILITY}`);
    if (await isSubscriptionRequiredResponse(res)) {
      await applySubscriptionRequired(generation);
      return;
    }
    if (!res || !res.ok) {
      await failVocabularySync(sourceLanguage, generation, sourceRevision, syncRevision);
      return;
    }
    data = await res.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      await failVocabularySync(sourceLanguage, generation, sourceRevision, syncRevision);
      return;
    }
  } catch (error) {
    console.warn('[Langsly] vocabulary sync failed', error);
    await failVocabularySync(sourceLanguage, generation, sourceRevision, syncRevision);
    return;
  }
  if (generation !== authGeneration || sourceRevision !== sourceGeneration || syncRevision !== vocabularySyncGeneration) return;
  if (sourceLanguage !== await getExtensionSourceLanguage()) return;
  const sourceReady = sourceLanguage === 'zh'
    ? globalThis.LangslySourceLanguage.isChineseVocabularyResponseReady(data)
    : data.source_language_ready !== false;
  const words = sourceReady && Array.isArray(data.words) ? readyVocabularyRows(data.words, data) : [];
  const matchableWordCount = countMatchableWords(words);
  const { vocabWords: previousWords } = await browser.storage.local.get('vocabWords');
  const vocabularyChanged = _stableJson(previousWords || []) !== _stableJson(words);
  const stored = await _setSessionStorage({
    vocabWords: words,
    lastSync: sourceReady ? new Date().toISOString() : null,
    wordCount: words.length,
    matchableWordCount,
    extensionSourceLanguage: sourceLanguage,
    pageTextLanguage: dominantPageTextLanguage(words, sourceLanguage),
    syncStatus: sourceReady ? 'success' : 'source_unavailable',
    subscriptionRequired: false,
  }, generation, sourceRevision, syncRevision);
  if (!stored) return;
  // Changed words make every page start over; let them validate again right
  // away instead of waiting out the previous scan's budget. Pages cannot
  // trigger a sync, so this does not loosen the per-page abuse limit.
  if (vocabularyChanged) _resetAutomaticBudget('disambiguate');

  if (sourceRevision === sourceGeneration && syncRevision === vocabularySyncGeneration) {
    await broadcastVocabulary(words, () => generation === authGeneration
      && sourceRevision === sourceGeneration && syncRevision === vocabularySyncGeneration);
  }
}

// ─── Vocab Pass subscription (HTTP 402 from the paywall) ─────
const SUBSCRIPTION_REQUIRED_CODE = 'vocab_pass_subscription_required';

// The subset of /users/billing/vocab-pass/ that Settings shows. Nothing here
// is a secret, but keep it small so a stale copy cannot mislead.
function normalizePlan(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    hasAccess: Boolean(source.has_access),
    status: typeof source.status === 'string' ? source.status : null,
    source: typeof source.source === 'string' ? source.source : null,
    currentPeriodEnd: typeof source.current_period_end === 'string' ? source.current_period_end : null,
    cancelAtPeriodEnd: Boolean(source.cancel_at_period_end),
    priceDisplay: typeof source.price_display === 'string' ? source.price_display : '',
  };
}

async function isSubscriptionRequiredResponse(res) {
  if (!res || res.status !== 402) return false;
  try {
    const body = await res.clone().json();
    return Boolean(body && body.code === SUBSCRIPTION_REQUIRED_CODE);
  } catch {
    return false;
  }
}

async function getSubscribeUrl() {
  const { frontendUrl } = await getConfig();
  return `${frontendUrl}/vocab-pass/subscribe`;
}

// Stop page processing and drop cached vocabulary (as logout does for words)
// while keeping the account connected, so the next sync can recheck access.
async function applySubscriptionRequired(generation) {
  if (generation !== authGeneration) return;
  const all = await browser.storage.local.get(null);
  const cacheKeys = Object.keys(all).filter(key => (
    key.startsWith('phrase_') || key.startsWith('disambig_') || key.startsWith('contextual_')
  ));
  await _withSessionMutation(async () => {
    if (generation !== authGeneration) return;
    await browser.storage.local.remove(['vocabWords', 'wordCount', 'matchableWordCount', ...cacheKeys]);
    await browser.storage.local.set({ syncStatus: 'subscription_required', subscriptionRequired: true });
  });
  if (generation !== authGeneration) return;
  const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.allSettled(tabs
    .filter((tab) => tab.id)
    .map((tab) => browser.tabs.sendMessage(tab.id, { type: 'SUBSCRIPTION_REQUIRED' })));
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
    const res = await authFetch(`${apiBase}/lessons/vocabpass/encounters/batch/?capabilities=${ZH_TARGET_CAPABILITY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encounters }),
    });
    return !!(res && res.ok);
  },
});

// ─── Character-writing practice (optional; the server's extension switch gates it) ──
hanziPractice = LangslyHanziPractice.create({
  storage: browser.storage.local,
  fetchPackaged: async (packagedPath) => {
    const res = await fetch(browser.runtime.getURL(packagedPath));
    if (!res.ok) throw new Error('packaged_file_missing');
    return res.arrayBuffer();
  },
  digestHex: async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join(''),
  send: async (summary) => {
    const { access } = await getTokens();
    if (!access) return 0;
    const { apiBase } = await getConfig();
    const res = await authFetch(`${apiBase}/lessons/hanzi-writing/vocabulary-practice/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(summary),
    });
    return res ? res.status : 0;
  },
});

function isOwnContentScript(sender) {
  return !!(sender && sender.id === browser.runtime.id && sender.tab && typeof sender.tab.id === 'number');
}

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

// ─── Paused sites ("whitelist") ─────────────────
// Cached in storage.local so page loads and post-sync re-inits do not refetch it.
// The content script treats an unknown list (never fetched, API unreachable) as
// paused, so a site the learner paused is never processed because of an outage.
const PAUSED_SITES_TTL_MS = 10 * 60 * 1000;
let pausedSitesRequest = null;

function _pausedSitesAnswer(cache, extra = {}) {
  const domains = cache && Array.isArray(cache.domains) ? cache.domains : [];
  return { domains, entries: domains.map(domain => ({ domain })), known: Boolean(cache && Array.isArray(cache.domains)), ...extra };
}

async function _fetchPausedSites() {
  const generation = authGeneration;
  const { apiBase } = await getConfig();
  const res = await authFetch(`${apiBase}/lessons/vocabpass/whitelist/`);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!Array.isArray(data)) return null;
  const cache = {
    domains: data.map(entry => LangslyHosts.normalizeHost(entry && entry.domain)).filter(Boolean),
    fetchedAt: Date.now(),
  };
  if (!await _setSessionStorage({ pausedSites: cache }, generation)) return null;
  return { cache, entries: data };
}

async function getPausedSites({ refresh = false } = {}) {
  const { pausedSites } = await browser.storage.local.get('pausedSites');
  const fresh = pausedSites && Number.isFinite(pausedSites.fetchedAt)
    && Date.now() - pausedSites.fetchedAt < PAUSED_SITES_TTL_MS;
  if (fresh && !refresh) return _pausedSitesAnswer(pausedSites);
  if (!pausedSitesRequest) {
    pausedSitesRequest = _fetchPausedSites()
      .catch(() => null)
      .finally(() => { pausedSitesRequest = null; });
  }
  const fetched = await pausedSitesRequest;
  if (fetched) return { ..._pausedSitesAnswer(fetched.cache), entries: fetched.entries };
  return _pausedSitesAnswer(pausedSites, { stale: true });
}

async function togglePausedSite(rawDomain, pause) {
  const domain = LangslyHosts.normalizeHost(rawDomain);
  if (!domain || !/^[a-z0-9.-]{1,253}$/.test(domain)) return { success: false, error: 'invalid_domain' };
  const { apiBase } = await getConfig();
  let ok = true;
  if (pause) {
    const res = await authFetch(`${apiBase}/lessons/vocabpass/whitelist/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    ok = Boolean(res && res.ok);
  } else {
    // Remove every entry that pauses this host (the entry itself or a parent
    // domain) so the learner can re-enable a site from the popup toggle.
    const listRes = await authFetch(`${apiBase}/lessons/vocabpass/whitelist/`);
    const entries = listRes && listRes.ok ? await listRes.json().catch(() => null) : null;
    if (!Array.isArray(entries)) {
      ok = false;
    } else {
      const toDelete = entries.filter(entry => entry && entry.id !== undefined
        && (LangslyHosts.hostMatchesDomain(domain, entry.domain) || LangslyHosts.hostMatchesDomain(entry.domain, domain)));
      const results = await Promise.all(toDelete.map(entry => authFetch(
        `${apiBase}/lessons/vocabpass/whitelist/${encodeURIComponent(entry.id)}/delete/`,
        { method: 'DELETE' },
      )));
      ok = results.every(res => res && (res.ok || res.status === 404));
    }
  }
  // Refresh the cache from the server either way so the popup shows the real state.
  const state = await getPausedSites({ refresh: true });
  const paused = state.known ? LangslyHosts.matchesAnyDomain(domain, state.domains) : null;
  return { success: ok && paused === pause, paused };
}

// ─── Sync scheduling ─────────────────────────────
// Automatic triggers share one in-flight sync and skip when the last one is recent.
// Difficulty, language and sign-in changes call syncVocabulary() directly, because
// they change what the sync must fetch.
const AUTOMATIC_SYNC_MIN_AGE_MS = 2 * 60 * 1000;
const AUDIO_REFRESH_MIN_AGE_MS = 10 * 60 * 1000;
let sharedVocabularySync = null;

function _lastSyncAgeMs(lastSync) {
  const at = Date.parse(lastSync || '');
  return Number.isFinite(at) ? Date.now() - at : Infinity;
}

async function requestVocabularySync({ maxAgeMs = 0 } = {}) {
  if (sharedVocabularySync) return sharedVocabularySync;
  if (maxAgeMs > 0) {
    const { lastSync, vocabSyncAttemptAt } = await browser.storage.local.get(['lastSync', 'vocabSyncAttemptAt']);
    const age = _lastSyncAgeMs(lastSync);
    if (age >= 0 && age < maxAgeMs) return undefined;
    // While the API is down, worker wakes must not turn into a request storm.
    const attemptAge = Date.now() - Number(vocabSyncAttemptAt || 0);
    if (attemptAge >= 0 && attemptAge < AUTOMATIC_SYNC_MIN_AGE_MS) return undefined;
    if (sharedVocabularySync) return sharedVocabularySync;
    await browser.storage.local.set({ vocabSyncAttemptAt: Date.now() });
  }
  sharedVocabularySync = Promise.resolve()
    .then(() => syncVocabulary())
    .finally(() => { sharedVocabularySync = null; });
  return sharedVocabularySync;
}

// ─── Alarms ──────────────────────────────────────
const MIN_SYNC_INTERVAL_MINUTES = 15;
const MAX_SYNC_INTERVAL_MINUTES = 24 * 60;
function normalizeSyncInterval(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 60;
  return Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.round(minutes)));
}

// alarms.create replaces an alarm and restarts its countdown, so recreating them on
// every worker wake meant an active browser never reached the hourly sync. Create
// only what is missing or whose period changed.
async function ensureAlarm(name, periodInMinutes) {
  const existing = await browser.alarms.get(name);
  if (existing && existing.periodInMinutes === periodInMinutes) return false;
  await browser.alarms.create(name, { periodInMinutes });
  return true;
}

async function setupAlarms() {
  const { syncInterval, authToken, refreshToken } = await browser.storage.local.get(['syncInterval', 'authToken', 'refreshToken']);
  const interval = normalizeSyncInterval(syncInterval);
  await ensureAlarm('vocab-sync', interval);
  await ensureAlarm('encounter-flush', 5);
  // Catch up at worker start when the scheduled sync is overdue.
  if (authToken || refreshToken) await requestVocabularySync({ maxAgeMs: interval * 60 * 1000 });
}

setupAlarms().catch(error => console.warn('[Langsly] alarm setup failed', error));
migrateLegacyConfig().catch(error => console.warn('[Langsly] config migration failed', error));

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'device-connection') void deviceConnection.resume();
  if (alarm.name === 'vocab-sync') {
    void requestVocabularySync({ maxAgeMs: AUTOMATIC_SYNC_MIN_AGE_MS });
    void syncThemes();
  }
  if (alarm.name === 'encounter-flush') {
    flushEncounters();
    void hanziPractice.flush();
  }
});

// ─── Message Handling ────────────────────────────
browser.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'DEVICE_CONNECTION_BRIDGE') return deviceConnection.bridge(message, sender);
  const connectionMessage = ['START_DEVICE_LOGIN', 'DEVICE_CONNECTION_BEGIN', 'DEVICE_CONNECTION_STATUS', 'DEVICE_CONNECTION_OPEN', 'DEVICE_CONNECTION_CANCEL', 'COMPLETE_DEVICE_LOGIN'].includes(message.type);
  if (connectionMessage && !(sender.url || '').startsWith(browser.runtime.getURL('popup/'))) return Promise.resolve({ success: false, error: 'untrusted_sender' });
  if (message.type === 'DEVICE_CONNECTION_BEGIN') return deviceConnection.begin(message.platform, message.locale, Boolean(message.restart));
  if (message.type === 'DEVICE_CONNECTION_STATUS') return deviceConnection.status();
  if (message.type === 'DEVICE_CONNECTION_OPEN') return deviceConnection.openApproval();
  if (message.type === 'DEVICE_CONNECTION_CANCEL') return deviceConnection.cancel().then(() => ({ status: 'idle' }));
  if (message.type === 'START_DEVICE_LOGIN') {
    return (async () => {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const returnTab = tabs.find(tab => /^https?:/.test(tab.url || '') && !tab.url.startsWith(DEFAULTS.frontendUrl));
      await browser.storage.local.set({ connectionReturnTabId: returnTab?.id ?? null });
      return openDeviceConnectionPage();
    })();
  }

  if (message.type === 'COMPLETE_DEVICE_LOGIN') {
    return completeLoginWithTokens(message.tokens).then(async (result) => {
      if (result.success) await browser.storage.local.remove('extensionDeviceAuthorization');
      return result;
    });
  }

  // Account, settings and site-access changes come only from the extension's own
  // pages. Content scripts run on arbitrary sites and must not reach these.
  if (EXTENSION_PAGE_ONLY_MESSAGES.has(message.type) && !isExtensionPage(sender)) {
    return Promise.resolve({ success: false, error: 'untrusted_sender' });
  }

  if (message.type === 'LOGOUT') {
    return clearSession().then(() => ({ success: true }));
  }

  if (message.type === 'SYNC_NOW') {
    return Promise.allSettled([requestVocabularySync(), syncThemes()]).then(() => ({ success: true }));
  }

  if (message.type === 'SET_SOURCE_LANGUAGE') {
    if (sender.url !== browser.runtime.getURL('popup/options.html')) {
      return Promise.resolve({ success: false, error: 'untrusted_sender' });
    }
    return (async () => {
      const sourceLanguage = normalizeLanguageCode(message.sourceLanguage);
      if (!['en', 'es', 'zh'].includes(sourceLanguage)) {
        return { success: false, error: 'unsupported_source_language' };
      }
      const { extensionSourceLanguage: current } = await browser.storage.local.get('extensionSourceLanguage');
      // Unchanged language: nothing to refetch, and the cached words stay on every page.
      if (normalizeLanguageCode(current || DEFAULT_EXTENSION_SOURCE_LANGUAGE) === sourceLanguage) {
        return { success: true, unchanged: true };
      }
      const generation = authGeneration;
      const sourceRevision = ++sourceGeneration;
      // Chinese targets are never kept across a language switch; English/Spanish
      // words stay usable until the new language's words arrive (a failed sync
      // keeps them, like any other transient failure).
      const blank = sourceLanguage === 'zh' || normalizeLanguageCode(current) === 'zh';
      const stored = await _setSessionStorage({
        extensionSourceLanguage: sourceLanguage,
        ...(blank ? { vocabWords: [], wordCount: 0, matchableWordCount: 0, lastSync: null } : {}),
        syncStatus: 'syncing',
      }, generation, sourceRevision);
      if (!stored) return { success: false, error: 'cancelled' };
      if (sourceRevision !== sourceGeneration) return { success: false, error: 'cancelled' };
      if (blank) await broadcastVocabulary([], () => generation === authGeneration && sourceRevision === sourceGeneration);
      await syncVocabulary();
      return { success: generation === authGeneration };
    })();
  }

  if (message.type === 'HANZI_WRITER_LOAD') {
    if (!isOwnContentScript(sender) || !browser.scripting) return Promise.resolve({ success: false, error: 'unavailable' });
    // Injected only after the learner's explicit click, into the requesting
    // frame's isolated world. The file is packaged and hash-checked at build time.
    return browser.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId || 0] },
      files: [LangslyHanziPractice.LIBRARY_FILE],
    }).then(() => ({ success: true }), () => ({ success: false, error: 'inject_failed' }));
  }
  if (message.type === 'HANZI_CHARACTER_DATA') {
    if (!isOwnContentScript(sender)) return Promise.resolve({ success: false, error: 'untrusted_sender' });
    return hanziPractice.characterData(message).catch(() => ({ success: false, error: 'data_unavailable' }));
  }
  if (message.type === 'HANZI_PRACTICE_RECORD') {
    if (!isOwnContentScript(sender)) return Promise.resolve({ success: false, error: 'untrusted_sender' });
    return hanziPractice.record(message.summary).catch(() => ({ success: false, error: 'record_failed' }));
  }
  if (message.type === 'FETCH_AUDIO') {
    return fetchAudioAsDataUrl(message.url);
  }
  if (message.type === 'REFRESH_WORD_AUDIO') {
    if (!isOwnContentScript(sender)) return Promise.resolve({ success: false, error: 'untrusted_sender' });
    // A cached signed audio URL expired. Signatures outlive this window, so a sync
    // newer than it already carries a valid URL; Listen taps cost at most one
    // shared words request per window.
    return requestVocabularySync({ maxAgeMs: AUDIO_REFRESH_MIN_AGE_MS })
      .then(() => ({ success: true }), () => ({ success: false }));
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
      let stored = await browser.storage.local.get([
        'authToken',
        'refreshToken',
        'lastSync',
        'wordCount',
        'difficulty',
        'syncStatus',
        'extensionSourceLanguage',
    'pageTextLanguage',
        'matchableWordCount',
        'themePacks',
        'activeThemeSlug',
        'activeThemeName',
        'themeTokens',
        'themeSyncStatus',
        'subscriptionRequired',
        'vocabPassPlan',
        'accountEmail',
      ]);
      if (stored.refreshToken && (!stored.authToken || !isAccessTokenFresh(stored.authToken))) {
        await ensureAccessToken();
        stored = { ...stored, ...await browser.storage.local.get(['authToken', 'refreshToken', 'syncStatus']) };
      }
      const {
        authToken,
        refreshToken,
        lastSync,
        wordCount,
        difficulty,
        syncStatus,
        extensionSourceLanguage,
        pageTextLanguage,
        matchableWordCount,
        themePacks,
        activeThemeSlug,
        activeThemeName,
        themeTokens,
        themeSyncStatus,
        subscriptionRequired,
        vocabPassPlan,
        accountEmail,
      } = stored;
      return {
        subscriptionRequired: Boolean(subscriptionRequired),
        subscribeUrl: await getSubscribeUrl(),
        plan: vocabPassPlan && typeof vocabPassPlan === 'object' ? vocabPassPlan : null,
        accountEmail: typeof accountEmail === 'string' ? accountEmail : '',
        // Keep the account connected through offline/server failures when a
        // durable refresh credential still exists. Only explicit logout or a
        // confirmed 401/403 refresh rejection clears the session.
        isLoggedIn: !!(authToken || refreshToken),
        lastSync: lastSync || null,
        wordCount: wordCount || 0,
        difficulty: difficulty || 'normal',
        syncStatus: syncStatus || 'unknown',
        extensionSourceLanguage: extensionSourceLanguage || DEFAULT_EXTENSION_SOURCE_LANGUAGE,
        pageTextLanguage: pageTextLanguage || extensionSourceLanguage || DEFAULT_EXTENSION_SOURCE_LANGUAGE,
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
    return getPausedSites({ refresh: Boolean(message.refresh) && isExtensionPage(sender) });
  }

  if (message.type === 'TOGGLE_WHITELIST') {
    if (!isExtensionPage(sender)) return Promise.resolve({ success: false, error: 'untrusted_sender' });
    return togglePausedSite(message.domain, Boolean(message.add));
  }

  if (message.type === 'UPDATE_CONFIG') {
    return (async () => {
      // Endpoints are fixed in release builds; only the sync interval is settable.
      if (message.syncInterval === undefined) return { success: true, changed: false };
      const syncInterval = normalizeSyncInterval(message.syncInterval);
      const { syncInterval: stored } = await browser.storage.local.get('syncInterval');
      if (stored !== syncInterval) await browser.storage.local.set({ syncInterval });
      // Re-create the alarm only when its period actually changed.
      const changed = await ensureAlarm('vocab-sync', syncInterval);
      return { success: true, changed };
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
          // No language defaults: a missing pair is refused, never assumed Spanish.
          source_language: message.source_language || '',
          target_language: message.target_language || '',
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

  // ─── Versioned occurrence validation ──────────
  if (message.type === 'VALIDATE_REPLACEMENTS') {
    return (async () => {
      const generation = authGeneration;
      const items = Array.isArray(message.items) ? message.items.slice(0, 20) : [];
      if (!items.length || !_consumeAutomaticBudget(sender, 'disambiguate', items.length, 60, 300)) {
        return { results: [], error: 'quota_exceeded' };
      }
      try {
        const { apiBase } = await getConfig();
        const { difficulty, lastSync } = await browser.storage.local.get(['difficulty', 'lastSync']);
        const versions = [...new Set(items.map(item => item.validation_version))];
        if (versions.some(version => ![2, 3].includes(version))) return { results: [], error: 'unsupported_version' };
        const responses = await Promise.all(versions.map(async version => {
        // The deadline aborts the request itself: a late answer is never paid
        // for twice by a retry that overlaps it.
        const deadline = new AbortController();
        const res = await new Promise(resolve => {
          const timer = setTimeout(() => { deadline.abort(); resolve(null); }, VALIDATION_DEADLINE_MS);
          authFetch(`${apiBase}/lessons/vocabpass/disambiguate/?capabilities=${ZH_TARGET_CAPABILITY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ validation_version: version, difficulty: difficulty || 'normal', items: items.filter(item => item.validation_version === version) }),
            signal: deadline.signal,
          }).then(resolve, () => resolve(null)).finally(() => clearTimeout(timer));
        });
        if (!res || generation !== authGeneration) return { results: [], error: 'validator_unavailable' };
        // Rejected request (bad item, unsupported pair): final, no retry.
        if (res.status === 400) {
          console.warn('[Langsly] validation batch rejected', await _responseErrorFields(res));
          return { results: [], error: 'rejected' };
        }
        // Rate limited: come back when the server says, not before.
        if (res.status === 429) return { results: [], retryAfterMs: _retryAfterMs(res) };
        if (!res.ok) return { results: [], error: 'validator_unavailable' };
        const data = await res.json();
        const current = await browser.storage.local.get(['difficulty', 'lastSync']);
        if (generation !== authGeneration || data.validation_version !== version
          || (current.difficulty || 'normal') !== (difficulty || 'normal')
          || current.lastSync !== lastSync) return { results: [], error: 'cancelled' };
        return { results: Array.isArray(data.results) ? data.results : [] };
        }));
        const results = responses.flatMap(response => response.results || []);
        const retryAfterMs = Math.max(0, ...responses.map(response => response.retryAfterMs || 0));
        if (retryAfterMs > 0) return { results, retryAfterMs };
        if (responses.some(response => response.error === 'rejected')) return { results, error: 'rejected' };
        const error = results.length ? null : responses.find(response => response.error)?.error;
        return error ? { results, error } : { results };
      } catch {
        return { results: [], error: 'validator_unavailable' };
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
        const res = await authFetch(`${apiBase}/lessons/vocabpass/disambiguate/feedback/?capabilities=${ZH_TARGET_CAPABILITY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sentence: message.sentence || '',
            matched_text: message.matched_text || '',
            match_offset: message.match_offset || 0,
            candidate_ids: message.candidate_ids || [],
            source_language: message.source_language || '',
            target_language: message.target_language || '',
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
  const raw = `${item.sentence || ''}|${item.matched_text || ''}|${item.match_offset || 0}|${item.source_language || ''}|${item.target_language || ''}|${candidatesSorted}`;
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
const INSTALL_DEFAULTS = { pendingEncounters: [], difficulty: 'normal', syncStatus: 'unknown' };

// Updates and browser updates keep queued encounters and the learner's difficulty;
// defaults are only written on first install, and only for keys that are missing.
async function handleInstalled(details) {
  if (details?.reason === 'update') {
    // Keep the learner's queue and words: send what is waiting and refresh.
    await Promise.allSettled([flushEncounters(), requestVocabularySync()]);
    return;
  }
  if (details?.reason !== 'install') return;
  const existing = await browser.storage.local.get(Object.keys(INSTALL_DEFAULTS));
  const missing = Object.fromEntries(Object.entries(INSTALL_DEFAULTS).filter(([key]) => existing[key] === undefined));
  if (Object.keys(missing).length) await browser.storage.local.set(missing);
  // Open onboarding page on first install
  await browser.tabs.create({ url: browser.runtime.getURL('popup/onboarding.html') });
}

browser.runtime.onInstalled.addListener((details) => {
  handleInstalled(details).catch(error => console.warn('[Langsly] install setup failed', error));
});

browser.runtime.onStartup.addListener(() => {
  _ensureRotationSalt();
  ensureAccessToken().catch(error => console.warn('[Langsly] startup token check failed', error));
  void requestVocabularySync({ maxAgeMs: AUTOMATIC_SYNC_MIN_AGE_MS });
  void syncThemes();
  void deviceConnection.resume();
});

// Runs whenever the background event page/service worker is recreated.
void deviceConnection.resume();
