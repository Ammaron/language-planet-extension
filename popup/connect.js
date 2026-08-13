/* global browser */
const views = {
  loading: document.getElementById('loading-view'),
  pending: document.getElementById('pending-view'),
  success: document.getElementById('success-view'),
  error: document.getElementById('error-view'),
};
const codeOutput = document.getElementById('user-code');
const approvalUrl = document.getElementById('approval-url');
const copyApprovalUrl = document.getElementById('copy-approval-url');
const copyStatus = document.getElementById('copy-status');
const pendingMessage = document.getElementById('pending-message');
const errorMessage = document.getElementById('error-message');
let pending = null;
let pollTimer = null;
let pollInFlight = false;
let connectionGeneration = 0;

function t(key, fallback) {
  if (window.LangslyI18n) return window.LangslyI18n.t(key, fallback);
  return fallback || key;
}

function cancelConnection() {
  connectionGeneration += 1;
  clearTimeout(pollTimer);
  pollTimer = null;
  pending = null;
  pollInFlight = false;
}

function show(name) {
  Object.entries(views).forEach(([key, element]) => element.classList.toggle('hidden', key !== name));
}

function detectPlatform() {
  const ua = navigator.userAgent || '';
  if (/Firefox/i.test(ua) && /Android/i.test(ua)) return 'firefox_android';
  if (/Firefox/i.test(ua)) return 'firefox_desktop';
  return 'chrome_desktop';
}

async function config() {
  const stored = await browser.storage.local.get(['apiBase', 'frontendUrl']);
  const apiBase = String(stored.apiBase || 'https://api.langsly.com/api').replace(/\/+$/, '');
  const frontendUrl = String(stored.frontendUrl || 'https://langsly.com').replace(/\/+$/, '');
  return { apiBase, frontendUrl };
}

function schedulePoll(delayMs) {
  clearTimeout(pollTimer);
  if (document.visibilityState !== 'visible' || !pending) return;
  pollTimer = setTimeout(() => void poll(), Math.max(0, delayMs));
}

async function openApproval() {
  if (!pending || !pending.verificationUriComplete) return;
  await browser.tabs.create({ url: pending.verificationUriComplete });
  pending.approvalOpened = true;
  await browser.storage.local.set({ extensionDeviceAuthorization: pending });
}

function getApprovalUrl() {
  if (pending && pending.verificationUri) return pending.verificationUri;
  if (pending && pending.verificationUriComplete) {
    try {
      const url = new URL(pending.verificationUriComplete);
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return pending.verificationUriComplete;
    }
  }
  return '';
}

async function copyComputerLink() {
  const url = getApprovalUrl();
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    copyStatus.textContent = t('connectUrlCopied', 'Computer link copied.');
  } catch {
    copyStatus.textContent = t('connectUrlCopyFallback', 'Press and hold the link to copy it.');
  }
}

async function start() {
  cancelConnection();
  copyStatus.textContent = '';
  const generation = connectionGeneration;
  show('loading');
  const stored = await browser.storage.local.get('extensionDeviceAuthorization');
  if (generation !== connectionGeneration) return;
  const existing = stored.extensionDeviceAuthorization;
  if (existing && existing.expiresAt > Date.now() && existing.deviceCode) {
    pending = existing;
    renderPending();
    schedulePoll(0);
    return;
  }
  await browser.storage.local.remove('extensionDeviceAuthorization');

  try {
    const { apiBase } = await config();
    const response = await fetch(`${apiBase}/auth/extension-device/start/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: detectPlatform(), locale: navigator.language || 'en' }),
    });
    const data = await response.json().catch(() => ({}));
    if (generation !== connectionGeneration) return;
    if (!response.ok) throw new Error(data.error_description || data.error || 'Could not start a secure connection.');
    pending = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      verificationUriComplete: data.verification_uri_complete,
      expiresAt: Date.now() + Number(data.expires_in || 600) * 1000,
      intervalMs: Number(data.interval || 5) * 1000,
      approvalOpened: false,
    };
    await browser.storage.local.set({ extensionDeviceAuthorization: pending });
    renderPending();
    await openApproval();
    schedulePoll(pending.intervalMs);
  } catch (error) {
    fail(error instanceof Error ? error.message : 'Could not start a secure connection.');
  }
}

function renderPending() {
  codeOutput.textContent = pending.userCode;
  const computerUrl = getApprovalUrl();
  approvalUrl.href = computerUrl;
  approvalUrl.textContent = computerUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  pendingMessage.textContent = navigator.onLine === false
    ? 'Offline. Vocab Pass will retry when the connection returns.'
    : 'Waiting for your explicit approval on Langsly…';
  show('pending');
}

function fail(message) {
  clearTimeout(pollTimer);
  errorMessage.textContent = message;
  show('error');
}

async function poll() {
  if (!pending || pollInFlight || document.visibilityState !== 'visible') return;
  if (pending.expiresAt <= Date.now()) {
    await browser.storage.local.remove('extensionDeviceAuthorization');
    pending = null;
    fail('This connection code expired. Start again to receive a new code.');
    return;
  }
  pollInFlight = true;
  const generation = connectionGeneration;
  try {
    const { apiBase } = await config();
    const response = await fetch(`${apiBase}/auth/extension-device/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: pending.deviceCode }),
    });
    const data = await response.json().catch(() => ({}));
    if (generation !== connectionGeneration || !pending) return;
    if (response.ok && data.access) {
      const completed = await browser.runtime.sendMessage({ type: 'COMPLETE_DEVICE_LOGIN', tokens: data });
      if (!completed || !completed.success) throw new Error((completed && completed.error) || 'Could not finish account connection.');
      pending = null;
      show('success');
      return;
    }
    if (data.error === 'authorization_pending') {
      renderPending();
    } else if (data.error === 'slow_down') {
      pending.intervalMs = Number(data.interval || 10) * 1000;
      await browser.storage.local.set({ extensionDeviceAuthorization: pending });
      pendingMessage.textContent = 'Still waiting for approval. Polling has been slowed for safety.';
    } else if (data.error === 'access_denied') {
      await browser.storage.local.remove('extensionDeviceAuthorization');
      pending = null;
      fail('The connection was denied.');
      return;
    } else if (data.error === 'expired_token') {
      await browser.storage.local.remove('extensionDeviceAuthorization');
      pending = null;
      fail('This connection code expired.');
      return;
    } else {
      pendingMessage.textContent = 'Network unavailable. Vocab Pass will retry while this tab is visible.';
    }
  } catch {
    if (pending) pendingMessage.textContent = 'Network unavailable. Vocab Pass will retry while this tab is visible.';
  } finally {
    if (generation !== connectionGeneration) return;
    pollInFlight = false;
    if (pending) schedulePoll(pending.intervalMs);
  }
}

document.getElementById('open-approval').addEventListener('click', () => void openApproval());
copyApprovalUrl.addEventListener('click', () => void copyComputerLink());
document.getElementById('cancel-connect').addEventListener('click', async () => {
  cancelConnection();
  await browser.storage.local.remove('extensionDeviceAuthorization');
  window.close();
});
document.getElementById('retry-connect').addEventListener('click', () => void start());
document.getElementById('close-connect').addEventListener('click', () => window.close());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') schedulePoll(0);
  else clearTimeout(pollTimer);
});
window.addEventListener('focus', () => schedulePoll(0));
window.addEventListener('online', () => schedulePoll(0));
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'AUTH_CLEARED') cancelConnection();
});

config().then(({ frontendUrl }) => {
  document.getElementById('privacy-link').href = `${frontendUrl}/privacy-policy`;
});
void start();
