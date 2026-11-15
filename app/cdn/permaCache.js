const config = require("config");
const bunnyStorage = require("helper/bunnyStorage");
const purgeCdnUrls = require("helper/purgeCdnUrls");
const contentVersion = require("helper/contentVersion");
const client = require("models/client");
const blogKey = require("models/blog/key");

// Bunny's Perma-Cache keeps a copy of every CDN response in a storage zone,
// at its request path, and serves it without asking the origin. A purge of
// an exact URL deletes that copy and the edge's; wildcard purges don't
// reach it. So whatever Blot stops publishing must be purged URL by URL, or
// it stays public at its old URL indefinitely. This module finds those URLs
// in the storage zone. See "Perma-Cache" in config/storage-bucket/README.md.
//
// Layout, below __bcdn_perma_cache__/pullzone__<pull zone>__<n>/: one
// directory per URL path segment, the last named ___<segment>___ and holding
// the cached response (___file___). So /blog_1/_thumbnails/a/small.jpg is
// blog_1/_thumbnails/a/___small.jpg___/___file___.

const PERMA_ROOT = "__bcdn_perma_cache__/";
const LEAF = /^___(.+)___$/;
const BLOG_ID = /^blog_[a-f0-9]+$/;

// The pull zone's Perma-Cache directory. A full purge of the pull zone starts
// a new one and leaves the old behind, so anything but exactly one means a
// person should look before anything is deleted.
async function root() {
  const prefix = "pullzone__" + config.bunny.pull_zone + "__";
  const dirs = (await bunnyStorage.list(PERMA_ROOT)).filter(
    (entry) => entry.isDirectory && entry.name.startsWith(prefix)
  );

  if (dirs.length !== 1)
    throw new Error(
      "permaCache: expected one " +
        prefix +
        "* directory in " +
        PERMA_ROOT +
        ", found " +
        dirs.length
    );

  return PERMA_ROOT + dirs[0].name + "/";
}

// Every cached URL below dir (relative to base, ending in "/"), as
// { path, storagePath }: path is the URL's path as stored, storagePath the
// directory holding its cached response
async function* cachedBelow(base, dir) {
  for (const entry of await bunnyStorage.list(base + dir)) {
    if (!entry.isDirectory) continue;

    const leaf = LEAF.exec(entry.name);

    if (leaf) {
      yield { path: "/" + dir + leaf[1], storagePath: base + dir + entry.name };
    } else {
      yield* cachedBelow(base, dir + entry.name + "/");
    }
  }
}

// The URL a cached path was requested at. Bunny may store a segment decoded
// or as requested, so decode what can be and encode it as Blot builds links
function urlOf(path) {
  const { encodeFolderPath, decodeFolderPath } = shared();
  return config.cdn.origin + encodeFolderPath(decodeFolderPath(path));
}

// Required when used: replaceFolderLinks/shared requires helper/contentVersion,
// which requires storage/folder, whose writes call purgeFolderFile below
function shared() {
  return require("blog/render/replaceFolderLinks/shared");
}

// Purges a folder file's URL once a write replaces it or a remove or move
// takes it away, given its index record from before. Best effort: the
// weekly sweep removes whatever this misses.
function purgeFolderFile(blogID, path, record) {
  if (!record || record.type !== "file") return;

  const version = contentVersion.fromFolderRecord(record);

  if (!version) return;

  const { folderCdnPath, encodeFolderPath } = shared();

  // Not awaited: a write shouldn't wait for Bunny. purgeCdnUrls logs failures.
  // The form links used before #2695, /folder/v-<version>/<blogID><path>, is
  // still served (by the app, for posts not rebuilt since) and cached at the
  // edge, so it is purged too. Perma-Cache doesn't keep it: its edge rule
  // bypasses Perma-Cache.
  purgeQuietly([
    config.cdn.origin + folderCdnPath(blogID, version, path),
    config.cdn.origin +
      "/folder/v-" +
      version +
      "/" +
      blogID +
      encodeFolderPath(path.normalize("NFC")),
  ]);
}

async function purgeQuietly(urls) {
  try {
    await purgeCdnUrls(urls);
  } catch (err) {
    console.error("permaCache: purging", urls, err);
  }
}

async function blogExists(blogID) {
  return (await client.exists(blogKey.info(blogID))) === 1;
}

// The versions a folder file is linked at now: its content version, as the
// build and templates link it, and its size and mtime token, as the blog's
// large-file redirect does (blog/routes/assets.js). Empty if it isn't a file.
async function currentVersions(blogID, path) {
  const folder = require("storage/folder");
  let stat;

  try {
    stat = await folder.stat(blogID, path, { sha1: true });
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.name === "NotFoundError"))
      return [];
    throw err;
  }

  if (stat.isDirectory) return [];

  return [
    contentVersion.fromFolderRecord({
      size: stat.size,
      modified: stat.modified,
      sha1: stat.sha1,
    }),
    contentVersion.fromFolderStat(stat),
  ];
}

