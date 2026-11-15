const crypto = require("crypto");
const fs = require("fs-extra");
const config = require("config");
const clfdate = require("helper/clfdate");
const lock = require("helper/lock");
const bunnyStorage = require("helper/bunnyStorage");
const purgeCdnUrls = require("helper/purgeCdnUrls");
const contentVersion = require("helper/contentVersion");
const client = require("models/client");
const blogKey = require("models/blog/key");
const templateKey = require("models/template/key");
const {
  GLOBAL_STATIC_DIR,
  GLOBAL_STATIC_SUBDIRECTORIES,
} = require("blog/lib/staticPaths");
const documentationURL = require("documentation/tools/cdn-url-helper");

// Bunny's Perma-Cache keeps a copy of every CDN response in a storage zone,
// at its request path, and serves it without asking the origin. A purge of
// an exact URL deletes that copy and the edge's; wildcard purges reach only
// the edges. So whatever Blot stops publishing, or publishes different
// bytes at, must be purged URL by URL, or it stays public at its old URL
// indefinitely. This module finds those URLs in the storage zone, and runs
// the sweep that removes them. See "Perma-Cache" in
// config/storage-bucket/README.md.
//
// Layout, below __bcdn_perma_cache__/pullzone__<pull zone>__<n>/: one
// directory per URL path segment, the last named ___<segment>___ and holding
// the cached response (___file___). So /blog_1/_thumbnails/a/small.jpg is
// blog_1/_thumbnails/a/___small.jpg___/___file___. A URL cached with a query
// string the pull zone varies by (the fonts' ?version=) is a separate file
// in the same directory, ___file___variation___<hash>, and a purge of the
// plain URL may not reach it.
//
// Each stale copy is either purged, when its URL may still be requested
// (the edges hold it too, and a person may expect it gone: a deleted file, a
// replaced one, a changed static file), or its storage copy is just deleted,
// when nothing links it any more and a request would get the right answer
// from the origin anyway (an old documentation version, a template output
// replaced since). Deleting is one Storage API call; a purge waits about 7 s
// for every edge.

const PERMA_ROOT = "__bcdn_perma_cache__/";
const LEAF = /^___(.+)___$/;
const BLOG_ID = /^blog_[a-f0-9]+$/;
const STATIC_DIRECTORIES = GLOBAL_STATIC_SUBDIRECTORIES.map((dir) =>
  dir.slice(1)
);

// Top-level directories swept at once, and storage copies deleted at once
const CONCURRENCY = 8;

// The resumable sweep (start, below): its state in Redis, and how long after
// a run finishes the next one starts
const STATE = "perma-cache:sweep";
const LEASE = "perma-cache:sweep:lease";
const INTERVAL = 7 * 24 * 60 * 60 * 1000;

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
// directory holding its cached response. With withFile, also files: the
// listing entries (size, checksum, dates) of the cached response and of any
// query-string variations of it, which costs a listing per URL.
async function* cachedBelow(base, dir, options = {}) {
  for (const entry of await bunnyStorage.list(base + dir)) {
    if (!entry.isDirectory) continue;

    const leaf = LEAF.exec(entry.name);

    if (leaf) {
      const item = {
        path: "/" + dir + leaf[1],
        storagePath: base + dir + entry.name,
      };

      if (options.withFile)
        item.files = (await bunnyStorage.list(item.storagePath + "/")).filter(
          (file) => !file.isDirectory
        );

      yield item;
    } else {
      yield* cachedBelow(base, dir + entry.name + "/", options);
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
// sweep removes whatever this misses.
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

// Bunny's dates are UTC without a zone suffix
function storageTime(value) {
  if (!value) return 0;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value + "Z");
}

// The stale URLs Perma-Cache holds for an existing blog, all to purge:
// - a folder file at a version that isn't the file's current one (edited,
//   deleted or renamed since), or with no version at all;
// - a generated file no longer in the bucket, or (under _assets, the one
//   scope whose files are rewritten in place, by a document's conversion)
//   changed in the bucket since Perma-Cache copied it;
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
      const rewritten = entry.name === "_assets";

      for await (const item of cachedBelow(base, dir, {
        withFile: rewritten,
      })) {
        const relPath = decodeFolderPath(item.path.slice(prefix.length));
        const modified =
          generated.get(relPath.normalize("NFC")) || generated.get(relPath);

        if (modified === undefined) {
          yield { ...item, reason: "generated file gone" };
        } else if (
          rewritten &&
          item.files.some((file) => modified > storageTime(file.lastChanged))
        ) {
          yield { ...item, reason: "generated file changed" };
        }
      }
    } else {
      for await (const item of cachedBelow(base, dir))
        yield { ...item, reason: "unknown prefix" };
    }
  }
}

