// Size and nanosecond mtime: enough to notice a local edit since the last
// verified checksum, and available from any storage backend (no inode,
// device or ctime). What this gives up: a rewrite of the same size that also
// restores the exact nanosecond mtime, or a replacement file with that same
// size and mtime, goes unnoticed. Blot's own code never sets a Drive file's
// mtime (download.js stopped doing so), so only something outside Blot
// deliberately restoring timestamps can trigger that.
module.exports = function contentFingerprint(stat) {
  if (!stat || !stat.isFile()) return null;
  const fields = [stat.size, stat.mtimeNs];
  if (fields.some(value => value === undefined)) return null;
  return fields.map(String).join(":");
};

// Records already in Redis hold the old dev:ino:size:mtimeNs:ctimeNs form.
// Treating those as mismatches would re-download every file of every Drive
// blog, so an old-form record matches when its size and mtime still match;
// it is rewritten in the new form when its file is next downloaded. Falsy
// values never match. Drop the old-form branch once #2258's index replaces
// the fingerprint.
module.exports.sameFingerprint = function sameFingerprint(stored, current) {
  if (!stored || !current) return false;
  if (stored === current) return true;
  const parts = String(stored).split(":");
  return parts.length === 5 && parts.slice(2, 4).join(":") === current;
};
