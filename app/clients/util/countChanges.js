// Counts the changes in a resync summary (Dropbox, iCloud or Google Drive)
// worth reporting as unsynced. Changes made after the walk started are
// excluded: they are most likely edits whose webhook hadn't arrived yet, not
// missed changes. modifiedDuringWalk covers downloads (by timestamp, with a
// grace period) and changedDuringWalk covers everything else: Dropbox
// sets it from its pre-walk cursor or a file's deletion time in its revision
// history, and iCloud from the mtime of the directory holding a removal or
// created directory (creating, removing or renaming an entry updates its
// parent's mtime). Google Drive has no equivalent and leaves it out.
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
