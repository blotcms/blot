// A cache for a spec, which the spec closes before it removes the directory
// the cache is in:
//
//   const createCache = require("./helpers/caches");
//   ...
//   await createCache.closeAll();
//   fx.remove(dir);
//
// A cache publishes its counts (a process file under procs/) after each
// reservation and on a timer, and can walk its directory in the background, so
// removing the directory under it can fail with ENOTEMPTY. close() flushes the
// last publish, stops the timers and waits for a walk.
const createCache = require("../../cache");

const open = new Set();

function createTrackedCache(options) {
  const cache = createCache(options);
  open.add(cache);
  return cache;
}

createTrackedCache.closeAll = async function closeAll() {
  const caches = [...open];
  open.clear();
  await Promise.all(caches.map((cache) => cache.close()));
};

module.exports = createTrackedCache;
