// Brings each blog's copy of its folder in the storage bucket (objects under
// {blogID}/folder/ and the models/file index) in line with the folder on
// disk, which stays authoritative (#2258 Phase C). Run it once a blog is
// mirrored (config.folder_mirror, BLOT_FOLDER_MIRROR) to copy what was there
// before, and again for any blog in the mirror's dirty set
// (storage:folder:mirror:dirty) after a mirrored write failed. Safe to rerun:
// a blog already in line costs a listing and a stat per file.
//
//   node scripts/storage/backfill-folder.js [options]
//
//   --dry-run          report what would change (the default)
//   --apply            make the changes
//   --verify           change nothing; exit non-zero if anything differs
//   --blog <blogID>    only this blog
//   --from <blogID>    start at this blog (inclusive, in ID order), to resume
//   --dirty            only the blogs in the mirror's dirty set, or whose
//                      disk copy is behind S3
//   --concurrency <n>  blogs at once (default 4); a blog's own changes are
//                      made one at a time, since models/file expects a single
//                      writer per blog
//
// For each blog it lists the bucket under {blogID}/folder/, walks the folder
// on disk, and then:
//
// - uploads every file which is missing in S3 or the index, or differs: by
//   size, then by modified time, then, when the times differ and the index
//   has a SHA-1, by the SHA-1 of the file on disk (computed only then). A
//   file whose bytes match but whose time differs only has its time
//   corrected in the index. The upload keeps the file's modified time.
// - writes a marker for every empty directory on disk which has none;
// - deletes objects and index records for paths which are not on disk.
//
// A blog on S3 (config.folder_primary, BLOT_FOLDER_PRIMARY, #2258 Phase D)
// is done the other way round: S3 is its source of truth, so its copy on
// disk, kept for rolling back, is brought in line with S3 (its index) by the
// same rules, and nothing in S3 changes. That is how to restore a blog's disk
// before taking it off S3. Any other blog is backfilled as usual. --apply
// takes it out of the set of complete copies (storage:folder:mirror:complete)
// while it runs and, for a mirrored blog, puts it back once it has finished
// with no errors, as --verify does when it finds nothing to change; a blog
// named for S3 moves there only while it is in that set. A blog off S3 whose disk
// copy is marked as behind S3 is refused: put it back on S3 and run this to
// restore its disk first. --dirty covers both dirty sets.
//
// A blog named by --blog or --dirty which no longer exists (its deletion
// could not delete its copy) has its whole copy in S3 and any index removed,
// without the disk, and leaves the dirty set. An existing blog with no folder
// on disk is skipped, never emptied in S3.
//
// --apply and --verify run each blog holding its sync lock (sync/hold.js,
// which takes the lock as sync() does but does nothing else), so nothing
// writes the folder meanwhile. Disabled blogs are included. A blog which is
// locked (a sync is running) is skipped and listed, to retry with --blog.
// That also means a sync of a blog which waits more than a few seconds for
// the backfill fails, as it would behind any long sync, so apply a large
// blog when it is quiet. A blog with no folder on disk is skipped too. A dry
// run takes no lock. A blog applied without errors leaves the dirty set.
//
// Needs BLOT_STORAGE_BUCKET and credentials (see
// config/storage-bucket/README.md). On the production host, as the user
// which owns the blog folders:
//
//   docker exec -u 1000 <container> node scripts/storage/backfill-folder.js --blog <blogID>

const config = require("config");
const { promisify } = require("util");
const s3 = require("storage/s3");
const client = require("models/client");
const Blog = require("models/blog");
const { DIRTY_KEY } = require("storage/folder/mirror");
const primary = require("storage/folder/primary");
const { createPool } = require("storage/util");
const hold = require("sync/hold");
const {
  backfillBlog,
  compareBlog,
  dirtyKeyOf,
  removeDeletedBlog,
  newStats,
  differences,
  MAX_LISTED_ERRORS,
} = require("storage/folder/reconcile");

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/backfill-folder.js [--dry-run | --apply | --verify]" +
      " [--blog <blogID>] [--from <blogID>] [--dirty] [--concurrency <n>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { mode: "dry-run", concurrency: 4 };
  const modes = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--dry-run" || arg === "--apply" || arg === "--verify") modes.push(arg.slice(2));
    else if (arg === "--dirty") options.dirty = true;
    else if (arg === "--blog" || arg === "--from" || arg === "--concurrency") {
      const value = argv[++i];

      if (!value) usage(arg + " needs a value");

      if (arg === "--concurrency") {
        options.concurrency = parseInt(value, 10);
        if (!(options.concurrency >= 1)) usage("--concurrency must be 1 or more");
      } else {
        options[arg.slice(2)] = value;
      }
    } else {
      usage("Unknown argument " + arg);
    }
  }

  if (modes.length > 1) usage("Use one of --dry-run, --apply and --verify");
  if (modes.length) options.mode = modes[0];

  return options;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;

  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }

  return (i ? bytes.toFixed(1) : Math.round(bytes)) + " " + units[i];
}

async function blogIDs(options) {
  let ids;

  if (options.blog) ids = [options.blog];
  else if (options.dirty) ids = Array.from(new Set((await client.sMembers(DIRTY_KEY)).concat(await client.sMembers(primary.DIRTY_KEY))));
  else ids = await promisify(Blog.getAllIDs)();

  ids = ids.slice().sort();

  if (options.from) ids = ids.filter((id) => id >= options.from);

  return ids;
}

