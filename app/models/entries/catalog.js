// getCatalog(blogID, options): every entry of a blog, cached in this process
// per blog cacheID, so a burst of renders (or previews) that need a blog's
// whole catalog read it from Redis once per cacheID instead of once each.
//
// options.keep: the heavy fields (html, body, ...) the caller needs; the rest
// are stripped before the catalog is stored, so a blog whose archives only
// print titles and URLs doesn't keep every entry's full HTML in memory, nor
// deep-copy it on every hit. Every heavy field when left out. Each stored copy
// is keyed on the heavy fields it kept: a call served by a copy that kept more
// than it needs strips the rest from its own copy; one that needs a field no
// stored copy kept reads Redis again.
// options.cacheID: the blog's cacheID, when the caller already has it. Read
// from Redis otherwise (the client-side cache usually answers that locally).
// options.log: req.log, told how the lookup was served (models/cache/fetchCached).
//
// Resolves to a copy the caller may change. Only for rendering: the cacheID
// can lag a write by the moment it takes to bump, so code that writes back
// what it read (sync, fix, scripts) must use Entries.getAll.
const cacheMetrics = require("models/cache/metrics");
const { createRenderCache } = cacheMetrics;
const { cloneDeep, prepareCacheValue } = require("models/cache/clone");
const cacheStats = require("models/cache/stats");
const client = require("models/client");
const blogKey = require("models/blog/key");
const HEAVY_FIELDS = require("models/template/util/projectableEntryFields");

const entriesCache = createRenderCache("entries", {
  max: 200,
  // Byte-capped like the posts/popular_tags caches: a single large blog's
  // full catalog must not evict every other blog sharing this process.
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
});

// Dedupes concurrent misses for the same key (e.g. archives and all_entries
// both missing on the same request) so only one Entries.getAll is in flight.
const inflight = new Map();

// Every set of heavy fields that contains `keep` (when wider) or is
// contained by it (when !wider), `keep` itself included, smallest first - so
// the first cached copy found is the one with the least to strip.
function relatedFieldSets(keep, wider) {
  const pool = HEAVY_FIELDS.filter((field) =>
    wider ? !keep.includes(field) : keep.includes(field)
  );
  const sets = [];

  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const chosen = pool.filter((field, i) => mask & (1 << i));
    const set = wider
      ? keep.concat(chosen)
      : keep.filter((field) => !chosen.includes(field));
    sets.push(HEAVY_FIELDS.filter((field) => set.includes(field)));
  }

  return sets.sort((a, b) => a.length - b.length);
}

function createCacheKey(blogID, cacheID, keep) {
  return JSON.stringify({
    blogID: String(blogID),
    cacheID: String(cacheID),
    keep: (keep || HEAVY_FIELDS).join(","),
  });
}

// The per-call copy, which every lookup pays whether or not it hit
function cloneEntries(value) {
  return cacheMetrics.timeClone(entriesCache, () =>
    cloneDeep(value, { preserveEntryInstances: true })
  );
}

// Deletes, in place, the heavy fields not in `keep`.
function stripHeavyFields(entries, keep) {
  const strip = HEAVY_FIELDS.filter((field) => !keep.includes(field));
  if (!strip.length) return entries;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    for (const field of strip) {
      if (entry[field] !== undefined) delete entry[field];
    }
  }

  return entries;
}

// Resolves on the next macrotask, so the last batch of parsed entries isn't
// followed by cloning and sizing the whole catalog in the same tick.
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Required here: models/entries requires this module, and this one needs it
function getAll(blogID) {
  const Entries = require("models/entries");
  return new Promise((resolve, reject) => {
    Entries.getAll(blogID, { onError: reject }, (entries) => resolve(entries));
  });
}

async function getCatalog(blogID, options = {}) {
  const log = options.log || function () {};
  const keep = HEAVY_FIELDS.filter(
    (field) => !options.keep || options.keep.includes(field)
  );
  const cacheID =
    options.cacheID !== undefined
      ? options.cacheID
      : await client.hGet(blogKey.info(blogID), "cacheID");
  const key = createCacheKey(blogID, cacheID, keep);
  const wider = relatedFieldSets(keep, true).map((set) =>
    createCacheKey(blogID, cacheID, set)
  );

  for (const candidate of wider) {
    const cached = entriesCache.get(candidate);
    if (cached) {
      log("entries cache hit");
      cacheMetrics.count(entriesCache, "hit", candidate);
      return stripHeavyFields(cloneEntries(cached.payload), keep);
    }
  }

  for (const candidate of wider) {
    if (inflight.has(candidate)) {
      log("entries cache inflight");
      cacheMetrics.count(entriesCache, "inflight");
      return stripHeavyFields(
        cloneEntries(await inflight.get(candidate)),
        keep
      );
    }
  }

  log("entries cache miss");
  cacheMetrics.count(entriesCache, "miss", key);

  const startedAt = performance.now();
  // What the fill produced and why it was not stored, for the fill's metrics
  let filled;
  let notStoredBecause;
  const promise = getAll(blogID).then(async (entries) => {
    await yieldToEventLoop();

    stripHeavyFields(entries, keep);

    const prepared = prepareCacheValue(entries, {
      preserveEntryInstances: true,
    });
    const immutableCopy = prepared.payload;
    filled = prepared;
    // Entries.getAll can still resolve [] on other transient failures
    // rather than rejecting - see getRange in ./index.js. Caching that []
    // would look identical to a genuinely empty blog and silently hide every
    // post until the cacheID changes or the LRU entry is evicted. Only cache
    // non-empty results; an empty catalog always re-hits Redis, which is
    // cheap.
    // A wider copy stored while this fill was in flight already serves this
    // call's fields, so don't hold the catalog twice.
    const covered = wider.some(
      (candidate) => candidate !== key && entriesCache.has(candidate)
    );
    if (immutableCopy.length === 0) notStoredBecause = "empty";
    else if (covered) notStoredBecause = "covered";

    if (immutableCopy.length > 0 && !covered) {
      entriesCache.set(key, prepared);

      // Any copy that kept fewer fields can now be served from this one,
      // so don't hold the catalog twice.
      for (const set of relatedFieldSets(keep, false)) {
        const narrower = createCacheKey(blogID, cacheID, set);
        if (narrower !== key) entriesCache.delete(narrower);
      }
    }
    return immutableCopy;
  });

  inflight.set(key, promise);

  try {
    const entries = await promise;
    cacheMetrics.fill(entriesCache, key, performance.now() - startedAt, {
      cached: entriesCache.has(key),
      reason: notStoredBecause,
      value: filled,
    });
    return cloneEntries(entries);
  } catch (err) {
    cacheMetrics.fill(entriesCache, key, 0, { failed: true });
    throw err;
  } finally {
    inflight.delete(key);
  }
}

module.exports = getCatalog;
module.exports.HEAVY_FIELDS = HEAVY_FIELDS;
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  entriesCache.clear();
  inflight.clear();
};
module.exports._stats = cacheStats("entries", entriesCache);
