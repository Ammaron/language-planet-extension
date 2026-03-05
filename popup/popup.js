/* global browser */
const loginView = document.getElementById('login-view');
const settingsView = document.getElementById('settings-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const syncBtn = document.getElementById('sync-btn');
const wordCountEl = document.getElementById('word-count');
const lastSyncEl = document.getElementById('last-sync');
const currentDomainEl = document.getElementById('current-domain');
const siteToggle = document.getElementById('site-toggle');
const openVocabpass = document.getElementById('open-vocabpass');
const diffBtns = document.querySelectorAll('.diff-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusBanner = document.getElementById('status-banner');

// ─── View Management ─────────────────────────
function showLogin() {
  loginView.classList.remove('hidden');
  settingsView.classList.add('hidden');
}

function showSettings() {
  loginView.classList.add('hidden');
  settingsView.classList.remove('hidden');
}

// ─── Init ────────────────────────────────────
async function init() {
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });

  if (!status.isLoggedIn) {
    showLogin();
    return;
  }

  showSettings();
  updateStatus(status);

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
      currentDomainEl.textContent = 'N/A';
    }
  }
}

function updateStatus(status) {
  wordCountEl.textContent = status.wordCount || 0;

  if (status.lastSync) {
    const syncDate = new Date(status.lastSync);
    lastSyncEl.textContent = syncDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    // Check for stale data (>24h)
    const hoursSinceSync = (Date.now() - syncDate.getTime()) / (1000 * 60 * 60);
    if (hoursSinceSync > 24 && statusBanner) {
      statusBanner.textContent = 'Data may be stale — last synced over 24h ago';
      statusBanner.className = 'status-banner warning';
      statusBanner.classList.remove('hidden');
    }
  } else {
    lastSyncEl.textContent = '\u2014';
  }

  // Update difficulty buttons
  diffBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.level === (status.difficulty || 'normal'));
  });

  // Connection health indicator
  if (statusIndicator) {
    if (status.syncStatus === 'success') {
      statusIndicator.className = 'status-dot connected';
      statusIndicator.title = 'Connected';
    } else if (status.syncStatus === 'offline') {
      statusIndicator.className = 'status-dot offline';
      statusIndicator.title = 'Offline';
      if (statusBanner) {
        statusBanner.textContent = 'Offline — using cached vocabulary';
        statusBanner.className = 'status-banner offline';
        statusBanner.classList.remove('hidden');
      }
    } else if (status.syncStatus === 'failed') {
      statusIndicator.className = 'status-dot error';
      statusIndicator.title = 'Sync failed';
    } else {
      statusIndicator.className = 'status-dot unknown';
      statusIndicator.title = 'Unknown';
    }
  }
}

// ─── Login ───────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in...';

  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  const response = await browser.runtime.sendMessage({ type: 'LOGIN', email, password });

  if (response.success) {
    const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
    showSettings();
    updateStatus(status);
  } else {
    loginError.textContent = response.error || 'Login failed';
    loginError.classList.remove('hidden');
  }

  loginBtn.disabled = false;
  loginBtn.textContent = 'Log In';
});

// ─── Logout ──────────────────────────────────
logoutBtn.addEventListener('click', async () => {
  await browser.runtime.sendMessage({ type: 'LOGOUT' });
  showLogin();
});

// ─── Sync ────────────────────────────────────
syncBtn.addEventListener('click', async () => {
  syncBtn.textContent = 'Syncing...';
  syncBtn.disabled = true;

  await browser.runtime.sendMessage({ type: 'SYNC_NOW' });
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
  updateStatus(status);

  syncBtn.textContent = 'Sync Now';
  syncBtn.disabled = false;
});

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
  if (!domain || domain === 'N/A') return;

  if (!siteToggle.checked) {
    // Add to whitelist (disable on this site)
    await browser.runtime.sendMessage({ type: 'TOGGLE_WHITELIST', domain, add: true });
  } else {
    // Remove from whitelist (re-enable on this site)
    await browser.runtime.sendMessage({ type: 'TOGGLE_WHITELIST', domain, add: false });
  }

  // Force immediate refresh of word list and page processing state.
  await browser.runtime.sendMessage({ type: 'SYNC_NOW' });
  const status = await browser.runtime.sendMessage({ type: 'GET_STATUS' });
  updateStatus(status);

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id) {
    await browser.tabs.reload(tab.id);
  }
});

// ─── Open Dashboard ──────────────────────────
openVocabpass.addEventListener('click', async (e) => {
  e.preventDefault();
  const { frontendUrl } = await browser.storage.local.get('frontendUrl');
  const url = frontendUrl || 'http://localhost:3000';
  browser.tabs.create({ url: `${url}/vocab-pass` });
});

// ─── Start ───────────────────────────────────
init();
