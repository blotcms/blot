// Counts the changes in a resetToBlot summary worth reporting as unsynced.
// Changes Dropbox made after the walk started are excluded: they are most
// likely edits whose webhook hadn't arrived yet, not missed changes.
// modifiedDuringWalk covers downloads (by timestamp, with a grace period) and
// changedDuringWalk covers everything else (by the pre-walk cursor).
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
