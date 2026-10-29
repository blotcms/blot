// cache.fetch(), logging to the request how the lookup will be served:
//
//   hit       served from the cache
//   miss      this request fills the cache
//   inflight  waits on a fill another request already started
//
// The line is logged before cache.fetch() is called: on a miss, lru-cache
// runs fetchMethod synchronously inside fetch(), so any fill-side log line
// would otherwise come first and take the lookup's +ms. lru-cache can't be
// asked whether a key is mid-fill, so this tracks the fills it starts - every
// render cache is fetched through here. None of them sets a ttl, so an entry
// that's present is never stale.
//
// log is req.log, or anything else that takes the same arguments; callers
// without one (tests, non-HTTP renders) can leave it out.
const filling = new WeakMap();
const cacheMetrics = require("./cacheMetrics");
const { Uncacheable } = require("./uncacheableFetch");

function fetchCached(cache, name, log, key, options) {
  let keys = filling.get(cache);
  if (!keys) filling.set(cache, (keys = new Set()));

  const outcome = cache.has(key) ? "hit" : keys.has(key) ? "inflight" : "miss";
  if (typeof log === "function") log(name, "cache", outcome);
  cacheMetrics.count(cache, outcome, key);

  const startedAt = performance.now();
  const fetching = cache.fetch(key, options);

  if (outcome === "miss") {
    keys.add(key);
    fetching.then(
      (value) => {
        keys.delete(key);
        cacheMetrics.fill(cache, key, performance.now() - startedAt, {
          cached: cache.has(key),
          value,
        });
      },
      (err) => {
        keys.delete(key);
        const elapsed = performance.now() - startedAt;
        // Uncacheable is a finished fill whose value was deliberately not
        // stored (e.g. an empty blog): its callers unwrap the payload
        if (err instanceof Uncacheable) {
          cacheMetrics.fill(cache, key, elapsed, {
            cached: false,
            reason: "uncacheable",
            value: err.payload,
          });
        } else {
          cacheMetrics.fill(cache, key, 0, { failed: true });
        }
      }
    );
  }

  return fetching;
}

module.exports = fetchCached;
