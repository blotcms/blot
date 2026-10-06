// Rebuilds every entry of every blog from its source file, so that it is baked
// by the current build pipeline (e.g. app/build/plugins/folderAssets turning
// folder links into versioned CDN URLs, and recording dependents under
// lowercased keys - see app/models/entry/key.js).
//
// Only entries are rebuilt, not every file in the blog's folder (that is
// app/sync/rebuild.js): each is rebuilt the way app/sync/update/rebuildDependents.js
// rebuilds a dependent. Deleted entries are skipped, and so are entries whose
// source file has gone (logged, and not dropped).
//
// Blogs are processed one at a time, entries one at a time, each blog under
// its sync lock. A blog whose lock can't be had (it is syncing) is skipped and
// listed at the end so the script can be run again. After a blog's entries
// are rebuilt its cacheID is bumped, as at the end of a sync or rebuild.
//
// Usage:
//   docker exec -it blot-container-green node scripts/entry/rebuild-all.js
//   node scripts/entry/rebuild-all.js [--blog <id|handle>] [--from <blogID>] [--dry-run]
//
//   --blog     rebuild one blog (full or shortened ID, handle or domain)
//   --from     resume: start at this blog ID. Blogs are processed in ID order,
//              and the last blog finished is printed, so a run that was
//              stopped can carry on where it left off
//   --dry-run  only count the blogs and entries, change nothing

const fs = require("fs-extra");
const Blog = require("models/blog");
const Entries = require("models/entries");
const Entry = require("models/entry");
const localPath = require("helper/localPath");
const clfdate = require("helper/clfdate");
const establishSyncLock = require("sync/establishSyncLock");
const rebuildEntry = require("sync/update/rebuildEntry");
const folderPostSourceFolder = require("sync/update/folderPostSourceFolder");

// Errors from build() meaning the source can no longer become an entry, the
// same as rebuildDependents' NO_LONGER_VALID_ERRORS. Here the entry is left
// alone instead of dropped.
const SOURCE_GONE = ["WRONGTYPE", "ENOENT", "EMPTY", "ENOTDIR", "EISDIR", "TOO_MANY_FILES"];

const stats = {
  blogsDone: 0,
  blogsSkipped: [],
  entriesRebuilt: 0,
  entriesMissing: 0,
  entriesFailed: 0,
  lastBlogID: null,
};

const args = process.argv.slice(2);
const options = { dryRun: false };

// A flag missing its value must fail, not fall back to every blog.
function valueFor(flag, value) {
  if (!value || value.startsWith("--")) {
    console.error(`${flag} needs a value`);
    process.exit(1);
  }
  return value;
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--dry-run") options.dryRun = true;
  else if (args[i] === "--blog") options.blog = valueFor(args[i], args[++i]);
  else if (args[i] === "--from") options.from = valueFor(args[i], args[++i]);
  else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}

const log = (blog, ...rest) =>
  console.log(clfdate(), blog.id.slice(0, 12), blog.handle || "", ...rest);

const messageOf = (err) => (err && err.message) || String(err);

const fromCallback = (fn) =>
  new Promise((resolve, reject) =>
    fn((err, result) => (err ? reject(err) : resolve(result)))
  );

async function listBlogIDs() {
  // Sorted so --from means the same thing on every run.
  let blogIDs = (await fromCallback((cb) => Blog.getAllIDs(cb))).sort();

  if (options.blog) {
    // Not scripts/get/blog.js, which also mints an access token.
    const identifier = options.blog;
    const found =
      (await getBlogBy({ id: identifier })) ||
      (await getBlogBy({ handle: identifier })) ||
      (await getBlogBy({ domain: identifier })) ||
      (await getBlogBy({ id: blogIDs.find((id) => id.indexOf(identifier) === 0) }));

    if (!found) throw new Error(`No blog: ${identifier}`);

    return [found.id];
  }

  if (options.from) blogIDs = blogIDs.filter((id) => id >= options.from);

  return blogIDs;
}

// query is { id }, { handle } or { domain } as Blog.get takes it. Resolves to
// null when there is no such blog (or no value to look up).
const getBlogBy = (query) =>
  Object.values(query)[0] === undefined
    ? Promise.resolve(null)
    : fromCallback((cb) => Blog.get(query, cb)).catch(() => null);

const getEntry = (blogID, path) =>
  new Promise((resolve) => Entry.get(blogID, path, resolve));

// Paths of the blog's entries which aren't deleted, in list order. Only paths
// are held, so a blog with thousands of entries isn't held in memory at once.
function listEntryPaths(blog) {
  const paths = [];

  return fromCallback((cb) =>
    Entries.each(
      blog.id,
      (entry, next) => {
        if (!entry.deleted) paths.push(entry.path);
        setImmediate(next);
      },
      cb
    )
  ).then(() => paths);
}

