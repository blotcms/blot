var withCallback = require("helper/withCallback");
var Entry = require("models/entry");
var build = require("build");
var folderPostSource = require("./folderPostSourceFolder");

// Rebuilds an existing entry from its source file and stores the result,
// without touching anything else about the sync: no dropping, no previews,
// no dependents. Callers decide what an error means (rebuildDependents drops
// entries whose source is gone; scripts/entry/rebuild-all.js leaves them).
//
// entry is the stored entry. A folder post lives at a plus-stripped path that
// does not exist on disk (e.g. the aggregate for /album+ is stored at /album),
// so it is rebuilt through its source folder; otherwise build() would fail
// with ENOENT/WRONGTYPE for a perfectly valid aggregate.
module.exports = withCallback(async function rebuildEntry(blog, entry) {
  var folderSource = folderPostSource(entry);
  var buildPath = folderSource || entry.path;

  var updated = await build(blog, buildPath);

  if (folderSource && updated.metadata && updated.metadata._sourcePaths) {
    delete updated.metadata._sourcePaths;
  }

  return Entry.set(blog.id, updated.path || entry.path, updated);
});