// options: mode ("dry-run", "apply" or "verify"), blog, from, dirty,
// concurrency, log. Resolves to a summary of the run.
async function run(options) {
  options = Object.assign({ mode: "dry-run", concurrency: 4 }, options);

  const log = options.log || console.log;
  const apply = options.mode === "apply";
  const locked = options.mode !== "dry-run";
  const ids = await blogIDs(options);
  const totals = Object.assign(newStats(), {
    blogs: 0,
    changed: 0,
    skipped: [],
    failed: [],
    removedBlogs: 0,
    removedObjects: 0,
  });
  const started = Date.now();

  log(
    "[backfill-folder] " + (apply ? "applying to" : options.mode === "verify" ? "verifying" : "dry run over") +
      " " + ids.length + " blogs, bucket " + config.storage.bucket +
      (config.storage.endpoint ? " at " + config.storage.endpoint : "")
  );

  async function one(blogID) {
    let stats;
    let direction;

    try {
      // Only --blog and --dirty can name a blog which no longer exists
      if (!(await promisify(Blog.get)({ id: blogID }))) {
        const objects = await removeDeletedBlog(blogID, apply);

        totals.removedBlogs++;
        totals.removedObjects += objects;
        log("[backfill-folder] " + blogID + " deleted blog: " + (apply ? "removed " : "would remove ") + objects + " objects");
        return;
      }

      const work = async function () {
        const result = await compareBlog(blogID, { apply: apply, locked: locked, log: log });

        direction = result.direction;

        // The copy now matches its source, so the blog no longer needs
        // repair. Cleared before the lock is released, so a mirror (or disk
        // copy) failure in a sync which runs after this backfill is never
        // erased.
        if (apply && !result.stats.errors) await client.sRem(dirtyKeyOf(result.direction), blogID);

        return result.stats;
      };

      stats = locked ? await hold(blogID, work) : await work();
    } catch (err) {
      if (err.code === "ELOCKED" || err.code === "ESKIPPED" || err.code === "ECONFLICT") {
        totals.skipped.push(blogID);
        log("[backfill-folder] " + blogID + " skipped: " + err.message);
      } else {
        totals.failed.push(blogID);
        totals.errors++;
        totals.errorMessages.push(blogID + ": " + (err.stack || err.message));
        log("[backfill-folder] " + blogID + " failed: " + err.message);
      }
      return;
    }

    totals.blogs++;
    if (differences(stats)) totals.changed++;

    for (const name of ["files", "dirs", "uploads", "bytes", "markers", "deletes", "retimed", "hashed", "errors"]) {
      totals[name] += stats[name];
    }

    totals.errorMessages.push(...stats.errorMessages.slice(0, MAX_LISTED_ERRORS - totals.errorMessages.length));

    if (stats.errors) totals.failed.push(blogID);

    if (differences(stats) || stats.errors) {
      log(
        "[backfill-folder] " + blogID + (direction === "disk" ? " (on S3: its disk copy)" : ""),
        "files=" + stats.files,
        "dirs=" + stats.dirs,
        (apply ? "uploaded=" : "to-upload=") + stats.uploads + " (" + formatBytes(stats.bytes) + ")",
        "markers=" + stats.markers,
        "deletes=" + stats.deletes,
        "retimed=" + stats.retimed,
        "errors=" + stats.errors
      );
    }
  }

  const pool = createPool(options.concurrency);

  for (const blogID of ids) await pool.add(() => one(blogID));

  await pool.drain();

  totals.seconds = (Date.now() - started) / 1000;

  return totals;
}

function summarise(totals, options) {
  const lines = [""];
  const verb = options.mode === "apply" ? "" : "would ";

  lines.push(
    "Compared " + totals.files + " files and " + totals.dirs + " directories in " + totals.blogs +
      " blogs in " + totals.seconds.toFixed(1) + "s (" + totals.hashed + " files hashed)"
  );
  lines.push(
    totals.changed + " blogs " + (options.mode === "apply" ? "changed" : "differ") + ": " +
      verb + "upload " + totals.uploads + " files (" + formatBytes(totals.bytes) + "), " +
      verb + "write " + totals.markers + " directory markers, " +
      verb + "delete " + totals.deletes + " paths, " +
      verb + "correct " + totals.retimed + " modified times"
  );

  if (totals.removedBlogs) {
    lines.push(
      totals.removedBlogs + " deleted blogs: " + verb + "remove " + totals.removedObjects + " objects left in S3"
    );
  }

  if (totals.skipped.length) {
    lines.push("");
    lines.push(totals.skipped.length + " blogs skipped (locked, no folder on disk, or a disk copy behind S3), retry each with --blog:");
    for (const id of totals.skipped) lines.push("  " + id);
  }

  if (totals.errorMessages.length) {
    lines.push("");
    lines.push("Errors" + (totals.errors > totals.errorMessages.length ? " (the first " + totals.errorMessages.length + ")" : "") + ":");
    for (const message of totals.errorMessages) lines.push("  " + message);
  }

  lines.push("");
  lines.push(totals.errors + " errors");

  if (options.mode === "dry-run") lines.push("Dry run: pass --apply to make these changes");

  return lines.join("\n");
}

// The exit code for a run
function exitCode(totals, options) {
  if (totals.errors) return 1;
  if (options.mode === "verify" && (differences(totals) || totals.skipped.length)) return 1;
  return 0;
}

module.exports = { run, backfillBlog, summarise, exitCode };

if (require.main === module) {
  const options = parse(process.argv.slice(2));

  (async function () {
    try {
      s3.assertConfigured();
    } catch (err) {
      console.error(err.message);
      return 2;
    }

    const totals = await run(options);

    console.log(summarise(totals, options));

    return exitCode(totals, options);
  })().then(
    function (code) {
      process.exit(code);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}
