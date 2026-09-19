// Dropbox timestamps have one second resolution and an edit's webhook can lag
// by several seconds, so treat files modified shortly before the cutoff as
// modified since it too. They are almost certainly edits still in flight.
const GRACE_MS = 60 * 1000;

module.exports = function modifiedSince(remoteItem, timestamp) {
  const modified = Date.parse(remoteItem.server_modified);
  return !isNaN(modified) && modified >= timestamp - GRACE_MS;
};
