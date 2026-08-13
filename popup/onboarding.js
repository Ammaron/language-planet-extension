/* global browser */
const steps = [document.getElementById('step-1'), document.getElementById('step-2'), document.getElementById('step-3')];
const dots = [document.getElementById('dot-1'), document.getElementById('dot-2'), document.getElementById('dot-3')];
const onboardAccountConnectBtn = document.getElementById('onboard-account-connect-btn');
const onboardError = document.getElementById('onboard-error');

function t(key, substitutions, fallback) {
  if (window.LangslyI18n) return window.LangslyI18n.t(key, substitutions, fallback);
  if (fallback === undefined && typeof substitutions === 'string') return substitutions;
  return fallback || key;
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

function showStep(n) {
  steps.forEach((s, i) => s.classList.toggle('hidden', i !== n));
  dots.forEach((d, i) => d.classList.toggle('active', i === n));
}

function setOnboardLoginControlsDisabled(disabled) {
  if (onboardAccountConnectBtn) onboardAccountConnectBtn.disabled = disabled;
}

async function finishOnboardLogin() {
  try {
    const themeStatus = await browser.runtime.sendMessage({ type: 'SYNC_THEMES' });
    if (themeStatus && themeStatus.themeTokens) {
      applyThemeTokens(themeStatus.themeTokens);
    }
  } catch {
    // Theme sync is non-blocking for onboarding.
  }
  showStep(2);
}

applyStoredTheme();

// Step 1 → Step 2
document.getElementById('next-1').addEventListener('click', () => showStep(1));

// Step 2: Login
if (onboardAccountConnectBtn) {
  onboardAccountConnectBtn.addEventListener('click', async () => {
    onboardError.classList.add('hidden');
    setOnboardLoginControlsDisabled(true);
    onboardAccountConnectBtn.textContent = t('deviceLoginOpening', 'Opening secure connection...');

    const response = await browser.runtime.sendMessage({ type: 'START_DEVICE_LOGIN' });

    if (response.success) {
      onboardError.textContent = t('deviceLoginContinueInTab', 'Continue in the connection tab, then return here.');
      onboardError.classList.remove('hidden');
    } else {
      onboardError.textContent = response.error || t('accountConnectionFailed', 'Could not connect your Langsly account.');
      onboardError.classList.remove('hidden');
    }

    setOnboardLoginControlsDisabled(false);
    onboardAccountConnectBtn.textContent = t('connectLangslyAccount', 'Connect Langsly account');
  });
}

// Step 3: Finish
document.getElementById('finish-btn').addEventListener('click', async () => {
  await browser.storage.local.set({ onboardingComplete: true });
  window.close();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.authToken && changes.authToken.newValue) {
    finishOnboardLogin();
  }
});