// relPath -> last modified (ms) of every generated file in the bucket
async function generatedFiles(blogID) {
  const assets = require("storage/assets");
  const files = new Map();

  for await (const { relPath, modified } of assets.walkEntries(blogID))
    files.set(relPath, new Date(modified).getTime() || 0);

  return files;
}

// Old documentation versions: /documentation/v-<version><path> where the
// version isn't the file's current one. Nothing links them any more and the
// origin serves the current file whatever the version, so only the storage
// copy is deleted.
async function* staleDocumentation(base) {
  const { decodeFolderPath } = shared();

  for await (const item of cachedBelow(base, "documentation/")) {
    const match = /^\/documentation\/v-([^/]+)(\/.+)$/.exec(item.path);

    if (!match) {
      yield { ...item, reason: "unversioned documentation", remove: true };
      continue;
    }

    const path = decodeFolderPath(match[2]).replace(/\?.*$/, "");
    const current =
      documentationURL.versionOf(config.views_directory, path) ||
      documentationURL.MISSING;

    if (match[1] !== current)
      yield { ...item, reason: "old documentation version", remove: true };
  }
}

// Template outputs whose hash is gone from Redis: /template/<d1>/<d2>/<rest>/<name>.
// The origin 404s them, and a template's save or drop purges its old URLs as
// it goes, so whatever is left only takes space: the storage copy is deleted.
async function* staleTemplateOutputs(base) {
  let batch = [];

  async function* flush() {
    const exists = await Promise.all(
      batch.map(({ hash }) =>
        hash ? client.exists(templateKey.renderedOutput(hash)) : 0
      )
    );

    for (let i = 0; i < batch.length; i++)
      if (!exists[i])
        yield {
          ...batch[i].item,
          reason: "template output gone",
          remove: true,
        };

    batch = [];
  }

  for await (const item of cachedBelow(base, "template/")) {
    const match =
      /^\/template\/([a-f0-9]{2})\/([a-f0-9]{2})\/([a-f0-9]{28})\//.exec(
        item.path
      );

    batch.push({ item, hash: match ? match[1] + match[2] + match[3] : null });

    if (batch.length >= 50) yield* flush();
  }

  if (batch.length) yield* flush();
}

// The global static files (fonts, plugins, ...) at plain paths, which Blot
// and templates link without a version in the path: a URL any of whose
// copies (the plain one and its query-string variations) has bytes that
// differ from the file in this release, or whose file is gone, is purged,
// for the edges, and its directory deleted, for every variation; the
// current ones refill. Bunny lists each stored file's SHA-256.
async function* staleStaticFiles(base, name) {
  const { decodeFolderPath } = shared();
  const hashes = new Map();

  for await (const item of cachedBelow(base, name + "/", { withFile: true })) {
    const path = decodeFolderPath(item.path).replace(/\?.*$/, "");

    if (!hashes.has(path))
      hashes.set(path, await sha256(GLOBAL_STATIC_DIR + path));

    const current = hashes.get(path);
    const stale = { ...item, remove: true, purge: true };

    if (!current) {
      yield { ...stale, reason: "static file gone" };
    } else if (
      item.files.some(
        (file) => file.checksum && file.checksum.toLowerCase() !== current
      )
    ) {
      yield { ...stale, reason: "static file changed" };
    }
  }
}

async function sha256(file) {
  try {
    return crypto
      .createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex");
  } catch (err) {
    return null;
  }
}

// Purges each URL, which also deletes its Perma-Cache copy. False if any
// failed.
async function purge(items) {
  if (!items.length) return true;
  return purgeCdnUrls(
    items.map((item) => urlOf(item.path)),
    { quiet: true }
  );
}

