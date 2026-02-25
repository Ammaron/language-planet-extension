/* global browser */
const steps = [document.getElementById('step-1'), document.getElementById('step-2'), document.getElementById('step-3')];
const dots = [document.getElementById('dot-1'), document.getElementById('dot-2'), document.getElementById('dot-3')];

function showStep(n) {
  steps.forEach((s, i) => s.classList.toggle('hidden', i !== n));
  dots.forEach((d, i) => d.classList.toggle('active', i === n));
}

// Step 1 → Step 2
document.getElementById('next-1').addEventListener('click', () => showStep(1));

// Step 2: Login
document.getElementById('onboard-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('onboard-error');
  const btn = document.getElementById('onboard-login-btn');
  errorEl.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Logging in...';

  const email = document.getElementById('onboard-email').value;
  const password = document.getElementById('onboard-password').value;

  const response = await browser.runtime.sendMessage({ type: 'LOGIN', email, password });

  if (response.success) {
    showStep(2);
  } else {
    errorEl.textContent = response.error || 'Login failed';
    errorEl.classList.remove('hidden');
  }

  btn.disabled = false;
  btn.textContent = 'Log In';
});

// Step 3: Finish
document.getElementById('finish-btn').addEventListener('click', async () => {
  await browser.storage.local.set({ onboardingComplete: true });
  window.close();
});
