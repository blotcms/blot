// Process-local cache for Entries.getAll, shared by archives.js and
// all_entries.js. Both currently MGET the full entry catalog independently;
// routing them through this module means a request (or a burst of requests)
// that needs both locals only pays for one Redis round trip per cacheID, and
// repeat renders hit the LRU instead of Redis at all.
//
// The catalog is cached without the heavy fields (html, body, ...) that
// neither local references in the requesting view, so a blog whose archives
// and sitemap only print titles and URLs doesn't keep every entry's full
// HTML in memory, nor deep-clone it on every downstream cache miss. Each
// cached copy is keyed on the heavy fields it kept. A request served by a
// copy that kept more than it needs strips the rest from its clone; one that
// needs a field no cached copy kept refetches.
const LRUCache = require("lru-cache").LRUCache;
const { getAll } = require("../../../lib/models");
const { cloneDeep, prepareCacheValue } = require("../../../lib/clone");
const cacheStats = require("../../../lib/cacheStats");
const yieldToEventLoop = require("./yieldToEventLoop");
const projectEntryFields = require("./projectEntryFields");

const { HEAVY_FIELDS, resolveFields } = projectEntryFields;

// The retrieve aliases of the locals this catalog fills. all_entries.js and
// archives.js project with these same lists.
const ALIASES = {
  allEntries: ["allEntries", "all_entries"],
  archives: ["archives"],
};

const entriesCache = new LRUCache({
  max: 200,
  // Byte-capped like the posts/popular_tags caches: a single large blog's
  // full catalog must not evict every other blog sharing this process.
  maxSize: 100 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
});

// Dedupes concurrent misses for the same key (e.g. archives and all_entries
// both missing on the same request) so only one Entries.getAll is in flight -
// even for preview requests, which skip persisting to entriesCache below but
// still benefit from not double-fetching within the same request.
const inflight = new Map();

// The heavy fields the catalog must keep for this request: those either
// local references, across both, so that a view using allEntries and
// archives shares one copy. Every heavy field when a referenced local has no
// fields map (projectEntryFields would then strip nothing), and when neither
// local is referenced at all, so a caller without retrieve metadata gets the
// full catalog. Always in HEAVY_FIELDS order, since it is part of the key.
function heavyFieldsToKeep(retrieve) {
  const keep = new Set();
  let referenced = false;

  for (const aliases of Object.values(ALIASES)) {
    if (!retrieve || !aliases.some((alias) => retrieve[alias] !== undefined)) {
      continue;
    }

    referenced = true;

    const fields = resolveFields(retrieve, aliases);
    if (!fields) return HEAVY_FIELDS.slice();

    for (const field of HEAVY_FIELDS) if (fields[field]) keep.add(field);
  }

  if (!referenced) return HEAVY_FIELDS.slice();

  return HEAVY_FIELDS.filter((field) => keep.has(field));
}

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

function createCacheKey(blog, keep) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
    keep: (keep || HEAVY_FIELDS).join(","),
  });
}

function cloneEntries(value) {
  return cloneDeep(value, { preserveEntryInstances: true });
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

// options.retrieve: the request's retrieve metadata, which decides the heavy
// fields kept (see heavyFieldsToKeep). Without it the catalog is complete.
//
// options.bypassCache: skip reading/writing entriesCache entirely. Used for
// preview renders (req.preview) - a template being edited in preview changes
// on every keystroke/save, so caching its output would either serve stale
// entries or thrash the LRU with one-shot entries no other request will ever
// read again. Concurrent calls still share one in-flight fetch.
// options.log: req.log, told how the lookup was served (see lib/fetchCached).
async function getAllCached(blog, options) {
  const bypassCache = !!(options && options.bypassCache);
  const log = (options && options.log) || function () {};
  const keep = heavyFieldsToKeep(options && options.retrieve);
  const key = createCacheKey(blog, keep);
  const wider = relatedFieldSets(keep, true).map((set) =>
    createCacheKey(blog, set)
  );

  if (!bypassCache) {
    for (const candidate of wider) {
      const cached = entriesCache.get(candidate);
      if (cached) {
        log("entries cache hit");
        return stripHeavyFields(cloneEntries(cached.payload), keep);
      }
    }
  }

  for (const candidate of wider) {
    if (inflight.has(candidate)) {
      log("entries cache inflight");
      return stripHeavyFields(
        cloneEntries(await inflight.get(candidate)),
        keep
      );
    }
  }

  log(bypassCache ? "entries cache bypass" : "entries cache miss");

  const promise = getAll(blog && blog.id).then(async (entries) => {
    // The last batch of entries was just parsed; don't also clone and size
    // the whole catalog in the same tick.
    await yieldToEventLoop();

    stripHeavyFields(entries, keep);

    const prepared = prepareCacheValue(entries, {
      preserveEntryInstances: true,
    });
    const immutableCopy = prepared.payload;
    // Entries.getAll can still resolve [] on other transient failures
    // rather than rejecting - see
    // models/entries/index.js's getRange. Caching that [] would look
    // identical to a genuinely empty blog and silently hide every post
    // until the cacheID changes or the LRU entry is evicted. Only cache
    // non-empty results; an empty catalog always re-hits Redis, which is
    // cheap.
    // A wider copy stored while this fill was in flight already serves this
    // request's fields, so don't hold the catalog twice.
    const covered = wider.some(
      (candidate) => candidate !== key && entriesCache.has(candidate)
    );
    if (!bypassCache && immutableCopy.length > 0 && !covered) {
      entriesCache.set(key, prepared);

      // Any copy that kept fewer fields can now be served from this one,
      // so don't hold the catalog twice.
      for (const set of relatedFieldSets(keep, false)) {
        const narrower = createCacheKey(blog, set);
        if (narrower !== key) entriesCache.delete(narrower);
      }
    }
    return immutableCopy;
  });

  inflight.set(key, promise);

  try {
    return cloneEntries(await promise);
  } finally {
    inflight.delete(key);
  }
}

module.exports = getAllCached;
module.exports.ALIASES = ALIASES;
module.exports._createCacheKey = createCacheKey;
module.exports._heavyFieldsToKeep = heavyFieldsToKeep;
module.exports._clear = function () {
  entriesCache.clear();
  inflight.clear();
};
module.exports._stats = cacheStats("entries", entriesCache);
