/* global globalThis */

globalThis.LangslyEncounterCoordinator = {
  create({ load, save, send, batchSize = 50, maxStored = 1000 }) {
    let mutationTail = Promise.resolve();
    let flushInFlight = null;
    let generation = 0;

    function withLock(task) {
      const result = mutationTail.then(task, task);
      mutationTail = result.catch(() => {});
      return result;
    }

    async function append(encounters) {
      return withLock(async () => {
        const current = await load();
        const next = [...(Array.isArray(current) ? current : []), ...encounters];
        if (next.length > maxStored) next.splice(0, next.length - maxStored);
        await save(next);
        return next.length;
      });
    }

    async function clear() {
      generation += 1;
      return withLock(() => save([]));
    }

    function flush() {
      if (flushInFlight) return flushInFlight;
      const flushGeneration = generation;
      flushInFlight = (async () => {
        while (flushGeneration === generation) {
          const batch = await withLock(async () => {
            const current = await load();
            return (Array.isArray(current) ? current : []).slice(0, batchSize);
          });
          if (batch.length === 0) break;
          const sent = await send(batch);
          if (!sent || flushGeneration !== generation) break;
          await withLock(async () => {
            const current = await load();
            await save((Array.isArray(current) ? current : []).slice(batch.length));
          });
        }
      })().finally(() => { flushInFlight = null; });
      return flushInFlight;
    }

    function snapshot() {
      return { flushing: !!flushInFlight, generation, batchSize };
    }

    return { append, clear, flush, snapshot };
  },
};
