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
// Blogs are iterated with scripts/each/blog.js, which shows a progress line
// (blog position, and the entry being rebuilt within it). They are processed
// one at a time, entries one at a time, each blog under its sync lock. A blog
// whose lock can't be had (it is syncing) is skipped and listed at the end so
// the script can be run again. After a blog's entries are rebuilt its cacheID
// is bumped, as at the end of a sync or rebuild.
//
// Usage:
//   docker exec -it blot-container-green node scripts/entry/rebuild-all.js
//   node scripts/entry/rebuild-all.js [--blog <id|handle>] [--dry-run] [-r] [-s N] [-e N] [-o <blogID>] [-c N]
//
//   --blog     rebuild one blog (full or shortened ID, handle or domain)
//   --dry-run  only count the blogs and entries, change nothing
//
// The rest are the options of scripts/each/blog.js. Blogs are in ID order, so
// positions mean the same thing on every run:
//
//   -r         reverse the order of the blogs
//   -s N       start at the Nth blog. The last blog finished is printed with
//              its position, so a run that was stopped can carry on where it
//              left off
//   -e N       end at the Nth blog
//   -o <id>    rebuild just this blog, by its full ID (repeat for several)
//   -c N       process N blogs at once
//   -p         process all blogs at once. Unbounded, so not recommended here
//
// With -p or -c the blogs finish out of order, so no position is printed to
// resume from, and the progress line doesn't show the entry being rebuilt.

const fs = require("fs-extra");
const Blog = require("models/blog");
const Entries = require("models/entries");
const Entry = require("models/entry");
const localPath = require("helper/localPath");
const clfdate = require("helper/clfdate");
const establishSyncLock = require("sync/establishSyncLock");
const rebuildEntry = require("sync/update/rebuildEntry");
const folderPostSourceFolder = require("sync/update/folderPostSourceFolder");
const eachBlog = require("../each/blog");
const progress = require("../each/progress");

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
  lastBlog: null,
};

const options = require("minimist")(process.argv.slice(2), {
  boolean: ["dry-run", "r", "p"],
  string: ["blog", "o"],
});

const ALLOWED = ["_", "dry-run", "blog", "r", "s", "e", "o", "p", "c"];

const unknown = Object.keys(options)
  .filter((key) => ALLOWED.indexOf(key) === -1)
  .map((key) => (key.length > 1 ? `--${key}` : `-${key}`))
  .concat(options._);

if (unknown.length) {
  console.error(`Unknown argument: ${unknown.join(" ")}`);
  process.exit(1);
}

// A flag missing its value must fail, not fall back to every blog: a bare -o
// parses as "", and a bare -s as true (which each/blog's slice ignores).
const badValue = ["s", "e", "c"]
  .filter((key) => key in options && !(parseInt(options[key], 10) > 0))
  .concat([].concat(options.o === undefined ? [] : options.o).some((id) => !id) ? ["o"] : []);

if (badValue.length) {
  console.error(`-${badValue.join(", -")} needs a value`);
  process.exit(1);
}

// Blogs finishing out of order, and sharing one progress frame stack.
const concurrent = !!options.p || parseInt(options.c, 10) > 1;

// each/blog's blog frame counts from the first blog it is given, which is the
// Nth blog when -s N is passed.
const startOffset = options.s ? parseInt(options.s, 10) - 1 : 0;

// Blogs handed to doThis so far, so a finished blog has a position.
let blogsStarted = 0;

const log = (blog, ...rest) =>
  console.log(clfdate(), blog.id.slice(0, 12), blog.handle || "", ...rest);

const messageOf = (err) => (err && err.message) || String(err);

const fromCallback = (fn) =>
  new Promise((resolve, reject) =>
    fn((err, result) => (err ? reject(err) : resolve(result)))
  );

