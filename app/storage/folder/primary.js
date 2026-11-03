var config = require("config");
var clfdate = require("helper/clfdate");
var local = require("./local");
var mirror = require("./mirror");

// S3 as a blog's primary store (#2258 Phase D), per blog, behind
// config.folder_primary. For a blog it names, index.js sends every read and
// write to the S3 backend instead of the disk, so S3 and models/file are the
// blog's source of truth. Unset, nothing changes: every blog is on disk.
//
// usesS3(blogID) decides, per call. A named blog stays on disk, logged once
// per process, unless all of these hold:
//
// - The mirror covers it (config.folder_mirror), so whenever it is on disk,
//   for whatever reason below, S3 is kept in step and can be trusted when
//   it moves back. Without that, a blog which left S3 and came back (a
//   client switched and switched back, say) would read a stale copy.
// - Its copy in S3 is complete (mirror.COMPLETE_KEY): a backfill or the
//   reconcile last finished or checked it with no errors. An index alone
//   proves nothing, since the mirror starts one with a blog's first
//   mirrored write, before its backfill. Starting a backfill takes the blog
//   out of the set, so one half way through is still read from disk, and it
//   moves over by itself once a clean backfill or daily check puts it back.
//   A complete blog whose folder is empty (no index at all) stays on S3.
// - Its mirror is not dirty (mirror.DIRTY_KEY): S3 may be behind the disk.
// - Its client works on a folder in S3. The Local client watches the folder
//   on disk with chokidar, and the Google Drive client reads the disk's own
//   directory entries and times, so blogs on either stay on disk
//   (DISK_CLIENTS). The Git client reads and writes the folder through
//   storage/folder alone (#2259).
//
// The disk copy: for a blog on S3, every change is made in S3 first, which is
// what the caller waits for and what counts, then copied to disk (copy(), the
// mirror's copier run the other way round). A failure to copy is logged and
// the blog added to DIRTY_KEY, for the reconcile to repair from S3; it never
// fails the caller. Disk then stays a complete copy, so rolling a blog back is
// taking it out of the flag, once it is out of DIRTY_KEY. A blog on S3 is
// never mirrored: index.js mirrors only what it sent to disk.

var LOG_PREFIX = "[storage/folder primary]";

// Blogs on S3 whose copy on disk may be behind S3
var DIRTY_KEY = "storage:folder:primary:dirty";

// The clients which need the blog's folder on disk:
//
// - local: chokidar watches ensureLocal(blogID, "/"), which S3 can't give,
//   until the Local client is reworked to watch a directory of its own
//   (#2258 Phase E).
// - google-drive: sync/util/localReaddir.js asks ensureLocal for a directory,
//   and its fingerprints (util/localFingerprint.js) read the nanosecond mtime
//   of the file ensureLocal returns, which on S3 is the content cache's copy,
//   so every file would look changed. Until the client keeps { sha1, md5 }
//   pairs against the index (#2258, "Content hash").
var DISK_CLIENTS = ["local", "google-drive"];

var LOGGED_MAX = 10000;

var logged = new Set();
var warnedNoBucket = false;

function redis() {
  return require("models/client");
}

function hasBucket() {
  return !!(config.storage && config.storage.bucket);
}

// Once per process for each blog and reason, so a busy blog doesn't flood
// the log on every call
function note(blogID, reason) {
  var key = blogID + " " + reason;

  if (logged.has(key)) return;
  if (logged.size >= LOGGED_MAX) logged.clear();

  logged.add(key);
  console.log(clfdate(), LOG_PREFIX, "blog=" + blogID, "stays on disk:", reason);
}

// Whether config.folder_primary names the blog: "off", "all", or blog IDs
// separated by commas. Read on every call, so specs can change it. Costs no
// Redis, so index.js asks this first and sends other blogs to disk at once.
function enabledFor(blogID) {
  if (typeof blogID !== "string" || !mirror.names(config.folder_primary, blogID)) return false;

  if (!hasBucket()) {
    if (!warnedNoBucket) {
      warnedNoBucket = true;
      console.error(clfdate(), LOG_PREFIX, "S3 is primary for some blogs but no storage bucket is configured, so every blog stays on disk");
    }
    return false;
  }

  return true;
}

// An SISMEMBER reply, which is 0 or 1 (or a boolean)
function isMember(reply) {
  return !!reply && reply !== "0";
}

// Whether a call about blogID goes to S3. One Redis round trip, for named
// blogs only.
async function usesS3(blogID) {
  if (!enabledFor(blogID)) return false;

  if (!mirror.enabledFor(blogID)) {
    note(blogID, "the mirror doesn't cover it, so S3 may not be kept in step");
    return false;
  }

  var [complete, behind, client] = await redis()
    .multi()
    .sIsMember(mirror.COMPLETE_KEY, blogID)
    .sIsMember(mirror.DIRTY_KEY, blogID)
    .hGet(require("models/blog/key").info(blogID), "client")
    .exec();

  if (!isMember(complete)) {
    note(blogID, "no complete copy in S3 yet (no clean backfill or check)");
    return false;
  }

  if (isMember(behind)) {
    note(blogID, "its mirror is dirty, so S3 may be behind the disk");
    return false;
  }

  if (DISK_CLIENTS.indexOf(client) !== -1) {
    note(blogID, "the " + client + " client needs the folder on disk");
    return false;
  }

  return true;
}

// Called by index.js after the S3 backend made a change for a blog on S3.
// Never rejects.
var copy = mirror.copier({
  source: function () {
    return require("./s3");
  },
  target: function () {
    return local;
  },
  dirtyKey: DIRTY_KEY,
  logPrefix: "[storage/folder disk copy]",
});

module.exports = {
  enabledFor,
  usesS3,
  copy,
  DIRTY_KEY,
  DISK_CLIENTS,
  LOG_PREFIX,
};
