const config = require("config");
const { promisify } = require("util");
const clfdate = require("helper/clfdate");
const lock = require("helper/lock");
const s3 = require("storage/s3");
const client = require("models/client");
const Blog = require("models/blog");
const blogKey = require("models/blog/key");
const File = require("models/file");
const { normalize } = require("models/file/key");
const local = require("./local");
const backend = require("./s3");
const mirror = require("./mirror");
const { NotFoundError } = require("./errors");
const hold = require("sync/hold");

const { DIRTY_KEY } = mirror;

// Keeps a blog's copy of its folder in the storage bucket (objects under
// folder/{blogID}/ and the models/file index) in line with the folder on
// disk, which stays authoritative (#2258 Phase C). The mirror (mirror.js)
// copies every change as it is made; this finds and repairs the ones it
// missed: a write which failed (the blog is then in the dirty set), a crash
// between the disk write and the mirror, or a change made outside Blot.
//
// backfillBlog compares one blog and, with apply, repairs it. It is what
// scripts/storage/backfill-folder.js runs for a person; reconcile() at the
// end is what the scheduler runs (app/scheduler/index.js), unattended.

const MAX_LISTED_ERRORS = 100;

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
  return stats.uploads + stats.markers + stats.deletes + stats.retimed + (stats.removedObjects || 0);
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
  const prefix = backend.root(blogID);

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

// A blog which no longer exists (deleted while a mirror failure left its copy
// in S3) has no disk or index to compare with, so its whole copy goes:
// every object under folder/{blogID}/, markers included, and any index left.
// Resolves to the number of objects there were.
async function removeDeletedBlog(blogID, apply) {
  let objects = 0;

  for await (const entry of s3.listEntries(backend.root(blogID))) if (entry.key) objects++;

  if (apply) {
    await backend.removeAll(blogID);
    await client.sRem(DIRTY_KEY, blogID);
  }

  return objects;
}


// ---- The scheduled job ----

// Two kinds of run, because they cost very different amounts:
//
//   "dirty"  hourly: repairs the blogs in the dirty set. The set is usually
//            empty, so a run is one Redis read, and an hour is soon enough
//            for a failed write to be put right without anyone asking.
//   "full"   daily, at a quiet hour: compares every mirrored blog with its
//            disk. That lists the blog's objects in S3 and stats every file,
//            for every blog, so it is not run more often. It catches what the
//            dirty set cannot: changes the mirror never saw.
//
// A blog which differs is repaired in the same run, and reported.

// Pause between blogs, so a run over many blogs leaves the event loop free
// for requests and the units' health checks. A blog's own work is
// asynchronous I/O; this stops a run from going from one blog straight to the
// next for hours.
const PAUSE_MS = 100;

// A persistent problem (a folder missing from disk, say) is found again by
// every run, so the email is limited to one per kind of run in this long.
const EMAIL_QUIET_MS = 12 * 60 * 60 * 1000;

const NOTIFIED_KEY = "notify:folder-mirror-reconcile:";

const LOG_PREFIX = "[storage/folder reconcile]";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Whether the scheduled job has anything to do at all
function enabled() {
  const setting = String(config.folder_mirror || "").trim();

  return !!setting && setting !== "off" && !!(config.storage && config.storage.bucket);
}

// Every blog ID, a page at a time, so thousands of blogs are never held
// together. A page can repeat an ID, which does no harm.
async function* eachBlogID() {
  let cursor = "0";

  do {
    const page = await client.sScan(blogKey.ids, cursor, { COUNT: 100 });

    cursor = String(page.cursor);

    for (const id of page.members) yield id;
  } while (cursor !== "0");
}

// The blogs to check in a full run: those the mirror is on for
async function* mirroredBlogIDs() {
  for await (const id of eachBlogID()) if (mirror.enabledFor(id)) yield id;
}

async function* dirtyBlogIDs() {
  const ids = (await client.sMembers(DIRTY_KEY)).sort();

  for (const id of ids) yield id;
}

async function hasObjects(blogID) {
  for await (const entry of s3.listEntries(backend.root(blogID))) if (entry) return true;

  return false;
}

