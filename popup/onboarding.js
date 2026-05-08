/* global browser */
const steps = [document.getElementById('step-1'), document.getElementById('step-2'), document.getElementById('step-3')];
const dots = [document.getElementById('dot-1'), document.getElementById('dot-2'), document.getElementById('dot-3')];
const onboardLoginBtn = document.getElementById('onboard-login-btn');
const onboardGoogleLoginBtn = document.getElementById('onboard-google-login-btn');
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
  onboardLoginBtn.disabled = disabled;
  if (onboardGoogleLoginBtn) onboardGoogleLoginBtn.disabled = disabled;
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
document.getElementById('onboard-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  onboardError.classList.add('hidden');
  setOnboardLoginControlsDisabled(true);
  onboardLoginBtn.textContent = t('loginLoading', 'Logging in...');

  const email = document.getElementById('onboard-email').value;
  const password = document.getElementById('onboard-password').value;

  const response = await browser.runtime.sendMessage({ type: 'LOGIN', email, password });

  if (response.success) {
    await finishOnboardLogin();
  } else {
    onboardError.textContent = response.error || t('loginFailed', 'Login failed');
    onboardError.classList.remove('hidden');
  }

  setOnboardLoginControlsDisabled(false);
  onboardLoginBtn.textContent = t('loginButton', 'Log in');
});

if (onboardGoogleLoginBtn) {
  onboardGoogleLoginBtn.addEventListener('click', async () => {
    onboardError.classList.add('hidden');
    setOnboardLoginControlsDisabled(true);
    onboardGoogleLoginBtn.textContent = t('googleLoginLoading', 'Connecting to Google...');

    const response = await browser.runtime.sendMessage({ type: 'GOOGLE_LOGIN' });

    if (response.success) {
      await finishOnboardLogin();
    } else {
      onboardError.textContent = response.error || t('googleLoginFailed', 'Google sign-in failed.');
      onboardError.classList.remove('hidden');
    }

    setOnboardLoginControlsDisabled(false);
    onboardGoogleLoginBtn.textContent = t('loginWithGoogle', 'Continue with Google');
  });
}

// Step 3: Finish
document.getElementById('finish-btn').addEventListener('click', async () => {
  await browser.storage.local.set({ onboardingComplete: true });
  window.close();
});
