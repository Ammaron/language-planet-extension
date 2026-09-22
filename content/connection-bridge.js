/* Only installed on Langsly. This channel carries status, never account tokens. */
(() => {
  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.origin !== location.origin || location.pathname !== '/extension-connect') return;
    const message = event.data;
    if (!message || message.type !== 'LANGSLY_CONNECTION_REQUEST' ||
        !['status', 'restart', 'return', 'resume'].includes(message.action) ||
        typeof message.requestId !== 'string' || message.requestId.length > 100 ||
        typeof message.userCode !== 'string' || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(message.userCode)) return;
    try {
      const result = await browser.runtime.sendMessage({
        type: 'DEVICE_CONNECTION_BRIDGE', action: message.action, userCode: message.userCode,
      });
      window.postMessage({ type: 'LANGSLY_CONNECTION_RESPONSE', requestId: message.requestId, ...result }, location.origin);
    } catch { /* A disabled/updating extension cannot acknowledge completion. */ }
  });
})();
