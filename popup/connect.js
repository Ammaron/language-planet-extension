/* global browser */
const views = Object.fromEntries(['loading', 'pending', 'success', 'error'].map(name => [name, document.getElementById(`${name}-view`)]));
const t = (key, fallback) => window.LangslyI18n?.t(key, fallback) || fallback;
const send = (type, extra = {}) => browser.runtime.sendMessage({ type, ...extra });
let state;
let busy = false;
function show(name) {
  Object.entries(views).forEach(([key, node]) => node.classList.toggle('hidden', key !== name));
}
function render(next) {
  state = next;
  if (state.status === 'connected') { show('success'); return; }
  if (['expired', 'denied', 'idle', 'cancelled'].includes(state.status)) {
    document.getElementById('error-message').textContent = state.status === 'denied'
      ? t('connectDenied', 'Connection declined. You can start again when you are ready.')
      : t('connectExpired', 'This connection expired. Restart to continue with your signed-in account.');
    show('error'); return;
  }
  document.getElementById('user-code').textContent = state.userCode || '';
  const link = document.getElementById('approval-url');
  link.href = state.verificationUri;
  link.textContent = (state.verificationUri || '').replace(/^https?:\/\//, '');
  document.getElementById('pending-message').textContent = state.status === 'offline'
    ? t('connectOffline', 'Connection interrupted. We will retry automatically.')
    : t('connectWaiting', 'Continue on Langsly to sign in and approve. Connection finishes automatically.');
  show('pending');
}
async function run(action) {
  if (busy) return;
  busy = true;
  try { await action(); }
  catch {
    document.getElementById('error-message').textContent = t('accountConnectionFailed', 'Could not connect your Langsly account. Please try again.');
    show('error');
  } finally { busy = false; }
}
async function start(restart = false) {
  show('loading');
  const account = await send('GET_STATUS');
  if (account?.isLoggedIn && !restart) { render({ status: 'connected' }); return; }
  const ua = navigator.userAgent;
  const platform = /Firefox/i.test(ua) ? (/Android/i.test(ua) ? 'firefox_android' : 'firefox_desktop') : 'chrome_desktop';
  render(await send('DEVICE_CONNECTION_BEGIN', { platform, locale: navigator.language || 'en', restart }));
  await send('DEVICE_CONNECTION_OPEN');
}
document.getElementById('open-approval').addEventListener('click', () => void run(() => send('DEVICE_CONNECTION_OPEN')));
document.getElementById('copy-approval-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.verificationUri);
    document.getElementById('copy-status').textContent = t('connectUrlCopied', 'Link copied.');
  } catch { document.getElementById('copy-status').textContent = t('connectUrlCopyFallback', 'Press and hold the link to copy it.'); }
});
document.getElementById('retry-connect').addEventListener('click', () => void run(() => start(true)));
document.getElementById('cancel-connect').addEventListener('click', () => void run(async () => {
  await send('DEVICE_CONNECTION_CANCEL');
  window.location.href = browser.runtime.getURL('popup/options.html');
}));
document.getElementById('close-connect').addEventListener('click', () => {
  window.location.href = browser.runtime.getURL('popup/popup.html');
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionDeviceAuthorization) void send('DEVICE_CONNECTION_STATUS').then(render);
});
window.addEventListener('focus', () => void send('DEVICE_CONNECTION_STATUS').then(render));
browser.storage.local.get('frontendUrl').then(({ frontendUrl }) => {
  document.getElementById('privacy-link').href = `${frontendUrl || 'https://langsly.com'}/privacy-policy`;
});
void run(() => start());
