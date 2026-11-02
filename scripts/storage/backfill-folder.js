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
//   --dirty            only the blogs in the mirror's dirty set
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
const File = require("models/file");
const { normalize } = require("models/file/key");
const local = require("storage/folder/local");
const backend = require("storage/folder/s3");
const { DIRTY_KEY } = require("storage/folder/mirror");
const { NotFoundError } = require("storage/folder/errors");
const { createPool } = require("storage/util");
const hold = require("sync/hold");

const MAX_LISTED_ERRORS = 100;

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

function newStats() {
  return {
    files: 0,
    dirs: 0,
    uploads: 0,
    bytes: 0, // uploaded, or to upload
    markers: 0,
    deletes: 0, // paths deleted (a directory counts once)
    retimed: 0,
    hashed: 0,
    errors: 0,
    errorMessages: [],
  };
}

// The changes a blog needs, or made
function differences(stats) {
  return stats.uploads + stats.markers + stats.deletes + stats.retimed;
}

function ancestorsOf(path) {
  const parts = path.split("/").slice(1, -1);
  const result = [];

  for (let i = 1; i <= parts.length; i++) result.push("/" + parts.slice(0, i).join("/"));

  return result;
}

// Compares one blog's folder on disk with its copy in S3 and the index, and
// with apply, brings the copy in line. Resolves to its stats. Must run under
// the blog's sync lock when apply is set.
async function backfillBlog(blogID, options) {
  options = options || {};

  const apply = !!options.apply;
  const stats = newStats();
  const prefix = blogID + "/folder/";

  // What S3 holds: files by path with their sizes, and directory markers
  const objects = new Map();
  const markers = new Set();

  for await (const entry of s3.listEntries(prefix)) {
    const rel = entry.key.slice(prefix.length);

    if (!rel || rel === "/") continue;

    if (rel.slice(-1) === "/") markers.add("/" + rel.slice(0, -1));
    else objects.set("/" + rel, entry.size);
  }

  // Every path on disk, files and directories, as the index spells them
  const seen = new Set();

  function fail(path, err) {
    stats.errors++;

    if (stats.errorMessages.length < MAX_LISTED_ERRORS) {
      stats.errorMessages.push(blogID + " " + JSON.stringify(path) + ": " + ((err && err.code) || "") + " " + ((err && err.message) || err));
    }
  }

  // Paths deleted (or to delete) with everything below them, so nothing
  // below one is deleted again
  const deleted = new Set();

  // Whatever S3 has at path is not what the disk has there: a directory
  // where the disk has a file, or the other way round. Removing a directory
  // takes everything below it.
  async function clear(path, isDirectory) {
    if (isDirectory) deleted.add(path);
    if (apply) await backend.remove(blogID, path);
  }

  async function directory(path) {
    stats.dirs++;

    const record = await File.get(blogID, path);
    const empty = (await local.listNames(blogID, path)).length === 0;

    if ((record && record.type !== "dir") || objects.has(path)) {
      // A file in the way, in the index or in S3
      stats.deletes++;
      await clear(path);
      if (!empty) return;
    } else if (!empty || (record && markers.has(path))) {
      return;
    } else if (record) {
      // The index has the directory but S3 has no marker for it
      await clear(path);
    }

    stats.markers++;
    if (apply) await backend.mkdir(blogID, path);
  }

  async function file(path, stat) {
    stats.files++;

    const record = await File.get(blogID, path);
    const modified = Math.round(stat.modified);
    let upload = false;

    if (!record || record.type !== "file" || !objects.has(path) || markers.has(path)) upload = true;
    else if (record.size !== stat.size || objects.get(path) !== stat.size) upload = true;
    else if (record.modified === modified) upload = false;
    else if (!record.sha1) upload = true;
    else {
      stats.hashed++;

      if ((await local.stat(blogID, path, { sha1: true })).sha1 !== record.sha1) {
        upload = true;
      } else {
        // Same bytes, different time: only the index needs the disk's time
        stats.retimed++;
        if (apply) await File.set(blogID, path, Object.assign({}, record, { modified: modified }));
        return;
      }
    }

    if (!upload) return;

    stats.uploads++;
    stats.bytes += stat.size;

    if ((record && record.type === "dir") || markers.has(path)) await clear(path, true);

    if (!apply) return;

    const source = await local.ensureLocal(blogID, path);

    await backend.writeFrom(blogID, path, source, { modified: stat.modified });
  }

  try {
    for await (const raw of local.walk(blogID, "/", { directories: true })) {
      const path = normalize(raw);

      seen.add(path);

      try {
        const stat = await local.stat(blogID, path);

        if (stat.isDirectory) await directory(path);
        else await file(path, stat);
      } catch (err) {
        fail(path, err);
      }
    }
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;

    // Every object would look stale, but a missing folder is more likely a
    // problem with the disk than a blog with nothing in it, so leave S3 be
    const skip = new Error("no folder on disk");
    skip.code = "ESKIPPED";
    throw skip;
  }

  async function stale(path) {
    if (seen.has(path)) return;

    const lineage = ancestorsOf(path).concat(path);

    if (lineage.some((p) => deleted.has(p))) return;

    // The highest path which is not on disk goes, with everything below it
    const top = lineage.find((p) => !seen.has(p));

    deleted.add(top);
    stats.deletes++;

    if (!apply) return;

    try {
      await backend.remove(blogID, top);
    } catch (err) {
      fail(top, err);
    }
  }

  for (const path of objects.keys()) await stale(path);
  for (const path of markers) await stale(path);
  for await (const path of File.subtree(blogID, "/")) await stale(path);

  return stats;
}

async function blogIDs(options) {
  let ids;

  if (options.blog) ids = [options.blog];
  else if (options.dirty) ids = await client.sMembers(DIRTY_KEY);
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
  const totals = Object.assign(newStats(), { blogs: 0, changed: 0, skipped: [], failed: [] });
  const started = Date.now();

  log(
    "[backfill-folder] " + (apply ? "applying to" : options.mode === "verify" ? "verifying" : "dry run over") +
      " " + ids.length + " blogs, bucket " + config.storage.bucket +
      (config.storage.endpoint ? " at " + config.storage.endpoint : "")
  );

  async function one(blogID) {
    let stats;

    try {
      const work = () => backfillBlog(blogID, { apply: apply, log: log });

      stats = locked ? await hold(blogID, work) : await work();
    } catch (err) {
      if (err.code === "ELOCKED" || err.code === "ESKIPPED") {
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
        "[backfill-folder] " + blogID,
        "files=" + stats.files,
        "dirs=" + stats.dirs,
        (apply ? "uploaded=" : "to-upload=") + stats.uploads + " (" + formatBytes(stats.bytes) + ")",
        "markers=" + stats.markers,
        "deletes=" + stats.deletes,
        "retimed=" + stats.retimed,
        "errors=" + stats.errors
      );
    }

    // The copy now matches the disk, so the blog no longer needs repair
    if (apply && !stats.errors) await client.sRem(DIRTY_KEY, blogID);
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

  if (totals.skipped.length) {
    lines.push("");
    lines.push(totals.skipped.length + " blogs skipped (locked, or no folder on disk), retry each with --blog:");
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
