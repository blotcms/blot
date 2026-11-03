var config = require("config");
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
//
// The copying itself is copier() below, which works between any two
// backends: ./primary.js uses it the other way round, to keep the disk copy
// of a blog whose folder is in S3 (#2258 Phase D).

var LOG_PREFIX = "[storage/folder mirror]";

// Blogs whose mirror may be behind their disk. ./primary.js keeps a blog
// which is in it on disk, whatever its flag says.
var DIRTY_KEY = "storage:folder:mirror:dirty";

// Blogs whose copy in S3 is known to be complete: a backfill or reconcile
// (reconcile.js backfillBlog) last finished it, or checked it, with no
// errors. A copy which has an index is not necessarily complete: the mirror
// starts an index with a blog's first mirrored write, before its backfill.
// Starting a backfill of a blog, or marking it dirty, takes it out, and
// ./primary.js moves a blog to S3 only while it is in.
var COMPLETE_KEY = "storage:folder:mirror:complete";

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

// Whether a setting of the form "off", "all", or blog IDs separated by commas
// names blogID. Used for config.folder_mirror and config.folder_primary.
function names(setting, blogID) {
  setting = String(setting || "").trim();

  if (!setting || setting === "off") return false;

  return (
    setting === "all" ||
    setting
      .split(",")
      .map(function (id) {
        return id.trim();
      })
      .indexOf(blogID) !== -1
  );
}

// Whether a setting of that form is on for any blog at all
function isOn(setting) {
  setting = String(setting || "").trim();

  return !!setting && setting !== "off";
}

// config.folder_mirror: "off", "all", or blog IDs separated by commas. Read
// on every call, so specs (and a config reload) can change it.
function enabledFor(blogID) {
  if (!names(config.folder_mirror, blogID)) return false;

  if (!hasBucket()) {
    if (!warnedNoBucket) {
      warnedNoBucket = true;
      console.error(clfdate(), LOG_PREFIX, "mirroring is on but no storage bucket is configured, so nothing is mirrored");
    }
    return false;
  }

  return true;
}

// Returns copy(op, args), which makes the target backend match what the
// source backend now holds after the change op made with args. options:
//
//   source, target  functions returning the backends (so S3 loads lazily)
//   dirtyKey        the Redis set a blog is added to when a copy fails
//   incomplete      true to also take the blog out of COMPLETE_KEY then
//                   (for the mirror: S3 is now behind)
//   logPrefix       for the failure's log line
//   skip            async (op, blogID): true to leave this change alone
//
// copy never rejects.
function copier(options) {
  var source = options.source;
  var target = options.target;
  var dirtyKey = options.dirtyKey;
  var logPrefix = options.logPrefix;

  // Copies the file now at relPath in the source, keeping its modified time
  async function upload(blogID, relPath) {
    var file = await source().ensureLocal(blogID, relPath);
    var stat = await source().stat(blogID, relPath);
    var copied = { modified: stat.modified };

    try {
      await target().writeFrom(blogID, relPath, file, copied);
    } catch (err) {
      // The target has a directory where the source now has a file
      if (err.code !== "EISDIR") throw err;

      await target().remove(blogID, relPath);
      await target().writeFrom(blogID, relPath, file, copied);
    }
  }

  async function mkdir(blogID, relPath) {
    try {
      await target().mkdir(blogID, relPath);
    } catch (err) {
      // The target has a file where the source now has a directory
      if (err.code !== "EEXIST") throw err;

      await target().remove(blogID, relPath);
      await target().mkdir(blogID, relPath);
    }
  }

  async function isEmptyDirectory(blogID, relPath) {
    return (await source().listNames(blogID, relPath)).length === 0;
  }

  // Makes the target hold what the source holds at relPath: nothing, a file,
  // or a directory and everything in it. A directory is replaced whole, so
  // this is for paths written by a tool (commit) or moved in, not for
  // routine writes.
  async function replace(blogID, relPath) {
    var stat;

    try {
      stat = await source().stat(blogID, relPath);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;

      return target().remove(blogID, relPath);
    }

    if (!stat.isDirectory) return upload(blogID, relPath);

    await target().remove(blogID, relPath);

    // Directories with something in them need no marker
    if (await isEmptyDirectory(blogID, relPath)) await mkdir(blogID, relPath);

    for await (var path of source().walk(blogID, relPath, { directories: true })) {
      if ((await source().stat(blogID, path)).isDirectory) {
        if (await isEmptyDirectory(blogID, path)) await mkdir(blogID, path);
      } else {
        await upload(blogID, path);
      }
    }
  }

  async function move(blogID, from, to) {
    try {
      await target().move(blogID, from, to);
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;

      await replace(blogID, to);
    }
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
    // The path is gone from the source, whatever it was, so it goes from the
    // target too
    rmdir: function (blogID, relPath) {
      return target().remove(blogID, relPath);
    },
    remove: function (blogID, relPath) {
      return target().remove(blogID, relPath);
    },
    move: function (blogID, from, to) {
      return move(blogID, from, to);
    },
    removeAll: async function (blogID) {
      await target().removeAll(blogID);
      await redis().multi().sRem(dirtyKey, blogID).sRem(COMPLETE_KEY, blogID).exec();
    },
  };

  function quote(value) {
    return typeof value === "string" ? JSON.stringify(value) : String(value);
  }

  async function markDirty(blogID) {
    try {
      if (options.incomplete) await markBehind(blogID);
      else await redis().sAdd(dirtyKey, blogID);
    } catch (err) {
      console.error(clfdate(), logPrefix, "could not mark blog=" + blogID + " as needing reconcile:", err.message);
    }
  }

  return async function copy(op, args) {
    var blogID = args[0];

    try {
      if (!OPERATIONS[op] || typeof blogID !== "string") return;

      if (options.skip && (await options.skip(op, blogID))) return;

      await OPERATIONS[op].apply(null, args);
    } catch (err) {
      var paths = Array.prototype.slice.call(args, 1, op === "move" ? 3 : 2).map(quote);

      console.error(
        clfdate(),
        logPrefix,
        "failed blog=" + blogID,
        "op=" + op,
        "path=" + paths.join(" -> "),
        "error=" + ((err && err.code) || "") + " " + ((err && err.message) || err)
      );

      await markDirty(blogID);
    }
  };
}

