var config = require("config");
var fs = require("fs-extra");
var clfdate = require("helper/clfdate");
var local = require("./local");
var { NotFoundError } = require("./errors");

// Mirrors changes to a blog's folder on disk into the S3 backend (objects
// under {blogID}/folder/ plus the models/file index), #2258 Phase C: "write
// to both, disk first". Disk stays authoritative and every read still comes
// from it; the mirror is a copy the reconcile can check and shadow reads can
// try later.
//
// index.js calls mirror(op, args) after the local backend has made the
// change and only if it succeeded. The mirror then makes S3 match what is
// now on disk:
//
// - write and writeFrom (copy or move) upload the file from its place in the
//   folder, with the file's modified time on disk. A stream is consumed once,
//   by the disk; the upload reads the file back rather than teeing it.
// - commit makes S3 match the path on disk, a file or a whole directory.
// - mkdir writes the directory's marker; remove and rmdir delete the path.
// - move is copy plus delete in S3. If S3 does not have the source (a blog
//   mirrored before its backfill), the destination is uploaded from disk.
// - removeAll deletes the blog's folder in S3 and its index. If that fails,
//   the blog is flagged like any other failure, and the backfill's --dirty
//   run removes the copy of a blog which no longer exists.
//
// A mirror failure never fails the caller: the change is on disk, which is
// what counts. It is logged with the prefix below and the blog is added to
// the Redis set DIRTY_KEY, for the backfill or the reconcile to repair.
// storage/s3.js already retries each request, so nothing is retried here.
//
// Callers make these changes inside the blog's sync lock, so the mirror runs
// under it too, which keeps one writer per blog for the index. It is awaited,
// so a blog's changes reach S3 in order, but that means each mirrored write
// costs its S3 round trips (an upload, a few Redis commands) on top of the
// disk write, inside the sync.

var LOG_PREFIX = "[storage/folder mirror]";

// Blogs whose mirror may be behind their disk
var DIRTY_KEY = "storage:folder:mirror:dirty";

var warnedNoBucket = false;

// Redis, loaded on first use so requiring storage/folder connects to nothing
function redis() {
  return require("models/client");
}

// Loaded only once something is mirrored
function backend() {
  return require("./s3");
}

function hasBucket() {
  return !!(config.storage && config.storage.bucket);
}

// config.folder_mirror: "off", "all", or blog IDs separated by commas. Read
// on every call, so specs (and a config reload) can change it.
function enabledFor(blogID) {
  var setting = String(config.folder_mirror || "").trim();

  if (!setting || setting === "off") return false;

  var on =
    setting === "all" ||
    setting
      .split(",")
      .map(function (id) {
        return id.trim();
      })
      .indexOf(blogID) !== -1;

  if (!on) return false;

  if (!hasBucket()) {
    if (!warnedNoBucket) {
      warnedNoBucket = true;
      console.error(clfdate(), LOG_PREFIX, "mirroring is on but no storage bucket is configured, so nothing is mirrored");
    }
    return false;
  }

  return true;
}

// Uploads the file now at relPath on disk, keeping its modified time
async function upload(blogID, relPath) {
  var file = await local.ensureLocal(blogID, relPath);
  var stat = await fs.stat(file);
  var options = { modified: stat.mtimeMs };

  try {
    await backend().writeFrom(blogID, relPath, file, options);
  } catch (err) {
    // S3 has a directory where the disk now has a file
    if (err.code !== "EISDIR") throw err;

    await backend().remove(blogID, relPath);
    await backend().writeFrom(blogID, relPath, file, options);
  }
}

async function mkdir(blogID, relPath) {
  try {
    await backend().mkdir(blogID, relPath);
  } catch (err) {
    // S3 has a file where the disk now has a directory
    if (err.code !== "EEXIST") throw err;

    await backend().remove(blogID, relPath);
    await backend().mkdir(blogID, relPath);
  }
}

async function isEmptyDirectory(blogID, relPath) {
  return (await local.listNames(blogID, relPath)).length === 0;
}

// Makes S3 hold what the disk holds at relPath: nothing, a file, or a
// directory and everything in it. A directory is replaced whole, so this is
// for paths written by a tool (commit) or moved in, not for routine writes.
async function replace(blogID, relPath) {
  var stat;

  try {
    stat = await local.stat(blogID, relPath);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;

    return backend().remove(blogID, relPath);
  }

  if (!stat.isDirectory) return upload(blogID, relPath);

  await backend().remove(blogID, relPath);

  // Directories with something in them need no marker
  if (await isEmptyDirectory(blogID, relPath)) await mkdir(blogID, relPath);

  for await (var path of local.walk(blogID, relPath, { directories: true })) {
    if ((await local.stat(blogID, path)).isDirectory) {
      if (await isEmptyDirectory(blogID, path)) await mkdir(blogID, path);
    } else {
      await upload(blogID, path);
    }
  }
}

async function move(blogID, from, to) {
  try {
    await backend().move(blogID, from, to);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;

    await replace(blogID, to);
  }
}

// Whether S3 may hold anything of this blog's folder, from its index: a
// blog stops being mirrored when the switch changes, but its copy stays
async function hasMirror(blogID) {
  var page = await require("models/file").list(blogID, "/", { limit: 1 });

  return !!(page && page.entries.length);
}

var OPERATIONS = {
  write: function (blogID, relPath) {
    return upload(blogID, relPath);
  },
  writeFrom: function (blogID, relPath) {
    return upload(blogID, relPath);
  },
  commit: function (blogID, relPath) {
    return replace(blogID, relPath);
  },
  mkdir: function (blogID, relPath) {
    return mkdir(blogID, relPath);
  },
  // The path is gone from disk, whatever it was, so it goes from S3 too
  rmdir: function (blogID, relPath) {
    return backend().remove(blogID, relPath);
  },
  remove: function (blogID, relPath) {
    return backend().remove(blogID, relPath);
  },
  move: function (blogID, from, to) {
    return move(blogID, from, to);
  },
  removeAll: async function (blogID) {
    await backend().removeAll(blogID);
    await redis().sRem(DIRTY_KEY, blogID);
  },
};

function quote(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

async function markDirty(blogID) {
  try {
    await redis().sAdd(DIRTY_KEY, blogID);
  } catch (err) {
    console.error(clfdate(), LOG_PREFIX, "could not mark blog=" + blogID + " as needing reconcile:", err.message);
  }
}

// Called by index.js after the local backend made the change described by
// op and args (the arguments of the call). Never rejects.
async function mirror(op, args) {
  var blogID = args[0];

  try {
    if (!OPERATIONS[op] || typeof blogID !== "string") return;

    if (!enabledFor(blogID)) {
      if (op !== "removeAll") return;

      // A deleted blog's copy is deleted, even once it is no longer
      // mirrored. Without one there is nothing in S3 to ask about.
      if (!hasBucket() || !(await hasMirror(blogID))) return await redis().sRem(DIRTY_KEY, blogID);
    }

    await OPERATIONS[op].apply(null, args);
  } catch (err) {
    var paths = Array.prototype.slice.call(args, 1, op === "move" ? 3 : 2).map(quote);

    console.error(
      clfdate(),
      LOG_PREFIX,
      "failed blog=" + blogID,
      "op=" + op,
      "path=" + paths.join(" -> "),
      "error=" + ((err && err.code) || "") + " " + ((err && err.message) || err)
    );

    await markDirty(blogID);
  }
}

module.exports = mirror;
module.exports.DIRTY_KEY = DIRTY_KEY;
module.exports.LOG_PREFIX = LOG_PREFIX;
module.exports.enabledFor = enabledFor;
