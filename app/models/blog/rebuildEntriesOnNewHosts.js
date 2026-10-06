const blogHosts = require("blog/lib/blogHosts");
const clfdate = require("helper/clfdate");

// folderAssets (build/plugins/folderAssets) bakes absolute URLs on the blog's
// own hosts (https://<host>/photo.jpg) into versioned CDN URLs at build time,
// which only works for the hosts the blog had then. When a handle or domain
// is added, entries that already link to the new host would keep the raw URL,
// so rebuild just those, found by scanning their stored HTML for the host.
//
// Blog.set calls this after it has saved, without waiting for it: scanning
// every entry of a large blog is slow and nothing depends on the result (the
// request-time rewrite in blog/render/replaceFolderLinks still covers these
// links until the rebuild finishes). It never throws or calls back; the
// promise it returns always resolves, and only exists so a spec can wait.
//
// `former` is the blog as it was before the change.
module.exports = function rebuildEntriesOnNewHosts(blogID, former) {
  return run(blogID, former).catch(function (err) {
    log(blogID, "Error rebuilding entries for new hosts", err);
  });
};

function log(blogID) {
  console.log.apply(null, [
    clfdate(),
    blogID.slice(0, 12),
    "rebuildEntriesOnNewHosts:",
    ...Array.prototype.slice.call(arguments, 1),
  ]);
}

async function run(blogID, former) {
  // Lazy: these modules require models/blog, which requires this module.
  const Blog = require("models/blog");
  const Entries = require("models/entries");
  const Entry = require("models/entry");
  const establishSyncLock = require("sync/establishSyncLock");
  const rebuildEntry = require("sync/update/rebuildEntry");

  // A brand new blog has no entries to rebuild.
  if (!former || !former.handle) return;

  const blog = await new Promise((resolve, reject) =>
    Blog.get({ id: blogID }, (err, blog) => (err ? reject(err) : resolve(blog)))
  );

  if (!blog || !blog.handle) return;

  const formerHosts = blogHosts(former).map((host) => host.toLowerCase());
  const newHosts = blogHosts(blog)
    .map((host) => host.toLowerCase())
    .filter((host) => formerHosts.indexOf(host) === -1);

  if (!newHosts.length) return;

  const paths = [];

  await new Promise((resolve, reject) =>
    Entries.each(
      blogID,
      function (entry, next) {
        if (!entry.deleted && mentionsHost(entry.html, newHosts))
          paths.push(entry.path);

        setImmediate(next);
      },
      (err) => (err ? reject(err) : resolve())
    )
  );

  if (!paths.length) return;

  log(blogID, "Rebuilding", paths.length, "entries linking to", newHosts);

  // Skip rather than wait if the blog is syncing: this is an optimisation,
  // not something to queue up behind a sync.
  let lock;

  try {
    lock = await establishSyncLock(blogID);
  } catch (err) {
    log(blogID, "Could not acquire sync lock, skipping:", err.message);
    return;
  }

  let rebuilt = 0;

  try {
    for (const path of paths) {
      // Read again under the lock: a sync may have rebuilt or removed it
      // since the scan.
      const entry = await new Promise((resolve) =>
        Entry.get(blogID, path, resolve)
      );

      if (!entry || entry.deleted) continue;

      try {
        await new Promise((resolve, reject) =>
          rebuildEntry(blog, entry, (err) => (err ? reject(err) : resolve()))
        );
        rebuilt++;
      } catch (err) {
        log(blogID, "Error rebuilding", path, err);
      }
    }
  } finally {
    try {
      await lock.done();
    } catch (err) {
      log(blogID, "Error releasing sync lock", err);
    }
  }

  if (!rebuilt) return;

  // Same as the end of a sync: render caches are keyed on cacheID.
  await new Promise((resolve) =>
    Blog.set(blogID, { cacheID: Date.now() }, (err) => {
      if (err) log(blogID, "Error updating cacheID", err);
      resolve();
    })
  );

  log(blogID, "Rebuilt", rebuilt, "entries");
}

function mentionsHost(html, hosts) {
  if (typeof html !== "string") return false;

  const lower = html.toLowerCase();

  return hosts.some((host) => lower.indexOf("//" + host) > -1);
}