async function rebuildEntries(blog, paths) {
  let rebuilt = 0;

  for (const path of paths) {
    // Read again now the lock is held: a sync may have changed the entry
    // between listing and here.
    const entry = await getEntry(blog.id, path);

    if (!entry || entry.deleted) continue;

    const source = folderPostSourceFolder(entry) || entry.path;

    if (!(await fs.pathExists(localPath(blog.id, source)))) {
      stats.entriesMissing++;
      log(blog, "Skipping, source file no longer exists:", path);
      continue;
    }

    try {
      await fromCallback((cb) => rebuildEntry(blog, entry, cb));
      rebuilt++;
    } catch (err) {
      if (SOURCE_GONE.indexOf(err && err.code) > -1) {
        stats.entriesMissing++;
        log(blog, "Skipping, source can no longer be built:", path, messageOf(err));
      } else {
        stats.entriesFailed++;
        log(blog, "Error rebuilding", path, messageOf(err));
      }
    }
  }

  stats.entriesRebuilt += rebuilt;

  return rebuilt;
}

async function processBlog(blog, position, total) {
  const prefix = `[${position}/${total}]`;

  if (options.dryRun) {
    const count = await fromCallback((cb) => Entries.getAllTotal(blog.id, cb));

    stats.blogsDone++;
    stats.entriesRebuilt += count;
    log(blog, prefix, `Would rebuild up to ${count} entries`);
    return;
  }

  const paths = await listEntryPaths(blog);

  log(blog, prefix, `Rebuilding ${paths.length} entries`);

  let lock;

  try {
    lock = await establishSyncLock(blog.id);
  } catch (err) {
    stats.blogsSkipped.push({ id: blog.id, handle: blog.handle, reason: messageOf(err) });
    log(blog, prefix, "Skipped, could not take the sync lock:", messageOf(err));
    return;
  }

  let rebuilt = 0;

  try {
    rebuilt = await rebuildEntries(blog, paths);
  } finally {
    try {
      await lock.done();
    } catch (err) {
      log(blog, "Error releasing the sync lock", messageOf(err));
    }
  }

  // As app/sync/rebuild.js does: rendered pages are cached against cacheID,
  // and setting it flushes the blog's cache directories too.
  if (rebuilt) {
    await fromCallback((cb) => Blog.set(blog.id, { cacheID: Date.now() }, cb));
  }

  stats.blogsDone++;
  log(blog, prefix, `Rebuilt ${rebuilt}/${paths.length} entries`);
}

function summarize() {
  const verb = options.dryRun ? "Would rebuild" : "Rebuilt";

  console.log(`\n${"=".repeat(60)}`);
  console.log(options.dryRun ? "Dry run summary (nothing changed):" : "Rebuild summary:");
  console.log(`  Blogs ${options.dryRun ? "counted" : "done"}: ${stats.blogsDone}`);
  console.log(`  Blogs skipped (sync lock busy, or an error): ${stats.blogsSkipped.length}`);
  console.log(`  Entries: ${verb.toLowerCase()} ${stats.entriesRebuilt}`);

  if (!options.dryRun) {
    console.log(`  Entries skipped (source file gone): ${stats.entriesMissing}`);
    console.log(`  Entries failed: ${stats.entriesFailed}`);
  } else {
    console.log("  (counts include entries that would be skipped, e.g. deleted ones)");
  }

  if (stats.blogsSkipped.length) {
    console.log("\nBlogs skipped, run again with --blog <id> for each:");
    stats.blogsSkipped.forEach((blog) =>
      console.log(`  ${blog.id} (${blog.handle || "no handle"}): ${blog.reason}`)
    );
  }

  if (stats.lastBlogID) {
    console.log(`\nLast blog finished: ${stats.lastBlogID}`);
    console.log(
      "To resume an interrupted run, pass --from <blog ID>; that blog is rebuilt again, which is harmless."
    );
  }
}

async function main() {
  const blogIDs = await listBlogIDs();

  console.log(
    `${options.dryRun ? "Counting" : "Rebuilding entries for"} ${blogIDs.length} blog${blogIDs.length === 1 ? "" : "s"}` +
      (options.from ? ` from ${options.from}` : "")
  );

  let position = 0;

  for (const blogID of blogIDs) {
    position++;

    try {
      const blog = await fromCallback((cb) => Blog.get({ id: blogID }, cb));

      if (!blog) continue;

      if (blog.isDisabled) {
        console.log(clfdate(), blogID.slice(0, 12), "Skipping disabled blog");
        continue;
      }

      await processBlog(blog, position, blogIDs.length);
    } catch (err) {
      // Whatever went wrong with this blog, carry on with the next.
      console.error(clfdate(), blogID.slice(0, 12), "Error processing blog:", messageOf(err));
      stats.blogsSkipped.push({ id: blogID, handle: "", reason: messageOf(err) });
    }

    stats.lastBlogID = blogID;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .then(() => {
    summarize();
    process.exit();
  });
