const Entries = require("models/entries");
const Entry = require("models/entry");
const storage = require("storage/folder");
const promiseOnly = require("helper/promiseOnly");

// A folder post is synthesized at a "+"-stripped path with no file behind it
// (the aggregate for "/Album +" is stored at "/album"). resolvePath would
// never find a file there and drop it as a ghost on every sync/restart, so
// these entries are checked against their source "+" folder instead.
const folderPostFolder = require("sync/update/folderPostSourceFolder");

// Whether a path is on disk, for deciding that an entry has lost its file.
// Only a missing path is a no. Any other error (the disk failing, say) is
// thrown and stops the check, because a wrong "gone" drops a live entry.
// A symlink at the path counts as there: it used to be followed, and the
// entry of a file which has become a link is not ours to drop.
async function present(blogID, path) {
  try {
    await storage.stat(blogID, path);
    return true;
  } catch (err) {
    if (err.code === "ELOOP") return true;
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// As present, but the path must be a directory
async function presentDirectory(blogID, path) {
  try {
    return (await storage.stat(blogID, path)).isDirectory;
  } catch (err) {
    if (err.code === "ELOOP") return true;
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// Resolves to the first candidate which is on disk, or to nothing if none
// is. An error checking a candidate is thrown.
async function resolvePath(blogID, path) {
  var candidates = [];

  candidates.push(path);
  // try removing leading whitespace
  candidates.push(path.trim());

  // 1 /Foo/Bar/Baz/Bat.jpg
  // - /Foo/Bar/Baz/bat.jpg
  // - /Foo/Bar/baz/bat.jpg
  // - /Foo/bar/baz/bat.jpg
  // - /foo/bar/baz/bat.jpg

  if (path.toLowerCase() !== path) {
    var dirs = path.split("/");

    for (var i = dirs.length - 1; i >= 0; i--) {
      dirs[i] = dirs[i].toLowerCase();
      candidates.push(dirs.join("/"));
      candidates.push(dirs.join("/").trim());
    }
  }

  for (const filePath of candidates) {
    if (await present(blogID, filePath)) return filePath;
  }
}
// The purpose of this script was to resolve an issue with entries having
// path properties that were not equal to the location of the file on disk
// if the file system is case sensitive.
// Entries.each reads one full entry (content included) at a time, but for
// a blog with very large posts the string of already-processed entries can
// pile up in memory faster than V8 gets a chance to reclaim it. Yielding to
// the event loop every YIELD_EVERY entries gives it that chance, bounding
// peak memory instead of letting it climb for the length of the walk.
var YIELD_EVERY = 50;

async function main(blog) {
  var missing = [];
  var edit = [];
  var report = [];
  var count = 0;

  async function done() {
    count++;
    if (count % YIELD_EVERY === 0)
      await new Promise(function (resolve) {
        setImmediate(resolve);
      });
  }

  async function inspect(_entry) {
    if (!_entry) return done();

    if (_entry.deleted) return done();

    // Folder posts have no file at their own path; they are ghosts only if
    // the "+" folder they were built from is gone - or has been replaced by
    // a plain file, which can no longer aggregate anything.
    // Only the id and path are kept for remediation below - holding on to
    // the full entry (content included) for every ghost found would grow
    // with the aggregate content size of the corrupted blog this check is
    // meant to repair.
    var multiFolder = folderPostFolder(_entry);
    if (multiFolder) {
      if (!(await presentDirectory(blog.id, multiFolder))) {
        missing.push({ id: _entry.id, path: _entry.path });
      }
      return done();
    }

    var path = await resolvePath(blog.id, _entry.path);

    if (path && path !== _entry.path) {
      edit.push({ oldPath: _entry.path, path: path });
    } else if (!path) {
      missing.push({ id: _entry.id, path: _entry.path });
    }
    return done();
  }

  await Entries.each(blog.id, async function (_entry) {
    await inspect(_entry);
  });

  if (!missing.length && !edit.length) return;

  // One row per repair, like the other checks, so the report's length
  // is the number of repairs.
  missing.forEach(function (item) {
    report.push(["MISSING", item]);
  });

  edit.forEach(function (item) {
    report.push(["CASE", item]);
  });

  for (const item of edit) {
    await Entry.set(blog.id, item.oldPath, { path: item.path });
  }

  for (const item of missing) {
    const dropID = item.id && item.id !== item.path ? item.id : item.path;
    await Entry.drop(blog.id, dropID);
  }

  return report;
}

module.exports = promiseOnly(main);
