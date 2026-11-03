const folder = require("storage/folder");

// A file's size and mtime from storage/folder, in the shape the build reads
// from a converter (what fs.stat gave it): modified is milliseconds, and
// fs.Stats rounds mtimeMs to a whole millisecond for its mtime.
async function folderStat(blogID, path) {
  const { size, modified } = await folder.stat(blogID, path);

  return { size, mtime: new Date(Math.round(modified)) };
}

// The same, with a local path to the file for the tools which read from one
// (pandoc, the webloc parsers)
async function withLocal(blogID, path) {
  const localPath = await folder.ensureLocal(blogID, path);

  return { localPath, stat: await folderStat(blogID, path) };
}

// The same, for a tool which may run for a long time: calls fn(localPath) with
// the file pinned in the cache until fn settles (storage/folder's withLocal),
// and resolves to { stat, value } with fn's result as value
async function withLocalHeld(blogID, path, fn) {
  const value = await folder.withLocal(blogID, path, fn);

  return { stat: await folderStat(blogID, path), value };
}

module.exports = folderStat;
module.exports.withLocalHeld = withLocalHeld;
module.exports.withLocal = withLocal;
