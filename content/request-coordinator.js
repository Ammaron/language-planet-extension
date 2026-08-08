/* global globalThis */

globalThis.LangslyRequestCoordinator = (() => {
  function createRequestCoordinator({ keyOf, send, maxConcurrent = 1, maxUnique = Infinity }) {
    const entries = new Map();
    const queue = [];
    let active = 0;
    let generation = 0;

    function pump() {
      while (active < maxConcurrent && queue.length > 0) {
        const entry = queue.shift();
        if (entry.generation !== generation) {
          entry.resolve({ success: false, error: 'cancelled' });
          continue;
        }

        active += 1;
        Promise.resolve()
          .then(() => send(entry.payload))
          .then(
            (result) => entry.resolve(entry.generation === generation ? result : { success: false, error: 'cancelled' }),
            () => entry.resolve({ success: false, error: entry.generation === generation ? 'request_failed' : 'cancelled' })
          )
          .finally(() => {
            active -= 1;
            pump();
          });
      }
    }

    function request(payload) {
      const key = String(keyOf(payload));
      const existing = entries.get(key);
      if (existing) return existing.promise;
      if (entries.size >= maxUnique) return Promise.resolve({ success: false, error: 'quota_exceeded' });

      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      const entry = { key, payload, promise, resolve, generation };
      entries.set(key, entry);
      queue.push(entry);
      pump();
      return promise;
    }

    function cancel() {
      generation += 1;
      while (queue.length > 0) queue.shift().resolve({ success: false, error: 'cancelled' });
      entries.clear();
    }

    function snapshot() {
      return { active, queued: queue.length, unique: entries.size, generation };
    }

    return { request, cancel, snapshot };
  }

  function createBatchCoordinator({ send, maxBatch = 20, maxPerWindow = 60, windowMs = 60_000 }) {
    const queue = [];
    let inFlight = false;
    let generation = 0;
    let acceptedAt = [];

    function prune(now) {
      acceptedAt = acceptedAt.filter((timestamp) => now - timestamp < windowMs);
    }

    function pump() {
      if (inFlight || queue.length === 0) return;
      const batch = queue.splice(0, maxBatch);
      const batchGeneration = generation;
      inFlight = true;
      Promise.resolve()
        .then(() => send(batch.map((entry) => entry.payload)))
        .then(
          (results) => {
            const values = Array.isArray(results) ? results : [];
            batch.forEach((entry, index) => entry.resolve(batchGeneration === generation ? (values[index] || null) : null));
          },
          () => batch.forEach((entry) => entry.resolve(null))
        )
        .finally(() => {
          inFlight = false;
          pump();
        });
    }

    function request(payload) {
      const now = Date.now();
      prune(now);
      if (acceptedAt.length >= maxPerWindow) return Promise.resolve(null);
      acceptedAt.push(now);

      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      queue.push({ payload, resolve, generation });
      queueMicrotask(pump);
      return promise;
    }

    function cancel() {
      generation += 1;
      while (queue.length > 0) queue.shift().resolve(null);
      acceptedAt = [];
    }

    function snapshot() {
      prune(Date.now());
      return { inFlight, queued: queue.length, acceptedInWindow: acceptedAt.length, generation };
    }

    return { request, cancel, snapshot };
  }

  return { createRequestCoordinator, createBatchCoordinator };
})();
