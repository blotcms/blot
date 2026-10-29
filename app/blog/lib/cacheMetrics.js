// The render-path LRU caches are built through createRenderCache so that each
// one counts how its lookups were served, how long its fills took and how
// often it evicted for lack of room. scheduler/render-cache-stats.js logs the
// counters next to cacheStats' size figures; fetchCached and getAllCached feed
// them. Counters are cumulative for the life of the process.
//
// Beyond the totals, each cache also answers "would more room help?":
//
//   missGhost / missCold   a miss on a key this cache evicted earlier (more
//                          room might have kept it) against any other miss:
//                          a new key, or one a cacheID change made new
//   evictedHit /           evicted entries that were hit at least once
//   evictedNeverHit        against ones that never were
//   evictIdle              how long evicted entries had gone unused
//   hitAge                 how long after its fill each hit came
//
// and "what does a hit cost?" (clones, cloneMs: the per-request copy of a
// cached value, which a hit still pays).
const LRUCache = require("lru-cache").LRUCache;
const clfdate = require("helper/clfdate");
const config = require("config");

// A fill this slow is logged on its own line, with the blog it was for
const SLOW_FILL_MS = 250;

// Evicted keys remembered per cache, oldest forgotten first. A miss on one
// of them is a miss more room could have avoided.
const GHOST_KEYS = 2000;

// Upper bounds of the age and idle-time buckets: under 1s, 1m, 10m, 1h, and
// 1h or more
const AGE_BOUNDS_MS = [1000, 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];

const UNCACHED_REASONS = [
  "oversize", // over the cache's maxSize, which the LRU refuses
  "uncacheable", // a result the fetchMethod declined to store (empty, ...)
  "covered", // a wider copy already serves it (getAllCached)
  "empty", // an empty catalog (getAllCached)
  "evicted", // within maxSize, yet gone by the time the fill finished
  "unknown",
];

const metrics = new WeakMap();

function bucket(ms) {
  const i = AGE_BOUNDS_MS.findIndex((bound) => ms < bound);
  return i === -1 ? AGE_BOUNDS_MS.length : i;
}

function emptyBuckets() {
  return new Array(AGE_BOUNDS_MS.length + 1).fill(0);
}

function sizeOf(cache, value) {
  try {
    return value !== undefined && cache.sizeCalculation
      ? cache.sizeCalculation(value, undefined)
      : 0;
  } catch (e) {
    return 0;
  }
}

// BLOT_CACHE_SCALE shrinks (or grows) every cache's caps in this process, e.g.
// for the worker child, which barely renders. An entry cap never drops below
// 10 or a byte cap below 256KB.
function scaled(options, scale = config.cache_scale) {
  if (scale === 1) return options;

  const result = { ...options };
  if (result.max) result.max = Math.max(10, Math.round(result.max * scale));
  if (result.maxSize) {
    result.maxSize = Math.max(256 * 1024, Math.round(result.maxSize * scale));
  }
  return result;
}

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
    // A fill whose result the cache did not keep, e.g. a value over maxSize;
    // uncachedBy splits it by why
    uncachedFills: 0,
    uncachedBy: Object.fromEntries(UNCACHED_REASONS.map((r) => [r, 0])),
    fillMs: 0,
    fillMaxMs: 0,
    slowFills: 0,
    missGhost: 0,
    missCold: 0,
    // Bytes the cache held for the keys it later missed on
    missGhostBytes: 0,
    evictedHit: 0,
    evictedNeverHit: 0,
    evictedBytes: 0,
    evictIdle: emptyBuckets(),
    hitAge: emptyBuckets(),
    clones: 0,
    cloneMs: 0,
    cloneMaxMs: 0,
  };

  // Per stored key: when it was filled, last used, how often hit, and its size
  const entries = new Map();
  // Recently evicted key -> its size
  const ghosts = new Map();

  const cache = new LRUCache({
    ...scaled(options),
    dispose: function (value, key, reason) {
      const meta = entries.get(key);
      entries.delete(key);

      if (reason !== "evict") return;
      counters.evictions++;
      if (!meta) return;

      if (meta.hits) counters.evictedHit++;
      else counters.evictedNeverHit++;
      counters.evictedBytes += meta.size;
      counters.evictIdle[bucket(Date.now() - meta.last)]++;

      ghosts.set(key, meta.size);
      if (ghosts.size > GHOST_KEYS) {
        ghosts.delete(ghosts.keys().next().value);
      }
    },
  });

  metrics.set(cache, { counters, entries, ghosts });
  return cache;
}

