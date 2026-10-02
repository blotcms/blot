// Counts the changes in a fromiCloud summary worth reporting as unsynced.
// modifiedDuringWalk is a subset of downloaded (files the macserver reports
// modified around or after the resync's cutoff, within a grace period - see
// clients/util/modifiedSince.js) and is excluded: those are most likely
// edits whose webhook hadn't arrived yet, not changes a previous sync
// missed. It's always 0 for callers that don't pass a cutoff.
module.exports = function countChanges(summary = {}) {
  return Math.max(
    0,
    (summary.downloaded || 0) -
      (summary.modifiedDuringWalk || 0) +
      (summary.removed || 0) +
      (summary.createdDirs || 0)
  );
};
