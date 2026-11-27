const clfdate = require("helper/clfdate");
const redisClient = require("models/client");
const getClientSideCacheStats = require("models/redis").getClientSideCacheStats;

// The server's side of client-side caching: keys it tracks for any client.
// Redis keeps keys for clients which have since disconnected until they are
// written, so it can hold more than the live clients cache; at
// tracking-table-max-keys it evicts entries and sends invalidations. With
// OPTIN tracking it stays far below that cap (config/redis/README.md).
// sendCommand keeps INFO off the client-side cache.
async function logTrackingStats() {
  try {
    const info = await redisClient.sendCommand(["INFO", "stats"]);
    const field = (name) => {
      const match = new RegExp("^" + name + ":(\\d+)", "m").exec(info);
      return match ? match[1] : "unknown";
    };

    console.log(
      clfdate(),
      "[STATS]",
      "redis_tracking_total_keys=" + field("tracking_total_keys"),
      "redis_tracking_total_items=" + field("tracking_total_items")
    );
  } catch (err) {
    console.error(
      clfdate(),
      "[STATS]",
      "redis_tracking_stats_error=info_failed",
      "error=" + JSON.stringify(err && err.message ? err.message : String(err))
    );
  }
}

// "COMMAND|pattern:count:bytes" for the 40 most frequent, comma-separated
function topPatterns(patterns) {
  return (
    (patterns || [])
      .sort((a, b) => b.count - a.count)
      .slice(0, 40)
      .map((p) => p.pattern + ":" + p.count + ":" + p.bytes)
      .join(",") || "none"
  );
}

module.exports = function () {
  logTrackingStats();

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
      // Per key class, only for classes seen so far
      const classCounts = [];
      Object.keys(cacheStats.classStats || {}).forEach(function (name) {
        const c = cacheStats.classStats[name];
        if (!c.hits && !c.misses && !c.bypass) return;
        classCounts.push(
          "redis_cache_" + name + "_hits=" + c.hits,
          "redis_cache_" + name + "_misses=" + c.misses,
          "redis_cache_" + name + "_bypass=" + c.bypass,
          // A capped class (CLASS_CAPS in models/redis-cache) evicting its
          // own entries; the cache-wide evictionCount includes these
          "redis_cache_" + name + "_evictions=" + (c.evictions || 0)
        );
      });

      // What each class holds now: entries and rough value bytes (heap use
      // is about this plus 300 bytes an entry, see models/redis)
      const sizes = cacheStats.classSizes || {};
      let valueBytes = 0;
      Object.keys(sizes).forEach(function (name) {
        valueBytes += sizes[name].bytes;
        classCounts.push(
          "redis_cache_" + name + "_entries=" + sizes[name].entries,
          "redis_cache_" + name + "_valueBytes=" + sizes[name].bytes
        );
      });

      console.log(
        clfdate(),
        "[STATS]",
        "redis_cache_valueBytes=" + valueBytes,
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
        "redis_cache_maxEntries=" + cacheStats.maxEntries,
        ...classCounts
      );

      // The most read uncached key patterns, with the bytes they returned,
      // and the most written, to find keys worth adding to the allowlist:
      // read often, written rarely, few and small. Cumulative, as above.
      console.log(
        clfdate(),
        "[STATS]",
        "redis_bypass_top=" + topPatterns(cacheStats.bypassPatterns),
        "redis_write_top=" + topPatterns(cacheStats.writePatterns)
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
