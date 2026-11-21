const { read } = require("./metrics");

// Returns a stats() function for a scheduler job to log an LRU cache's
// current footprint: item count against `max`, and estimated retained
// bytes (from ./clone's prepareCacheValue) against `maxSize`.
function cacheStats(name, cache) {
  return function () {
    // V8-shaped estimate of what the values hold (heapBytes in ./clone),
    // beside calculatedSize, which the caps use (#2795). Values not made by
    // prepareCacheValue (Mustache's token arrays) count as 0.
    let heapBytes = 0;
    let twoByteBytes = 0;
    for (const value of cache.values()) {
      if (!value || typeof value.heapBytes !== "number") continue;
      heapBytes += value.heapBytes;
      twoByteBytes += value.twoByteBytes || 0;
    }
    return {
      name,
      size: cache.size,
      max: cache.max,
      calculatedSize: cache.calculatedSize,
      maxSize: cache.maxSize,
      heapBytes,
      twoByteBytes,
      // Lookup, fill and eviction counters (see cacheMetrics), if the cache
      // was built by createRenderCache
      counters: read(cache),
    };
  };
}

module.exports = cacheStats;
