// Shared by clients whose resync() accepts a cutoff (the moment the folder
// lock was acquired, before the remote walk started): a remote item
// reported as modified right around that moment is most likely a live edit
// whose webhook hasn't arrived yet, not a change a previous sync missed.
// Dropbox timestamps have ~1s resolution and production logs show
// edit-to-sync lag with a median of ~1s and a 95th percentile of ~12s (see
// clients/dropbox/sync/modified-since.js), so a 30s grace period comfortably
// covers normal lag. Keep it short - it also hides genuinely missed changes
// from the admin alert this is used for.
const GRACE_MS = 30 * 1000;

// modifiedAt is a timestamp (ms) or anything Date.parse can read (e.g. an
// ISO string). cutoff is the resync's "since" option - when it's missing
// (older/unrelated callers that don't pass one), nothing is excluded.
module.exports = function modifiedSince(modifiedAt, cutoff) {
  if (!cutoff) return false;

  const modified =
    typeof modifiedAt === "number" ? modifiedAt : Date.parse(modifiedAt);

  return !isNaN(modified) && modified >= cutoff - GRACE_MS;
};

module.exports.GRACE_MS = GRACE_MS;
