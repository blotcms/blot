// The render-path LRU caches are built through createRenderCache so that each
// one counts how its lookups were served, how long its fills took and how
// often it evicted for lack of room. scheduler/render-cache-stats.js logs the
// counters next to cacheStats' size figures; fetchCached and getAllCached feed
// them. Counters are cumulative for the life of the process.
const LRUCache = require("lru-cache").LRUCache;
const clfdate = require("helper/clfdate");

// A fill this slow is logged on its own line, with the blog it was for
const SLOW_FILL_MS = 250;

const metrics = new WeakMap();

function createRenderCache(name, options) {
  const counters = {
    name,
    hit: 0,
    miss: 0,
    inflight: 0,
    bypass: 0,
    // Entries pushed out by max/maxSize pressure, not by delete() or set()
    evictions: 0,
    fills: 0,
    failedFills: 0,
    // A fill whose result the cache did not keep, e.g. a value over maxSize
    uncachedFills: 0,
    fillMs: 0,
    fillMaxMs: 0,
    slowFills: 0,
  };

  const cache = new LRUCache({
    ...options,
    dispose: function (value, key, reason) {
      if (reason === "evict") counters.evictions++;
    },
  });

  metrics.set(cache, counters);
  return cache;
}

// outcome: hit | miss | inflight | bypass. Caches not built by
// createRenderCache are ignored, so tests can pass their own.
function count(cache, outcome) {
  const counters = metrics.get(cache);
  if (counters) counters[outcome]++;
}

// A finished fill: how long the lookup that started it waited (so event loop
// delays count), and whether the cache kept the result (false for a value too
// big to store; undefined when the caller never stores, like a preview).
function fill(cache, key, ms, { failed = false, cached } = {}) {
  const counters = metrics.get(cache);
  if (!counters) return;

  if (failed) {
    counters.failedFills++;
    return;
  }

  counters.fills++;
  counters.fillMs += ms;
  if (ms > counters.fillMaxMs) counters.fillMaxMs = ms;
  if (cached === false) counters.uncachedFills++;

  if (ms >= SLOW_FILL_MS) {
    counters.slowFills++;
    const blog = /"blogID":"([^"]*)"/.exec(key);
    console.log(
      clfdate(),
      "[SLOW-FILL]",
      "cache=" + counters.name,
      "ms=" + Math.round(ms),
      "blog=" + (blog ? blog[1] : "unknown"),
      "cached=" + cached
    );
  }
}

function read(cache) {
  const counters = metrics.get(cache);
  return counters ? { ...counters } : null;
}

module.exports = { createRenderCache, count, fill, read, SLOW_FILL_MS };
