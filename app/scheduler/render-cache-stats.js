const clfdate = require("helper/clfdate");

// Each of these render-path LRU caches exports a _stats() accessor
// (see blog/lib/cacheStats.js) returning current size/calculatedSize
// against the cache's configured max/maxSize, plus the lookup, fill and
// eviction counters from blog/lib/cacheMetrics (cumulative for the process).
// Not every cache has every counter: Mustache's template cache is read by
// Mustache, not through fetchCached, so only its evictions are counted.
const caches = [
  require("blog/render/main")._stats,
  require("blog/render/full-view-cache")._stats,
  require("blog/render/retrieve/popular_tags")._stats,
  require("blog/render/retrieve/posts")._stats,
  require("blog/render/retrieve/archives")._stats,
  require("blog/render/retrieve/all_tags")._stats,
  require("blog/render/retrieve/tagged")._stats,
  require("blog/render/retrieve/recent_entries")._stats,
  require("blog/render/retrieve/latest_entry")._stats,
  require("blog/render/retrieve/all_entries")._stats,
  require("blog/render/retrieve/helpers/getAllCached")._stats,
  require("blog/render/retrieve/total_posts")._stats,
];

module.exports = function () {
  try {
    const mem = process.memoryUsage();

    console.log(
      clfdate(),
      "[STATS]",
      "process_rss=" + mem.rss,
      "process_heapTotal=" + mem.heapTotal,
      "process_heapUsed=" + mem.heapUsed,
      "process_external=" + mem.external,
      "process_arrayBuffers=" + mem.arrayBuffers
    );

    for (const stats of caches) {
      const cache = stats();
      const c = cache.counters;
      console.log(
        clfdate(),
        "[STATS]",
        "render_cache_name=" + cache.name,
        "render_cache_size=" + cache.size,
        "render_cache_max=" + cache.max,
        "render_cache_calculatedSize=" + cache.calculatedSize,
        "render_cache_maxSize=" + cache.maxSize,
        ...(c
          ? [
              "render_cache_hits=" + c.hit,
              "render_cache_misses=" + c.miss,
              "render_cache_inflight=" + c.inflight,
              "render_cache_bypass=" + c.bypass,
              "render_cache_evictions=" + c.evictions,
              "render_cache_fills=" + c.fills,
              "render_cache_failedFills=" + c.failedFills,
              "render_cache_uncachedFills=" + c.uncachedFills,
              "render_cache_fillMs=" + Math.round(c.fillMs),
              "render_cache_fillMaxMs=" + Math.round(c.fillMaxMs),
              "render_cache_slowFills=" + c.slowFills,
            ]
          : [])
      );
    }
  } catch (err) {
    console.error(
      clfdate(),
      "[STATS]",
      "render_cache_stats_error=metric_access_failed",
      "error=" + JSON.stringify(err && err.message ? err.message : String(err))
    );
  }
};
