/* global browser */
try {
  importScripts('../vendor/browser-polyfill.min.js');
} catch {
  // Polyfill already available (Firefox background scripts load it via manifest)
}

// ─── Configurable API URLs ──────────────────────
const DEFAULTS = { apiBase: 'http://localhost:8080/api', frontendUrl: 'http://localhost:3000' };

async function getConfig() {
  const { apiBase, frontendUrl } = await browser.storage.local.get(['apiBase', 'frontendUrl']);
  return {
    apiBase: apiBase || DEFAULTS.apiBase,
    frontendUrl: frontendUrl || DEFAULTS.frontendUrl,
  };
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
  await browser.storage.local.remove(['authToken', 'refreshToken', 'vocabWords', 'lastSync', 'difficulty']);
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

// ─── Vocabulary Sync ─────────────────────────────
async function syncVocabulary() {
  const { apiBase } = await getConfig();
  const { difficulty } = await browser.storage.local.get('difficulty');
  const level = difficulty || 'normal';

  const res = await authFetch(`${apiBase}/lessons/vocabpass/words/?difficulty=${level}`);
  if (!res) {
    await browser.storage.local.set({ syncStatus: 'failed' });
    return;
  }
  if (!res.ok) {
    await browser.storage.local.set({ syncStatus: 'failed' });
    return;
  }

  const data = await res.json();
  await browser.storage.local.set({
    vocabWords: data.words,
    lastSync: new Date().toISOString(),
    wordCount: data.count,
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

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'vocab-sync') syncVocabulary();
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
          let errorMsg = 'Login failed';
          try {
            const data = await res.json();
            errorMsg = data.detail || 'Invalid email or password';
          } catch { /* use default */ }
          return { success: false, error: errorMsg };
        }

        const data = await res.json();
        if (data.access) {
          await setTokens(data.access, data.refresh);
          await browser.storage.local.set({ syncStatus: 'success' });
          await syncVocabulary();
          return { success: true };
        }
        return { success: false, error: 'Unexpected server response' };
      } catch (err) {
        const isConnectionRefused = err.message && (
          err.message.includes('Failed to fetch') ||
          err.message.includes('NetworkError') ||
          err.message.includes('Network request failed')
        );
        if (isConnectionRefused) {
          await browser.storage.local.set({ syncStatus: 'offline' });
          return { success: false, error: 'Cannot reach server. Check your connection or server URL in options.' };
        }
        return { success: false, error: `Network error: ${err.message}` };
      }
    })();
  }

  if (message.type === 'LOGOUT') {
    return clearTokens().then(() => ({ success: true }));
  }

  if (message.type === 'SYNC_NOW') {
    return syncVocabulary().then(() => ({ success: true }));
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
      const { authToken, lastSync, wordCount, difficulty, syncStatus } = await browser.storage.local.get([
        'authToken', 'lastSync', 'wordCount', 'difficulty', 'syncStatus',
      ]);
      return {
        isLoggedIn: !!authToken,
        lastSync: lastSync || null,
        wordCount: wordCount || 0,
        difficulty: difficulty || 'normal',
        syncStatus: syncStatus || 'unknown',
      };
    })();
  }

  if (message.type === 'GET_WHITELIST') {
    return (async () => {
      const { apiBase } = await getConfig();
      const res = await authFetch(`${apiBase}/lessons/vocabpass/whitelist/`);
      if (res && res.ok) {
        const data = await res.json();
        return { domains: data.map(d => d.domain) };
      }
      return { domains: [] };
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
});

// ─── Install / Startup ──────────────────────────
browser.runtime.onInstalled.addListener((details) => {
  browser.storage.local.set({ pendingEncounters: [], difficulty: 'normal', syncStatus: 'unknown' });

  // Open onboarding page on first install
  if (details.reason === 'install') {
    browser.tabs.create({ url: browser.runtime.getURL('popup/onboarding.html') });
  }
});

browser.runtime.onStartup.addListener(() => {
  syncVocabulary();
});
