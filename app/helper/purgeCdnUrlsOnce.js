const redis = require("models/client");
const hash = require("helper/hash");
const purgeQueue = require("cdn/purgeQueue");

const KEY = "cdn:purged-on-boot";

// Queues the URLs for a purge (cdn/purgeQueue) only if they differ from the
// set last queued, so a boot of the same release (a restart, a node-b, a
// standby host started in a host cycle) calls Bunny for nothing. The URLs
// carry a hash of each file's contents, so the same URLs mean the same
// files. A standby's Redis is a read-only replica: the claim below is
// refused there and nothing is queued. SET ... GET claims atomically, so
// concurrent boots queue once. If they can't be queued the previous value is
// put back so the next boot tries again.
module.exports = async function purgeCdnUrlsOnce(urls, purge = purgeQueue.add) {
  const fingerprint = hash(urls.join("\n"));
  const previous = await redis.set(KEY, fingerprint, { GET: true });

  if (previous === fingerprint) return false;

  let ok = false;

  try {
    ok = (await purge(urls)) !== false;
  } finally {
    if (!ok) {
      if (previous === null) await redis.del(KEY);
      else await redis.set(KEY, previous);
    }
  }

  return ok;
};
