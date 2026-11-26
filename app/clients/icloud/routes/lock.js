const LOCK_ERROR_MESSAGE = "Failed to acquire folder lock";
const LOCK_RETRY_AFTER_SECONDS = 10;

const isSyncLockError = (err) =>
  Boolean(err && err.message === LOCK_ERROR_MESSAGE);

// Why seize() (sync/seize.js) stopped this request: the reason on an aborted
// holder's error (code ECANCELED), or on the cause of a lock it refused while
// it waited. Null for anything else.
const seizeReason = (err) => {
  if (!err) return null;
  if (err.code === "ECANCELED" && err.reason) return err.reason;
  if (isSyncLockError(err) && err.cause && err.cause.reason)
    return err.cause.reason;
  return null;
};

// A lock refused, or a request stopped, so the blog could be disconnected:
// the change will never apply, so the macserver is told so for good (410, as
// loadAccount says for a blog no longer on iCloud) rather than to retry.
// Any other lock failure, or a stop for another reason, is a 423 it retries.
const handleSyncLockError = ({ err, res, blogID, action }) => {
  const reason = seizeReason(err);

  if (!isSyncLockError(err) && !reason) {
    return false;
  }

  console.warn("[ICLOUD SYNC LOCK]", {
    action,
    blogID,
    reason,
    error: {
      message: err.message,
      stack: err.stack,
    },
  });

  if (!res.headersSent) {
    if (reason === "disconnect") {
      res.status(410).send("Blog is being disconnected from iCloud");
    } else {
      res.set("Retry-After", String(LOCK_RETRY_AFTER_SECONDS));
      res.status(423).send("Folder is locked by another sync; retry later");
    }
  }

  return true;
};

module.exports = { handleSyncLockError, isSyncLockError, seizeReason };
