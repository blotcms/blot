const folder = require("storage/folder");

// A file's size and mtime in the shape the build reads from a converter (what
// fs.stat gave it): modified is milliseconds, and fs.Stats rounds mtimeMs to a
// whole millisecond for its mtime.
function toStat({ size, modified }) {
  return { size, mtime: new Date(Math.round(modified)) };
}

async function folderStat(blogID, path) {
  return toStat(await folder.stat(blogID, path));
}

// The same, with a local path to the file for the tools which read from one
// (pandoc, the webloc parsers). The stat comes from the index record the
// copy was fetched for: one read of the index, not two.
async function withLocal(blogID, path) {
  const { localPath, size, modified } = await folder.ensureLocalWithStat(
    blogID,
    path
  );

  return { localPath, stat: toStat({ size, modified }) };
}

// The same, for a tool which may run for a long time: calls fn(localPath) with
// the file pinned in the cache until fn settles (storage/folder's withLocal),
// and resolves to { stat, value } with fn's result as value
async function withLocalHeld(blogID, path, fn) {
  let stat;
  const value = await folder.withLocal(blogID, path, (localPath, record) => {
    stat = toStat(record);
    return fn(localPath);
  });

  return { stat, value };
}

module.exports = folderStat;
module.exports.withLocalHeld = withLocalHeld;
module.exports.withLocal = withLocal;
