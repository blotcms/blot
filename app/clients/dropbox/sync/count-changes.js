// Counts the changes in a resetToBlot summary worth reporting as unsynced.
// Files Dropbox modified after the walk started are excluded: they are most
// likely edits whose webhook hadn't arrived yet, not missed changes.
module.exports = function countChanges(summary = {}) {
  return (
    Math.max(0, (summary.downloaded || 0) - (summary.modifiedDuringWalk || 0)) +
    (summary.removed || 0) +
    (summary.createdDirs || 0)
  );
};
