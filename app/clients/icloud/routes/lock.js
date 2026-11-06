const LOCK_ERROR_MESSAGE = "Failed to acquire folder lock";
const LOCK_RETRY_AFTER_SECONDS = 10;

const isSyncLockError = (err) =>
  Boolean(err && err.message === LOCK_ERROR_MESSAGE);

const handleSyncLockError = ({ err, res, blogID, action }) => {
  if (!isSyncLockError(err)) {
    return false;
  }

  console.warn("[ICLOUD SYNC LOCK]", {
    action,
    blogID,
    error: {
      message: err.message,
      stack: err.stack,
    },
  });

  if (!res.headersSent) {
    res.set("Retry-After", String(LOCK_RETRY_AFTER_SECONDS));
    res.status(423).send("Folder is locked by another sync; retry later");
  }

  return true;
};

module.exports = { handleSyncLockError, isSyncLockError };