// outcome: hit | miss | inflight | bypass. key (optional) lets a hit age the
// entry it served and a miss be told apart as ghost or cold. Caches not built
// by createRenderCache are ignored, so tests can pass their own.
function count(cache, outcome, key) {
  const state = metrics.get(cache);
  if (!state) return;

  const { counters, entries, ghosts } = state;
  counters[outcome]++;
  if (key === undefined) return;

  if (outcome === "hit") {
    const meta = entries.get(key);
    if (!meta) return;
    const now = Date.now();
    meta.hits++;
    meta.last = now;
    counters.hitAge[bucket(now - meta.at)]++;
  } else if (outcome === "miss") {
    if (ghosts.has(key)) {
      counters.missGhost++;
      counters.missGhostBytes += ghosts.get(key);
      ghosts.delete(key);
    } else {
      counters.missCold++;
    }
  }
}

// A finished fill: how long the lookup that started it waited (so event loop
// delays count), and whether the cache kept the result (false for a value too
// big to store; undefined when the caller never stores, like a preview).
// value is what the fill produced, to size it; reason says why a result was
// not kept when the caller knows (otherwise it is told from the value's size).
function fill(cache, key, ms, { failed = false, cached, reason, value, bytes } = {}) {
  const state = metrics.get(cache);
  if (!state) return;

  const { counters, entries } = state;

  if (failed) {
    counters.failedFills++;
    return;
  }

  if (bytes === undefined) bytes = sizeOf(cache, value);

  counters.fills++;
  counters.fillMs += ms;
  if (ms > counters.fillMaxMs) counters.fillMaxMs = ms;

  if (cached === false) {
    if (!reason) {
      reason =
        value === undefined
          ? "unknown"
          : cache.maxSize && bytes > cache.maxSize
            ? "oversize"
            : "evicted";
    }
    counters.uncachedFills++;
    counters.uncachedBy[reason in counters.uncachedBy ? reason : "unknown"]++;
  } else if (cached === true) {
    const now = Date.now();
    entries.set(key, { at: now, last: now, hits: 0, size: bytes });
  }

  if (ms >= SLOW_FILL_MS) {
    counters.slowFills++;
    const blog = /"blogID":"([^"]*)"/.exec(key);
    console.log(
      clfdate(),
      "[SLOW-FILL]",
      "cache=" + counters.name,
      "ms=" + Math.round(ms),
      "blog=" + (blog ? blog[1] : "unknown"),
      "cached=" + cached,
      "bytes=" + bytes,
      ...(cached === false ? ["reason=" + reason] : [])
    );
  }
}

// Runs fn, the copy of a cached value a request takes, and counts its time:
// the least a hit costs, which a cached fill has to beat.
function timeClone(cache, fn) {
  const state = metrics.get(cache);
  if (!state) return fn();

  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    const ms = performance.now() - startedAt;
    state.counters.clones++;
    state.counters.cloneMs += ms;
    if (ms > state.counters.cloneMaxMs) state.counters.cloneMaxMs = ms;
  }
}

function read(cache) {
  const state = metrics.get(cache);
  if (!state) return null;

  const { counters } = state;
  return {
    ...counters,
    uncachedBy: { ...counters.uncachedBy },
    evictIdle: counters.evictIdle.slice(),
    hitAge: counters.hitAge.slice(),
  };
}

module.exports = {
  createRenderCache,
  scaled,
  count,
  fill,
  read,
  timeClone,
  SLOW_FILL_MS,
  UNCACHED_REASONS,
};