// Whether S3 may hold anything of this blog's folder, from its index: a
// blog stops being mirrored when the switch changes, but its copy stays
async function hasMirror(blogID) {
  var page = await require("models/file").list(blogID, "/", { limit: 1 });

  return !!(page && page.entries.length);
}

// Called by index.js after the local backend made the change described by
// op and args (the arguments of the call). Never rejects.
var mirror = copier({
  source: function () {
    return local;
  },
  target: backend,
  dirtyKey: DIRTY_KEY,
  incomplete: true,
  logPrefix: LOG_PREFIX,
  skip: async function (op, blogID) {
    if (enabledFor(blogID)) return false;

    // The disk changes without S3, so a copy which was complete is not any
    // more: mirroring the blog again must not promote it until a backfill
    if (op !== "removeAll") {
      await redis().sRem(COMPLETE_KEY, blogID).catch(function () {});
      return true;
    }

    // A deleted blog's copy is deleted, even once it is no longer
    // mirrored. With no index and no dirty flag there is nothing in S3 to
    // ask about. A dirty flag counts as a copy: a failed index write can
    // leave objects in S3 that the index doesn't know of.
    if (!hasBucket()) {
      await redis().multi().sRem(DIRTY_KEY, blogID).sRem(COMPLETE_KEY, blogID).exec();
      return true;
    }

    return !(await hasMirror(blogID)) && !(await redis().sIsMember(DIRTY_KEY, blogID));
  },
});

// Marks a blog's copy in S3 as behind its disk: dirty, and no longer
// complete
function markBehind(blogID) {
  return redis().multi().sAdd(DIRTY_KEY, blogID).sRem(COMPLETE_KEY, blogID).exec();
}

module.exports = mirror;
module.exports.DIRTY_KEY = DIRTY_KEY;
module.exports.COMPLETE_KEY = COMPLETE_KEY;
module.exports.markBehind = markBehind;
module.exports.LOG_PREFIX = LOG_PREFIX;
module.exports.enabledFor = enabledFor;
module.exports.names = names;
module.exports.isOn = isOn;
module.exports.copier = copier;
