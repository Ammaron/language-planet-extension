/* Connection state belongs to the background, never to a popup's lifetime. */
(function (global) {
  global.createDeviceConnection = function ({ browser, fetch, getConfig, complete, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const key = 'extensionDeviceAuthorization';
    const alarm = 'device-connection';
    let epoch = 0;
    let timer;
    let flight;
    let starting;
    let opening;
    let mutation = Promise.resolve();
    const read = async () => (await browser.storage.local.get(key))[key];
    const write = (state) => browser.storage.local.set({ [key]: state });
    function update(transform) {
      const result = mutation.then(async () => {
        const state = await read();
        const next = transform(state);
        if (next) await write(next);
      });
      mutation = result.catch(() => {});
      return result;
    }
    const active = (state) => state && state.deviceCode && !['connected', 'denied', 'expired', 'cancelled'].includes(state.status);
    async function stop() {
      clearTimer(timer);
      await browser.alarms.clear(alarm);
    }
    async function schedule(state) {
      clearTimer(timer);
      if (!active(state)) return;
      const delay = Math.max(0, (state.nextPollAt || 0) - now());
      timer = setTimer(() => void poll(), delay);
      // Alarms wake suspended event pages; timers provide responsive foreground completion.
      await browser.alarms.create(alarm, { when: now() + Math.max(1000, delay) });
    }
    async function status() {
      const state = await read();
      if (!state) return { status: 'idle' };
      if (active(state) && state.expiresAt <= now()) {
        const expired = { ...state, status: 'expired', deviceCode: undefined };
        await update(latest => active(latest) && latest.deviceCode === state.deviceCode ? expired : null);
        await stop();
        return publicState(expired);
      }
      return publicState(state);
    }
    function publicState(state) {
      // Never expose credentials, device secrets, or internal tab IDs to the website.
      return { status: state.status || 'pending', userCode: state.userCode, verificationUri: state.verificationUri, expiresAt: state.expiresAt };
    }
    async function begin(platform, locale, restart = false) {
      if (starting) return starting;
      starting = (async () => {
        const existing = await read();
        if (!restart && active(existing) && existing.expiresAt > now()) {
          await schedule(existing);
          return status();
        }
        const generation = ++epoch;
        await stop();
        const { connectionReturnTabId } = await browser.storage.local.get('connectionReturnTabId');
        const { apiBase, frontendUrl } = await getConfig();
        const response = await fetch(`${apiBase}/auth/extension-device/start/`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({ platform, locale }),
        });
        const data = await response.json();
        if (!response.ok || !data.device_code || !data.user_code) throw new Error('connection_start_failed');
        const approval = new URL(data.verification_uri_complete);
        if (approval.origin !== new URL(frontendUrl).origin || approval.pathname !== '/extension-connect') throw new Error('invalid_approval_url');
        if (generation !== epoch) return { status: 'cancelled' };
        const state = {
          deviceCode: data.device_code, userCode: data.user_code,
          verificationUri: data.verification_uri, verificationUriComplete: approval.href,
          expiresAt: now() + Number(data.expires_in || 600) * 1000,
          intervalMs: Math.max(5000, Number(data.interval || 5) * 1000),
          nextPollAt: now() + Math.max(5000, Number(data.interval || 5) * 1000),
          status: 'pending', platform, locale, approvalTabId: existing?.approvalTabId,
          returnTabId: existing?.returnTabId ?? connectionReturnTabId,
        };
        await update(() => generation === epoch ? state : null);
        if (generation !== epoch) return { status: 'cancelled' };
        await schedule(state);
        return publicState(state);
      })().finally(() => { starting = null; });
      return starting;
    }
    async function openApproval() {
      if (opening) return opening;
      opening = (async () => {
        const state = await read();
        if (!active(state) || state.expiresAt <= now()) return status();
        let tab;
        if (Number.isInteger(state.approvalTabId)) {
          try {
            const existing = await browser.tabs.get(state.approvalTabId);
            const { frontendUrl } = await getConfig();
            const url = new URL(existing.url);
            if (url.origin === new URL(frontendUrl).origin && ['/login', '/extension-connect'].includes(url.pathname)) {
              // Preserve a login already in progress, including typed credentials.
              tab = await browser.tabs.update(existing.id, { active: true });
              if (url.pathname === '/extension-connect' && url.searchParams.get('user_code') !== state.userCode) {
                await browser.tabs.update(existing.id, { url: state.verificationUriComplete });
              }
            }
          } catch { /* Closed or navigated tab: open a fresh approval page. */ }
        }
        if (!tab) tab = await browser.tabs.create({ url: state.verificationUriComplete });
        await update(latest => latest?.userCode === state.userCode ? { ...latest, approvalTabId: tab.id } : null);
        return status();
      })().finally(() => { opening = null; });
      return opening;
    }
    async function poll() {
      if (flight) return flight;
      flight = (async () => {
        const generation = epoch;
        const current = () => generation === epoch;
        const state = await read();
        if (!current()) return;
        if (!active(state)) return;
        if (state.expiresAt <= now()) { await status(); return; }
        if (state.nextPollAt > now()) { await schedule(state); return; }
        try {
          // Persist the throttle before fetching, including across background restarts.
          state.nextPollAt = now() + state.intervalMs;
          await update(latest => current() && latest?.deviceCode === state.deviceCode ? { ...latest, nextPollAt: state.nextPollAt } : null);
          if (!current()) return;
          const { apiBase } = await getConfig();
          const response = await fetch(`${apiBase}/auth/extension-device/token/`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(15000),
            body: JSON.stringify({ device_code: state.deviceCode }),
          });
          const data = await response.json();
          if (!current()) return;
          if (response.ok && data.access && data.refresh) {
            const result = await complete(data, current);
            if (!current()) return;
            if (!result.success) throw new Error('connection_commit_failed');
            state.status = 'connected';
            delete state.deviceCode;
          } else if (data.error === 'access_denied' || data.error === 'expired_token') {
            state.status = data.error === 'access_denied' ? 'denied' : 'expired';
            delete state.deviceCode;
          } else if (data.error === 'slow_down') {
            state.intervalMs = Math.max(state.intervalMs + 5000, Number(data.interval || 10) * 1000);
            state.status = 'pending';
          } else state.status = data.error === 'authorization_pending' ? 'pending' : 'offline';
        } catch {
          if (!current()) return;
          state.status = 'offline';
        }
        if (!current()) return;
        state.nextPollAt = now() + state.intervalMs;
        await update(latest => {
          if (!current() || latest?.userCode !== state.userCode) return null;
          return { ...state, approvalTabId: latest.approvalTabId, returnTabId: latest.returnTabId };
        });
        if (!current()) return;
        if (active(state)) await schedule(state);
        else await stop();
      })().finally(() => { flight = null; });
      return flight;
    }
    async function cancel() {
      ++epoch;
      await stop();
      const clearing = mutation.then(() => browser.storage.local.remove(key));
      mutation = clearing.catch(() => {});
      await clearing;
    }
    async function resume() {
      const state = await read();
      if (active(state)) await poll();
    }
    async function bridge(message, sender) {
      const state = await read();
      const { frontendUrl } = await getConfig();
      let url;
      try { url = new URL(sender.url); } catch { return { status: 'unavailable' }; }
      if (!state || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) ||
          url.origin !== new URL(frontendUrl).origin || url.pathname !== '/extension-connect' ||
          message.userCode !== state.userCode || url.searchParams.get('user_code') !== state.userCode) return { status: 'unavailable' };
      // Verification may open a new tab. Only an explicit resume action may move
      // the handoff; it still cannot approve or exchange tokens for the website.
      if (sender.tab.id !== state.approvalTabId) {
        if (message.action === 'status') return { status: 'resume' };
        if (message.action !== 'resume') return { status: 'unavailable' };
        await update(latest => latest?.userCode === state.userCode ? { ...latest, approvalTabId: sender.tab.id } : null);
        return status();
      }
      if (message.action === 'resume') return status();
      if (message.action === 'restart') {
        await begin(state.platform, state.locale, true);
        await openApproval();
      } else if (message.action === 'return') {
        if (state.status !== 'connected') return status();
        if (Number.isInteger(state.returnTabId)) {
          try { await browser.tabs.update(state.returnTabId, { active: true }); return status(); } catch { /* Original tab closed. */ }
        }
        await browser.tabs.create({ url: `${frontendUrl}/Dashboard` });
      } else if (message.action === 'status') void resume();
      else return { status: 'unavailable' };
      return status();
    }
    return { begin, status, poll, resume, cancel, openApproval, bridge };
  };
})(globalThis);