// Checks one blog and repairs it if need be, recording what happened in
// report. With check set (a full run) a blog is only changed if it differs;
// without it (a dirty blog) it is repaired at once, since it is known to be
// behind. Never rejects.
async function reconcileBlog(blogID, check, report) {
  try {
    // A blog deleted while a mirror failure left its copy in S3
    if (!(await promisify(Blog.get)({ id: blogID }))) {
      if (!check || (await hasObjects(blogID))) {
        await removeDeletedBlog(blogID, true);
        report.drifted.push(blogID);
        report.repaired.push(blogID);
      }

      return;
    }

    await hold(blogID, async function () {
      if (check) {
        const found = await backfillBlog(blogID, { apply: false });

        report.checked++;

        if (!differences(found) && !found.errors) return;

        report.drifted.push(blogID);
      }

      const stats = await backfillBlog(blogID, { apply: true });

      if (stats.errors) {
        // Left in the dirty set (put there if the check found it), so the
        // hourly run tries again
        await client.sAdd(DIRTY_KEY, blogID);
        report.errored.push(blogID);

        for (const message of stats.errorMessages.slice(0, 3)) console.error(clfdate(), LOG_PREFIX, message);
      } else {
        await client.sRem(DIRTY_KEY, blogID);
        report.repaired.push(blogID);
      }
    });
  } catch (err) {
    if (err.code === "ELOCKED") {
      // A sync is running. The blog stays dirty and is tried next time.
      report.locked.push(blogID);
    } else if (err.code === "ESKIPPED") {
      // No folder on disk: never emptied in S3, but not repairable either
      report.skipped.push(blogID);
    } else {
      // Thrown before or during the check (S3 or Redis briefly failing, say):
      // put in the dirty set, so the hourly run tries again rather than the
      // next daily one
      await client.sAdd(DIRTY_KEY, blogID).catch(function () {});
      report.errored.push(blogID);
      console.error(clfdate(), LOG_PREFIX, "failed blog=" + blogID, ((err && err.code) || "") + " " + ((err && err.message) || err));
    }
  }
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

// What the email says: counts and blog IDs only. File names are customers'
// and stay on the host, in the log.
function emailView(report) {
  const parts = [];

  if (report.drifted.length) parts.push(plural(report.drifted.length, "blog") + " differed from the disk");
  if (report.repaired.length) parts.push(plural(report.repaired.length, "blog") + " repaired");
  if (report.errored.length) parts.push(plural(report.errored.length, "blog") + " still wrong");
  if (report.skipped.length) parts.push(plural(report.skipped.length, "blog") + " with no folder on disk");

  return {
    mode: report.mode,
    full: report.mode === "full",
    summary: parts.join(", "),
    checked: report.checked,
    hasDrifted: report.drifted.length > 0,
    drifted: report.drifted.join(", "),
    hasErrored: report.errored.length > 0,
    errored: report.errored.join(", "),
    hasSkipped: report.skipped.length > 0,
    skipped: report.skipped.join(", "),
    hasLocked: report.locked.length > 0,
    locked: report.locked.length,
    seconds: report.seconds,
  };
}

// Blogs which were locked are only tried again next time, so they are in the
// log but do not make an email.
function worthEmail(report) {
  return !!(report.drifted.length || report.repaired.length || report.errored.length || report.skipped.length);
}

function sendEmail(view) {
  const email = require("helper/email");

  return new Promise((resolve, reject) =>
    email.FOLDER_MIRROR_RECONCILE(null, view, (err) => (err ? reject(err) : resolve()))
  );
}

// options:
//   mode       "dirty" or "full" (see above)
//   sendEmail  async (view); defaults to the FOLDER_MIRROR_RECONCILE email
//   pauseMs    between blogs (PAUSE_MS)
//   quietMs    least time between emails of one kind of run (EMAIL_QUIET_MS)
// Resolves to the report, or to null when there was nothing to do because the
// mirror is off. Failures of single blogs are in the report, not thrown.
async function reconcile(options) {
  options = options || {};

  if (!enabled()) return null;

  const mode = options.mode === "full" ? "full" : "dirty";
  const pauseMs = options.pauseMs === undefined ? PAUSE_MS : options.pauseMs;
  const quietMs = options.quietMs === undefined ? EMAIL_QUIET_MS : options.quietMs;
  const started = Date.now();
  const report = { mode, checked: 0, drifted: [], repaired: [], errored: [], locked: [], skipped: [] };

  for await (const blogID of mode === "full" ? mirroredBlogIDs() : dirtyBlogIDs()) {
    await reconcileBlog(blogID, mode === "full", report);
    await sleep(pauseMs);
  }

  report.seconds = Math.round((Date.now() - started) / 100) / 10;

  console.log(
    clfdate(),
    LOG_PREFIX,
    mode,
    "checked=" + report.checked,
    "differed=" + report.drifted.length,
    "repaired=" + report.repaired.length,
    "failed=" + report.errored.length,
    "no-folder=" + report.skipped.length,
    "locked=" + report.locked.length,
    "seconds=" + report.seconds
  );

  if (worthEmail(report) && (!quietMs || (await lock.once(NOTIFIED_KEY + mode, quietMs)))) {
    try {
      await (options.sendEmail || sendEmail)(emailView(report));
      report.emailed = true;
    } catch (err) {
      console.error(clfdate(), LOG_PREFIX, "could not send the email:", err.message);
    }
  }

  return report;
}

module.exports = {
  reconcile,
  enabled,
  backfillBlog,
  removeDeletedBlog,
  newStats,
  differences,
  MAX_LISTED_ERRORS,
};
