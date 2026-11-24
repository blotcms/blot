// Size and nanosecond mtime of a local file (verifyContent.js reads one
// before and after hashing it, to notice it changing mid-read). What this
// gives up: a rewrite of the same size that also restores the exact nanosecond mtime, or a replacement file with that same
// size and mtime, goes unnoticed. Blot's own code never sets a Drive file's
// mtime (download.js stopped doing so), so only something outside Blot
// deliberately restoring timestamps can trigger that.
module.exports = function contentFingerprint(stat) {
  if (!stat || !stat.isFile()) return null;
  const fields = [stat.size, stat.mtimeNs];
  if (fields.some((value) => value === undefined)) return null;
  return fields.map(String).join(":");
};
