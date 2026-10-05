// cache.fetch(), logging to the request how the lookup was served. lru-cache
// records this on `status` before fetch() returns, so the line is logged
// before the fill's first await - its +ms covers the lookup, not the fill:
//
//   hit       served from the cache
//   miss      this request fills the cache
//   inflight  waits on a fill another request already started
//   refresh   refills an expired entry (only caches with a ttl)
//
// log is req.log, or anything else that takes the same arguments; callers
// without one (tests, non-HTTP renders) can leave it out.
function fetchCached(cache, name, log, key, options) {
  const status = {};
  const fetching = cache.fetch(key, { ...options, status });
  if (typeof log === "function") log(name, "cache", status.fetch);
  return fetching;
}

module.exports = fetchCached;
