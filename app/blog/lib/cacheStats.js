// Returns a stats() function for a scheduler job to log an LRU cache's
// current footprint: item count against `max`, and estimated retained
// bytes (from lib/clone's prepareCacheValue) against `maxSize`.
function cacheStats(name, cache) {
  return function () {
    return {
      name,
      size: cache.size,
      max: cache.max,
      calculatedSize: cache.calculatedSize,
      maxSize: cache.maxSize,
    };
  };
}

module.exports = cacheStats;
