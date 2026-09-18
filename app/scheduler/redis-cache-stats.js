const clfdate = require("helper/clfdate");
const redisClient = require("models/client");
const getClientSideCacheStats =
  require("models/redis").getClientSideCacheStats;

module.exports = function () {
  // These metrics are cumulative for this process's Redis cache lifetime.
  // Reading them does not reset the cache's counters.
  try {
    const cacheStats = getClientSideCacheStats(redisClient);

    if (!cacheStats) {
      console.error(
        clfdate(),
        "[STATS]",
        "redis_cache_stats_error=cache_unavailable"
      );
    } else {
      console.log(
        clfdate(),
        "[STATS]",
        "redis_cache_hitCount=" + cacheStats.hitCount,
        "redis_cache_missCount=" + cacheStats.missCount,
        "redis_cache_hitRate=" + cacheStats.hitRate(),
        "redis_cache_requestCount=" + cacheStats.requestCount(),
        "redis_cache_loadSuccessCount=" + cacheStats.loadSuccessCount,
        "redis_cache_loadFailureCount=" + cacheStats.loadFailureCount,
        "redis_cache_totalLoadTime=" + cacheStats.totalLoadTime,
        "redis_cache_evictionCount=" + cacheStats.evictionCount,
        "redis_cache_missRate=" + cacheStats.missRate(),
        "redis_cache_loadCount=" + cacheStats.loadCount(),
        "redis_cache_loadFailureRate=" + cacheStats.loadFailureRate(),
        "redis_cache_averageLoadPenalty=" + cacheStats.averageLoadPenalty(),
        // Entry count against the configured cap: this cache is bounded by
        // key count only (node-redis has no byte-size option), so a full
        // cache of large values can still be far bigger in memory than a
        // full cache of small ones.
        "redis_cache_entryCount=" + cacheStats.entryCount,
        "redis_cache_maxEntries=" + cacheStats.maxEntries
      );
    }
  } catch (err) {
    console.error(
      clfdate(),
      "[STATS]",
      "redis_cache_stats_error=metric_access_failed",
      "error=" + JSON.stringify(err && err.message ? err.message : String(err))
    );
  }
};
