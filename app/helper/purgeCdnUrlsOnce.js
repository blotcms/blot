const redis = require("models/client");
const hash = require("helper/hash");
const purgeCdnUrls = require("helper/purgeCdnUrls");

const KEY = "cdn:purged-on-boot";

// Purges the URLs only if they differ from the set last purged, so a boot of
// the same release (a restart, a node-b, a standby host started in a host
// cycle) calls Bunny for nothing. The URLs carry a hash of each file's
// contents, so the same URLs mean the same files. A standby's Redis is a
// read-only replica: the claim below fails there and nothing is purged.
// Claiming before purging makes concurrent boots purge once.
module.exports = async function purgeCdnUrlsOnce(urls, purge = purgeCdnUrls) {
  const fingerprint = hash(urls.join("\n"));

  if ((await redis.get(KEY)) === fingerprint) return false;

  await redis.set(KEY, fingerprint);
  await purge(urls);
  return true;
};
