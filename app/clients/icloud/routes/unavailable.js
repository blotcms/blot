const { isRedisUnavailableError } = require("helper/redisUnavailable");

const RETRY_AFTER_SECONDS = 10;

// Redis refused the write, so the change is not in the database. Answering
// anything but 2xx is what makes the macserver push the change again (a few
// quick attempts, then a resync request), so the route must also have put the
// blog folder back as it was: both the upload and the mkdir routes skip work
// for a path that already looks right on disk.
const handleRedisUnavailable = ({ err, res, blogID, action }) => {
  if (!isRedisUnavailableError(err)) {
    return false;
  }

  console.warn("[ICLOUD REDIS UNAVAILABLE]", {
    action,
    blogID,
    error: { message: err.message },
  });

  if (!res.headersSent) {
    res.set("Retry-After", String(RETRY_AFTER_SECONDS));
    res.status(503).send("Redis unavailable; retry later");
  }

  return true;
};

module.exports = { handleRedisUnavailable };
