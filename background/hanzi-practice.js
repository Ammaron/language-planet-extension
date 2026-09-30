/* global globalThis */

// Background half of optional character-writing practice.
// - Character data: only packaged files listed in the vendored manifest, each
//   re-checked against its SHA-256 before it reaches a page.
// - Practice summaries: strictly validated, deduplicated and bounded. They
//   carry the vocabulary item, its data version and the result, never page
//   text, URLs or strokes, and are cleared with every account change.
globalThis.LangslyHanziPractice = {
  QUEUE_KEY: 'hanziPracticeQueue',
  MAX_QUEUED: 50,
  MAX_ATTEMPTS: 5,
  LIBRARY_FILE: 'vendor/hanzi-writer/hanzi-writer.min.js',
  MANIFEST_FILE: 'vendor/hanzi-writing-manifest.json',

  validateSummary(summary) {
    const allowed = ['vocabulary_word_id', 'character_index', 'character', 'data_version', 'mode', 'outcome',
      'mistakes', 'hints_used', 'source', 'client_attempt_id'];
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return null;
    if (Object.keys(summary).some(key => !allowed.includes(key))) return null;
    const outcomes = { watch: 'watched', trace: 'completed', write: 'completed' };
    const count = (value, max) => Number.isInteger(value) && value >= 0 && value <= max;
    const valid = typeof summary.vocabulary_word_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(summary.vocabulary_word_id)
      && count(summary.character_index, 7)
      && typeof summary.character === 'string' && [...summary.character].length === 1
      && typeof summary.data_version === 'string' && /^\d+\.\d+\.\d+$/.test(summary.data_version)
      && outcomes[summary.mode] === summary.outcome
      && count(summary.mistakes, 500) && count(summary.hints_used, 100)
      && !(summary.mode === 'watch' && (summary.mistakes || summary.hints_used))
      && summary.source === 'extension'
      && typeof summary.client_attempt_id === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(summary.client_attempt_id);
    return valid ? Object.fromEntries(allowed.map(key => [key, summary[key]])) : null;
  },

  create({ storage, fetchPackaged, digestHex, send }) {
    const self = globalThis.LangslyHanziPractice;
    let manifestPromise = null;
    let lock = Promise.resolve();
    let generation = 0;
    let flushing = null;

    const withLock = (task) => {
      const result = lock.then(task, task);
      lock = result.catch(() => {});
      return result;
    };
    const loadQueue = async () => {
      const stored = await storage.get(self.QUEUE_KEY);
      return Array.isArray(stored[self.QUEUE_KEY]) ? stored[self.QUEUE_KEY] : [];
    };
    const saveQueue = queue => storage.set({ [self.QUEUE_KEY]: queue });

    async function manifest() {
      if (!manifestPromise) {
        manifestPromise = fetchPackaged(self.MANIFEST_FILE)
          .then(bytes => JSON.parse(new TextDecoder().decode(bytes)))
          .catch((error) => { manifestPromise = null; throw error; });
      }
      return manifestPromise;
    }

    async function characterData({ character, data_version: dataVersion, sha256 } = {}) {
      const packaged = await manifest();
      const entry = (packaged.characters || []).find(item => item.character === character);
      if (!entry) return { success: false, error: 'not_packaged' };
      if (entry.data_version !== dataVersion || entry.sha256 !== sha256) return { success: false, error: 'version_mismatch' };
      const bytes = await fetchPackaged(entry.path);
      if (await digestHex(bytes) !== entry.sha256) return { success: false, error: 'checksum_mismatch' };
      return { success: true, data: JSON.parse(new TextDecoder().decode(bytes)) };
    }

    async function record(summary) {
      const clean = self.validateSummary(summary);
      if (!clean) return { success: false, error: 'invalid_summary' };
      const queued = await withLock(async () => {
        const queue = await loadQueue();
        if (queue.some(item => item.summary.client_attempt_id === clean.client_attempt_id)) return queue.length;
        queue.push({ summary: clean, attempts: 0 });
        if (queue.length > self.MAX_QUEUED) queue.splice(0, queue.length - self.MAX_QUEUED);
        await saveQueue(queue);
        return queue.length;
      });
      void flush();
      return { success: true, queued };
    }

    function flush() {
      if (flushing) return flushing;
      const flushGeneration = generation;
      flushing = (async () => {
        const queue = await withLock(loadQueue);
        for (const item of queue) {
          if (flushGeneration !== generation) return;
          let status = 0;
          try {
            status = await send(item.summary);
          } catch {
            status = 0;
          }
          await withLock(async () => {
            if (flushGeneration !== generation) return;
            const current = await loadQueue();
            const index = current.findIndex(row => row.summary.client_attempt_id === item.summary.client_attempt_id);
            if (index < 0) return;
            // 2xx: stored (or already stored). Other 4xx: permanent, drop it.
            const permanent = status >= 200 && status < 500 && status !== 401 && status !== 408 && status !== 429;
            if (permanent || current[index].attempts + 1 >= self.MAX_ATTEMPTS) current.splice(index, 1);
            else current[index] = { ...current[index], attempts: current[index].attempts + 1 };
            await saveQueue(current);
          });
        }
      })().finally(() => { flushing = null; });
      return flushing;
    }

    function clear() {
      generation += 1;
      return withLock(() => storage.remove(self.QUEUE_KEY));
    }

    return { characterData, record, flush, clear };
  },
};
