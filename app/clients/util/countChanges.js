// Counts the changes in a resync summary (Dropbox, iCloud or Google Drive)
// worth reporting as unsynced. Changes made after the walk started are
// excluded: they are most likely edits whose webhook hadn't arrived yet, not
// missed changes. modifiedDuringWalk covers downloads (by timestamp, with a
// grace period) and changedDuringWalk covers everything else (by Dropbox's
// pre-walk cursor, or the deletion time in a file's revision history - the
// other clients have no equivalent and leave it out).
module.exports = function countChanges(summary = {}) {
  return Math.max(
    0,
    (summary.downloaded || 0) -
      (summary.modifiedDuringWalk || 0) +
      (summary.removed || 0) +
      (summary.createdDirs || 0) -
      (summary.changedDuringWalk || 0)
  );
};
