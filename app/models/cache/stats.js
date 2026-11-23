const { read } = require("./metrics");
const heapEstimate = require("./heapEstimate");

// Returns a stats() function for a scheduler job to log an LRU cache's
// current footprint: item count against `max`, and estimated retained
// bytes (from ./clone's prepareCacheValue) against `maxSize`.
function cacheStats(name, cache) {
  heapEstimate.track(cache);
  return function () {
    // V8-shaped estimate of what the values hold, beside calculatedSize,
    // which the caps use (#2795). Measured in the background (./heapEstimate).
    const heap = heapEstimate.estimate(cache);
    return {
      name,
      size: cache.size,
      max: cache.max,
      calculatedSize: cache.calculatedSize,
      maxSize: cache.maxSize,
      heapBytes: heap.heapBytes,
      twoByteBytes: heap.twoByteBytes,
      wideObjects: heap.wideObjects,
      heapMeasured: heap.measuredShare,
      // Lookup, fill and eviction counters (see cacheMetrics), if the cache
      // was built by createRenderCache
      counters: read(cache),
    };
  };
}

module.exports = cacheStats;