// The stale URLs Perma-Cache holds for an existing blog:
// - a folder file at a version that isn't the file's current one (edited,
//   deleted or renamed since), or with no version at all;
// - a generated file no longer in the bucket;
// - anything at the blog's top level other than folder/ and the generated
//   files' _ directories (left by tests of the URL form).
// v-pending is never perma-cached (its edge rule bypasses Perma-Cache).
// Purging a URL that is still current costs only a refetch from the bucket,
// so a doubtful URL is treated as stale.
async function* staleForBlog(base, blogID) {
  const { decodeFolderPath } = shared();
  let generated = null;

  for (const entry of await bunnyStorage.list(base + blogID + "/")) {
    if (!entry.isDirectory) continue;

    const dir = blogID + "/" + entry.name + "/";

    if (entry.name === "folder") {
      const prefix = "/" + blogID + "/folder/";

      for await (const item of cachedBelow(base, dir)) {
        const match = /^v-([^/]+)(\/.+)$/.exec(item.path.slice(prefix.length));

        if (!match) {
          yield { ...item, reason: "unversioned" };
        } else if (match[1] !== "pending") {
          const current = await currentVersions(
            blogID,
            decodeFolderPath(match[2]).normalize("NFC")
          );

          if (!current.includes(match[1]))
            yield { ...item, reason: current.length ? "replaced" : "removed" };
        }
      }
    } else if (entry.name.startsWith("_")) {
      if (!generated) generated = await generatedFiles(blogID);

      const prefix = "/" + blogID + "/";

      for await (const item of cachedBelow(base, dir)) {
        const relPath = decodeFolderPath(item.path.slice(prefix.length));

        if (!generated.has(relPath.normalize("NFC")) && !generated.has(relPath))
          yield { ...item, reason: "generated file gone" };
      }
    } else {
      for await (const item of cachedBelow(base, dir))
        yield { ...item, reason: "unknown prefix" };
    }
  }
}

async function generatedFiles(blogID) {
  const assets = require("storage/assets");
  const names = new Set();

  for await (const relPath of assets.walk(blogID)) names.add(relPath);

  return names;
}

// Purges each URL, which also deletes its Perma-Cache copy
async function purge(items) {
  return purgeCdnUrls(items.map((item) => urlOf(item.path)));
}

// Every URL Perma-Cache holds for a deleted blog is purged, then its
// directory is deleted, for anything the purges missed. If any purge fails
// the directory is kept, since its listing is what lets the next sweep
// retry: deleting it would leave those edge copies public with nothing left
// to find them by.
async function removeBlog(base, blogID, { apply, onItem }) {
  let count = 0;
  let batch = [];
  let purged = true;

  for await (const item of cachedBelow(base, blogID + "/")) {
    count++;
    if (onItem) onItem(item);
    if (!apply) continue;
    batch.push(item);
    if (batch.length >= 100) {
      if (!(await purge(batch))) purged = false;
      batch = [];
    }
  }

  if (apply) {
    if (batch.length && !(await purge(batch))) purged = false;

    if (purged) {
      await bunnyStorage.remove(base + blogID + "/");
    } else {
      console.error(
        "permaCache: kept " + blogID + "'s directory: some purges failed"
      );
    }
  }

  return count;
}

// Removes from Perma-Cache everything Blot no longer publishes: deleted
// blogs, and each existing blog's stale URLs (staleForBlog). Report-only
// unless apply. Resolves to the totals. Stops before deleting anything if
// more than maxDeletedBlogs blogs look deleted at once, which looks more
// like a broken listing or Redis than real deletions.
async function sweep(options = {}) {
  const apply = !!options.apply;
  const log = options.log || console.log;
  const maxDeletedBlogs = options.maxDeletedBlogs || 50;
  const base = await root();
  const totals = { blogs: 0, deletedBlogs: 0, deletedBlogURLs: 0, stale: 0 };

  let blogIDs = (await bunnyStorage.list(base))
    .filter((entry) => entry.isDirectory && BLOG_ID.test(entry.name))
    .map((entry) => entry.name);

  if (options.blogID) blogIDs = blogIDs.filter((id) => id === options.blogID);

  const deleted = [];

  for (const blogID of blogIDs) {
    if (!(await blogExists(blogID))) deleted.push(blogID);
  }

  if (apply && deleted.length > maxDeletedBlogs && !options.allowManyDeleted)
    throw new Error(
      "permaCache: " +
        deleted.length +
        " blogs in Perma-Cache have no blog in Redis, more than " +
        maxDeletedBlogs +
        ": not deleting anything"
    );

  for (const blogID of blogIDs) {
    totals.blogs++;

    if (deleted.includes(blogID)) {
      const count = await removeBlog(base, blogID, { apply });
      totals.deletedBlogs++;
      totals.deletedBlogURLs += count;
      log(`${blogID} deleted blog: ${count} cached URLs`);
      continue;
    }

    let batch = [];
    let count = 0;

    for await (const item of staleForBlog(base, blogID)) {
      count++;
      log(`${blogID} ${item.reason}: ${item.path}`);
      if (!apply) continue;
      batch.push(item);
      if (batch.length >= 100) {
        await purge(batch);
        batch = [];
      }
    }

    if (apply && batch.length) await purge(batch);

    totals.stale += count;
  }

  log(
    `Perma-Cache sweep (${apply ? "applied" : "report only"}): ` +
      `${totals.blogs} blogs, ${totals.deletedBlogs} deleted ` +
      `(${totals.deletedBlogURLs} URLs), ${totals.stale} stale URLs`
  );

  return totals;
}

// Deletes a top-level directory of Perma-Cache outright, without purging
// its URLs one by one: for the folder/ tree of URLs in the form used before
// #2695 (/folder/v-<version>/blog_<id>/...). Its edge rule, "No Perma-Cache
// for old folder URLs", keeps it from filling again: those URLs are still
// served, by the app, and cached at the edge only, where purgeFolderFile
// purges them on change.
async function removeTopLevel(name) {
  if (!name || name.includes("/") || BLOG_ID.test(name))
    throw new Error("permaCache: not a top-level directory name: " + name);

  const base = await root();
  await bunnyStorage.remove(base + name + "/");
}

module.exports = {
  root,
  cachedBelow,
  purgeFolderFile,
  removeBlog: async (blogID, options = {}) =>
    removeBlog(await root(), blogID, { apply: true, ...options }),
  removeTopLevel,
  sweep,
  urlOf,
};
