// Dropbox timestamps have one second resolution and an edit's webhook can lag
// behind it, so treat files modified shortly before the cutoff as modified
// since it too: they are most likely edits still in flight. Production logs
// show edit-to-sync lag with a median of ~1s and a 95th percentile of ~12s.
// Keep this short: it also hides genuinely missed changes from the alert.
const GRACE_MS = 30 * 1000;

function modifiedSince(remoteItem, timestamp) {
  const modified = Date.parse(remoteItem.server_modified);
  return !isNaN(modified) && modified >= timestamp - GRACE_MS;
}

// The same rule for a deletion: result is files/list_revisions' result for
// the path, which timestamps a deleted file (folder listings don't).
function deletedSince(result, timestamp) {
  if (!result || !result.is_deleted) return false;
  const deleted = Date.parse(result.server_deleted);
  return !isNaN(deleted) && deleted >= timestamp - GRACE_MS;
}

module.exports = modifiedSince;
module.exports.deletedSince = deletedSince;
module.exports.GRACE_MS = GRACE_MS;
