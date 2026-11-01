// A small in-memory layer in front of the store's disk cache, for the harness.
//
// The foundation cache is files only: every get is a file read and a CRC, and
// a lookup in a repository with many packs makes one per pack per index part.
// Measured here, that was tens of milliseconds per object once the index parts
// were cached, which is CPU and disk, not S3 round trips. A real host would
// put something like this in front; the harness does, so the times it reports
// are not dominated by it. Request and byte counts are not affected by it.
function frontMemory(cache, maxBytes = 128 * 1024 * 1024) {
  const map = new Map();
  let bytes = 0;

  function remember(key, data) {
    if (data.length > maxBytes / 8) return;
    const old = map.get(key);
    if (old) {
      bytes -= old.length;
      map.delete(key);
    }
    map.set(key, data);
    bytes += data.length;
    while (bytes > maxBytes) {
      const [oldest, value] = map.entries().next().value;
      map.delete(oldest);
      bytes -= value.length;
    }
  }

  return {
    ...cache,
    async get(key) {
      const hit = map.get(key);
      if (hit) {
        map.delete(key);
        map.set(key, hit);
        return hit;
      }
      const found = await cache.get(key);
      if (found) remember(key, found);
      return found;
    },
    async put(key, data) {
      remember(key, data);
      return cache.put(key, data);
    },
    async delete(key) {
      const old = map.get(key);
      if (old) bytes -= old.length;
      map.delete(key);
      return cache.delete(key);
    },
    async clear() {
      map.clear();
      bytes = 0;
      return cache.clear();
    },
  };
}

module.exports = frontMemory;