// Deletes the storage copy of each item, CONCURRENCY at a time
async function removeCopies(items) {
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const item = items[i++];
      await bunnyStorage.remove(item.storagePath + "/");
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// A deleted blog: one wildcard purge of its URLs clears the edges, then its
// directory is deleted, which clears Perma-Cache. If the purge fails the
// directory is kept, since it is what lets the next sweep find the blog and
// retry: deleting it would leave the edge copies public with nothing left to
// find them by.
async function removeBlog(base, blogID) {
  if (!(await purgeCdnUrls([config.cdn.origin + "/" + blogID + "/*"]))) {
    console.error(
      clfdate(),
      "permaCache: kept " + blogID + "'s directory: its purge failed"
    );
    return false;
  }

  await bunnyStorage.remove(base + blogID + "/");
  return true;
}

// Sweeps one top-level directory (a blog or one of the shared ones) into
// totals. Report-only unless apply.
async function sweepEntry(base, entry, { apply, log, totals, deleted }) {
  const name = entry.name;

  if (BLOG_ID.test(name) && entry.isDirectory) {
    if (deleted.has(name)) {
      totals.deletedBlogs++;
      log(`${name} deleted blog`);
      if (apply && !(await removeBlog(base, name))) totals.failed++;
      return;
    }

    return applyStale(staleForBlog(base, name), name, { apply, log, totals });
  }

  if (name === "documentation" && entry.isDirectory)
    return applyStale(staleDocumentation(base), name, { apply, log, totals });

  if (name === "template" && entry.isDirectory)
    return applyStale(staleTemplateOutputs(base), name, { apply, log, totals });

  if (STATIC_DIRECTORIES.includes(name) && entry.isDirectory)
    return applyStale(staleStaticFiles(base, name), name, {
      apply,
      log,
      totals,
    });

  // Anything else: the URL form used before #2695 (folder/, no longer
  // perma-cached), a root file, the health check, a test's leftovers.
  // Deleted whole: what is still served refills from the origin.
  totals.stale++;
  log(`${name} not a swept prefix: deleting it`);
  if (apply)
    await bunnyStorage.remove(base + name + (entry.isDirectory ? "/" : ""));
}

// Purges or deletes each stale item, in batches. An item to purge and then
// delete (a static file's directory, holding every variation) keeps its
// storage copy if its purge fails, since that copy is what lets the next
// sweep find the URL and retry: deleting it would leave the edge copies
// public with nothing left to find them by.
async function applyStale(stale, name, { apply, log, totals }) {
  let batch = [];

  async function flush() {
    const items = batch;
    batch = [];

    const purged = await Promise.all(
      items.map((item) => (item.purge || !item.remove ? purge([item]) : true))
    );

    totals.failed += purged.filter((ok) => !ok).length;

    await removeCopies(items.filter((item, i) => item.remove && purged[i]));
  }

  for await (const item of stale) {
    totals.stale++;
    log(`${name} ${item.reason}: ${item.path}`);
    if (!apply) continue;
    batch.push(item);
    if (batch.length >= 100) await flush();
  }

  if (apply) await flush();
}

// The blogs in Perma-Cache with no blog in Redis
async function deletedBlogs(entries) {
  const deleted = new Set();

  for (const entry of entries) {
    if (
      entry.isDirectory &&
      BLOG_ID.test(entry.name) &&
      !(await blogExists(entry.name))
    )
      deleted.add(entry.name);
  }

  return deleted;
}

function newTotals() {
  return { entries: 0, deletedBlogs: 0, stale: 0, failed: 0 };
}

// Stops before deleting anything if more than maxDeletedBlogs blogs look
// deleted at once, which looks more like a broken listing or Redis than
// real deletions
function checkDeleted(deleted, options) {
  const maxDeletedBlogs = options.maxDeletedBlogs || 50;

  if (
    options.apply &&
    deleted.size > maxDeletedBlogs &&
    !options.allowManyDeleted
  )
    throw new Error(
      "permaCache: " +
        deleted.size +
        " blogs in Perma-Cache have no blog in Redis, more than " +
        maxDeletedBlogs +
        ": not deleting anything"
    );
}

// Sweeps entries (top-level listing entries, sorted), CONCURRENCY at a time.
// After each, onDone(name) is called with the name below which everything
// has been swept, for a run to resume from. Stops starting new entries once
// signal aborts.
async function sweepEntries(base, entries, context, { signal, onDone } = {}) {
  const done = new Array(entries.length).fill(false);
  let next = 0;
  let resumeFrom = 0;

  async function worker() {
    while (next < entries.length && !(signal && signal.aborted)) {
      const index = next++;
      const entry = entries[index];

      try {
        await sweepEntry(base, entry, context);
      } catch (err) {
        context.totals.failed++;
        console.error(clfdate(), "permaCache: sweeping", entry.name, err);
      }

      context.totals.entries++;
      done[index] = true;

      if (onDone) {
        while (resumeFrom < entries.length && done[resumeFrom]) resumeFrom++;
        if (resumeFrom > 0) await onDone(entries[resumeFrom - 1].name);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

// Removes from Perma-Cache everything Blot no longer publishes, in one go:
// for a person running it by hand (scripts/storage/perma-cache-sweep.js).
// Report-only unless apply. Resolves to the totals.
async function sweep(options = {}) {
  const apply = !!options.apply;
  const log = options.log || console.log;
  const base = await root();
  const totals = newTotals();

  let entries = sortByName(await bunnyStorage.list(base));

  if (options.only) entries = entries.filter((e) => e.name === options.only);

  const deleted = await deletedBlogs(entries);

  checkDeleted(deleted, { ...options, apply });

  await sweepEntries(base, entries, { apply, log, totals, deleted });

  log(
    `Perma-Cache sweep (${apply ? "applied" : "report only"}): ` +
      JSON.stringify(totals)
  );

  return totals;
}

function sortByName(entries) {
  return entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
}

// One step of the resumable sweep, run by start() below whenever it holds
// the lease: starts a run if the last finished INTERVAL ago, or resumes the
// one in progress from its cursor (the name below which everything has been
// swept), saving the cursor as it goes. A deploy that kills it loses at most
// the directories in progress, which the next holder sweeps again.
async function step(signal, options = {}) {
  const now = options.now || Date.now;
  const state = await client.hGetAll(STATE);

  if (!state.startedAt) {
    if (state.finishedAt && now() - Number(state.finishedAt) < INTERVAL)
      return null;

    await client.hSet(STATE, { startedAt: String(now()), cursor: "" });
    await client.hDel(STATE, "totals");
    state.startedAt = String(now());
    state.cursor = "";
    delete state.totals;
  }

  const base = await root();
  const all = sortByName(await bunnyStorage.list(base));
  const entries = all.filter((entry) => entry.name > (state.cursor || ""));
  const totals = state.totals ? JSON.parse(state.totals) : newTotals();
  const deleted = await deletedBlogs(entries);

  try {
    checkDeleted(deleted, { apply: true });
  } catch (err) {
    // Not retried until the next run: a person should look first
    await finish(state, totals, now, err.message);
    throw err;
  }

  await sweepEntries(
    base,
    entries,
    { apply: true, log: () => {}, totals, deleted },
    {
      signal,
      onDone: (name) =>
        client.hSet(STATE, { cursor: name, totals: JSON.stringify(totals) }),
    }
  );

  if (signal && signal.aborted) return null;

  await finish(state, totals, now);
  console.log(clfdate(), "Perma-Cache sweep:", JSON.stringify(totals));
  return totals;
}

async function finish(state, totals, now, error) {
  await client
    .multi()
    .hSet(STATE, {
      finishedAt: String(now()),
      totals: JSON.stringify(totals),
      error: error || "",
    })
    .hDel(STATE, ["startedAt", "cursor"])
    .exec();
}

// Runs the sweep in the background on whichever process holds the lease,
// checking hourly whether a run is due. Returns the lease, to stop().
function start() {
  return lock.lease(
    LEASE,
    async (signal) => {
      try {
        await step(signal);
      } catch (err) {
        console.error(clfdate(), "Error: Perma-Cache sweep", err);
      }
    },
    { ttl: 60 * 1000, heartbeat: 15 * 1000, retryEvery: 60 * 60 * 1000 }
  );
}

module.exports = {
  root,
  cachedBelow,
  purgeFolderFile,
  removeBlog: async (blogID) => removeBlog(await root(), blogID),
  sweep,
  step,
  start,
  urlOf,
  STATE,
};
