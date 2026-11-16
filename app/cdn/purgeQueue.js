const config = require("config");
const clfdate = require("helper/clfdate");
const lock = require("helper/lock");
const purgeCdnUrls = require("helper/purgeCdnUrls");
const client = require("models/client");

// CDN URLs waiting to be purged from Bunny, and the purges that drain them.
// Nothing that publishes, builds or deletes waits on Bunny: it adds the URLs
// here, one Redis write, and the worker purges them in the background on
// whichever process holds its lease, usually within a minute. The set
// outlives a deploy, so purges a unit didn't finish are picked up by the
// next one. A URL whose purge keeps failing is given up on after
// MAX_ATTEMPTS; the Perma-Cache sweep (storage/sweep/permaCache) finds what that, or
// anything else, misses.
//
// An entry is a URL. One ending /<blogID>/* is a deleted blog: a wildcard
// purge, then its Perma-Cache directory is deleted (permaCache.removeBlog).

const KEY = "cdn:purge-queue";
const FAILURES = "cdn:purge-queue:failures";
const LEASE = "cdn:purge-queue:lease";

// Purges run 16 at a time (helper/purgeCdnUrls), about 7 s each
const BATCH = 64;
const MAX_ATTEMPTS = 10;

// How often an idle worker looks for new entries, and how long it waits
// after a failure before trying again
const RETRY_EVERY = 30 * 1000;

const DELETED_BLOG = /\/(blog_[a-f0-9]+)\/\*$/;

// Outside production, or without the Bunny key, nothing would drain it
function enabled() {
  return config.environment === "production" && !!config.bunny.secret;
}

// Resolves once the URLs are queued. Never rejects: a purge is best effort,
// so a failure here is logged and left to the sweep.
async function add(urls) {
  urls = (urls || []).filter(Boolean);

  if (!urls.length || !enabled()) return true;

  try {
    await client.sAdd(KEY, urls);
    return true;
  } catch (err) {
    console.error(clfdate(), "purgeQueue: adding", urls, err);
    return false;
  }
}

// Everything the CDN holds for a deleted blog
function blog(blogID) {
  return add([config.cdn.origin + "/" + blogID + "/*"]);
}

// Required when used: replaceFolderLinks/shared and helper/contentVersion
// require storage/folder, which calls folderFile below
function folderLinks() {
  return {
    contentVersion: require("helper/contentVersion"),
    shared: require("blog/render/replaceFolderLinks/shared"),
  };
}

// A folder file's URL, once a write replaces its bytes or a remove or move
// takes it away, given its index record from before
function folderFile(blogID, path, record) {
  if (!record || record.type !== "file") return add([]);

  const { contentVersion, shared } = folderLinks();
  const version = contentVersion.fromFolderRecord(record);

  if (!version) return add([]);

  // The form links used before #2695, /folder/v-<version>/<blogID><path>, is
  // still served (by the app, for posts not rebuilt since) and cached at the
  // edge, so it is purged too. Perma-Cache doesn't keep it: its edge rule
  // bypasses Perma-Cache.
  return add([
    config.cdn.origin + shared.folderCdnPath(blogID, version, path),
    config.cdn.origin +
      "/folder/v-" +
      version +
      "/" +
      blogID +
      shared.encodeFolderPath(path.normalize("NFC")),
  ]);
}

async function purge(url) {
  try {
    const deleted = url.match(DELETED_BLOG);

    // Required when used: storage/sweep/permaCache requires storage/folder
    if (deleted)
      return await require("storage/sweep/permaCache").removeBlog(deleted[1]);

    return await purgeCdnUrls([url], { quiet: true });
  } catch (err) {
    console.error(clfdate(), "purgeQueue: purging", url, err);
    return false;
  }
}

// Purges what is queued, a batch at a time, until the queue is empty, a
// purge fails (the lease waits RETRY_EVERY before the next try), or the
// signal aborts. An entry stays queued until its purge succeeds, so one
// that's cut off by a deploy is purged again by the next holder.
async function drain(signal) {
  while (!(signal && signal.aborted)) {
    const urls = await client.sRandMemberCount(KEY, BATCH);

    if (!urls.length) return;

    const results = await Promise.all(urls.map(purge));
    const done = urls.filter((url, i) => results[i]);
    const failed = urls.filter((url, i) => !results[i]);

    if (done.length)
      await client.multi().sRem(KEY, done).hDel(FAILURES, done).exec();

    for (const url of failed) {
      const attempts = await client.hIncrBy(FAILURES, url, 1);

      if (attempts < MAX_ATTEMPTS) continue;

      console.error(
        clfdate(),
        "purgeQueue: gave up on",
        url,
        "after",
        attempts,
        "failed purges"
      );
      await client.multi().sRem(KEY, url).hDel(FAILURES, url).exec();
    }

    if (failed.length) return;
  }
}

// Runs the worker in the background on whichever process holds the lease.
// Returns the lease, to stop().
function start() {
  return lock.lease(
    LEASE,
    async (signal) => {
      try {
        await drain(signal);
      } catch (err) {
        console.error(clfdate(), "Error: CDN purge queue", err);
      }
    },
    { ttl: 60 * 1000, heartbeat: 15 * 1000, retryEvery: RETRY_EVERY }
  );
}

module.exports = {
  add,
  blog,
  folderFile,
  drain,
  start,
  KEY,
  FAILURES,
  MAX_ATTEMPTS,
};
