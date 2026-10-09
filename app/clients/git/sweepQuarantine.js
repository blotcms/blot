// When git receives a push it unpacks it into a quarantine directory,
// <repo>.git/objects/tmp_objdir-incoming-XXXXXX, and moves the objects into the
// repository only once they have passed its checks. It deletes the directory
// when the push fails, but not if the process is killed first, which is what
// happens to a push in flight when a container crashes or is replaced by a
// deploy. Git removes nothing else in there until a gc runs, and ours almost
// never do, so those directories (each as large as the push) pile up for good.
//
// This removes the ones old enough that no push can still be using them. It
// is run daily by the scheduler (app/scheduler/index.js).
var fs = require("fs-extra");
var path = require("path");

var PREFIX = "tmp_objdir-incoming-";

// Node's requestTimeout (an hour, see app/index.js) ends any push well inside
// this, so a quarantine directory older than this belongs to a push that no
// longer exists.
var MAX_AGE_MS = 24 * 60 * 60 * 1000;

function nextTick() {
  return new Promise(function (resolve) {
    setImmediate(resolve);
  });
}

// Total size of the files under a directory, without following symlinks
async function sizeOf(directory) {
  var total = 0;
  var entries = await fs.readdir(directory, { withFileTypes: true });

  for (var entry of entries) {
    var entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      total += await sizeOf(entryPath);
    } else {
      total += (await fs.lstat(entryPath)).size;
    }
  }

  return total;
}

async function sweepRepository(objectsDirectory, now, maxAgeMs, report) {
  var entries;

  try {
    // objects/ must be a real directory, not a link to somewhere else
    if (!(await fs.lstat(objectsDirectory)).isDirectory()) return;

    entries = await fs.readdir(objectsDirectory, { withFileTypes: true });
  } catch (err) {
    // not a repository (or it is being created or removed)
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return;
    throw err;
  }

  for (var entry of entries) {
    // Only real directories with exactly this prefix, directly inside
    // objects/. Dirent.isDirectory() is false for a symlink to a directory.
    if (entry.name.indexOf(PREFIX) !== 0 || !entry.isDirectory()) continue;

    var directory = path.join(objectsDirectory, entry.name);

    try {
      var stat = await fs.lstat(directory);

      if (!stat.isDirectory() || now - stat.mtimeMs <= maxAgeMs) continue;

      var bytes = await sizeOf(directory).catch(function () {
        return 0;
      });

      await fs.remove(directory);

      report.removed++;
      report.bytes += bytes;
    } catch (err) {
      report.errors++;
      console.error("Git: could not remove " + directory, err);
    }
  }
}

// Removes quarantine directories older than maxAgeMs from every bare
// repository in the git data directory. One repository at a time, yielding to
// the event loop between them.
module.exports = async function sweepQuarantine(options) {
  options = options || {};

  var dataDir = options.dataDir || require("./dataDir");
  var now = options.now === undefined ? Date.now() : options.now;
  var maxAgeMs = options.maxAgeMs === undefined ? MAX_AGE_MS : options.maxAgeMs;
  var report = { repositories: 0, removed: 0, bytes: 0, errors: 0 };
  var entries = await fs.readdir(dataDir, { withFileTypes: true });

  for (var entry of entries) {
    // real directories only: a symlink here could lead anywhere
    if (!entry.isDirectory() || !/\.git$/.test(entry.name)) continue;

    report.repositories++;

    try {
      await sweepRepository(
        path.join(dataDir, entry.name, "objects"),
        now,
        maxAgeMs,
        report
      );
    } catch (err) {
      report.errors++;
      console.error("Git: could not sweep " + entry.name, err);
    }

    await nextTick();
  }

  return report;
};

module.exports.PREFIX = PREFIX;
module.exports.MAX_AGE_MS = MAX_AGE_MS;