async function resolveBlog(identifier) {
  const blogIDs = await fromCallback((cb) => Blog.getAllIDs(cb));

  // Not scripts/get/blog.js, which also mints an access token.
  const found =
    (await getBlogBy({ id: identifier })) ||
    (await getBlogBy({ handle: identifier })) ||
    (await getBlogBy({ domain: identifier })) ||
    (await getBlogBy({ id: blogIDs.find((id) => id.indexOf(identifier) === 0) }));

  if (!found) throw new Error(`No blog: ${identifier}`);

  return found;
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

  // Skipped when running concurrently: parallel blogs would share one global
  // frame stack, as in scripts/each/entry.js.
  const bar = concurrent ? null : progress.push("Entry", paths.length);

  try {
    for (const path of paths) {
      try {
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
      } finally {
        if (bar) bar.tick();
      }
    }
  } finally {
    if (bar) bar.pop();
  }

  stats.entriesRebuilt += rebuilt;

  return rebuilt;
}

async function processBlog(blog) {
  if (options["dry-run"]) {
    const count = await fromCallback((cb) => Entries.getAllTotal(blog.id, cb));

    stats.blogsDone++;
    stats.entriesRebuilt += count;
    log(blog, `Would rebuild up to ${count} entries`);
    return;
  }

  const paths = await listEntryPaths(blog);

  log(blog, `Rebuilding ${paths.length} entries`);

  let lock;

  try {
    lock = await establishSyncLock(blog.id);
  } catch (err) {
    stats.blogsSkipped.push({ id: blog.id, handle: blog.handle, reason: messageOf(err) });
    log(blog, "Skipped, could not take the sync lock:", messageOf(err));
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
  log(blog, `Rebuilt ${rebuilt}/${paths.length} entries`);
}

function summarize() {
  const verb = options["dry-run"] ? "Would rebuild" : "Rebuilt";

  console.log(`\n${"=".repeat(60)}`);
  console.log(options["dry-run"] ? "Dry run summary (nothing changed):" : "Rebuild summary:");
  console.log(`  Blogs ${options["dry-run"] ? "counted" : "done"}: ${stats.blogsDone}`);
  console.log(`  Blogs skipped (sync lock busy, or an error): ${stats.blogsSkipped.length}`);
  console.log(`  Entries: ${verb.toLowerCase()} ${stats.entriesRebuilt}`);

  if (!options["dry-run"]) {
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

  // Positions are only in order when blogs are handled one at a time, and
  // mean nothing for -o (or --blog, which is passed on as -o).
  if (stats.lastBlog && !concurrent && !options.o) {
    const { position, id } = stats.lastBlog;

    console.log(`\nLast blog finished: ${position} (${id})`);
    console.log(
      `To resume an interrupted run, pass -s ${position}${options.r ? " -r" : ""}; that blog is rebuilt again, which is harmless.`
    );
  }
}

// Called by each/blog for every blog with an owner. Never passes an error to
// next: whatever goes wrong with one blog is logged, and the next carries on.
function doThis(user, blog, next) {
  const position = ++blogsStarted + startOffset;

  (async () => {
    if (blog.isDisabled) {
      console.log(clfdate(), blog.id.slice(0, 12), "Skipping disabled blog");
      return;
    }

    await processBlog(blog);
  })()
    .catch((err) => {
      console.error(clfdate(), blog.id.slice(0, 12), "Error processing blog:", messageOf(err));
      stats.blogsSkipped.push({ id: blog.id, handle: blog.handle || "", reason: messageOf(err) });
    })
    .then(() => {
      stats.lastBlog = { position, id: blog.id };
      next();
    });
}

function allDone(err) {
  if (err) {
    console.error(err);
    process.exitCode = 1;
  }

  summarize();
  process.exit();
}

async function main() {
  if (options.blog !== undefined) {
    if (!options.blog) throw new Error("--blog needs a value");
    if (options.o) throw new Error("Pass --blog or -o, not both");

    options.o = (await resolveBlog(options.blog)).id;
  }

  console.log(options["dry-run"] ? "Counting entries..." : "Rebuilding entries...");

  eachBlog(doThis, allDone, options);
}

main().catch((err) => {
  console.error(messageOf(err));
  process.exit(1);
});
