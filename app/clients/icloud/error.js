// Typed error helpers for the iCloud client. The dashboard historically
// stored a free-text `error` string; health reporting needs a stable code.
// Writers should pass `errorCode` when they know it. `store()` also
// classifies legacy strings so getHealth works before a backfill.

const health = require("../health");

// Sentinel written by the macserver watcher when the shared folder is gone.
// Keep this string stable: existing Redis rows and the watcher still use it.
const BLOG_DIRECTORY_DELETED = "Blog directory deleted";

function classifyError(message) {
  if (message === BLOG_DIRECTORY_DELETED) {
    return health.CODES.SOURCE_MISSING;
  }
  return health.CODES.SYNC_ERROR;
}

function resolveCode(account) {
  if (account && account.errorCode && health.CODES[account.errorCode]) {
    return account.errorCode;
  }
  return classifyError(account && account.error);
}

// Turns a stored account record into a health issue, or null if there isn't
// a persistent user-actionable error. Setup/in-progress flags are not issues.
function resolveIssue(account) {
  if (!account || (!account.error && !account.errorCode)) {
    return null;
  }

  const code = resolveCode(account);
  const issue = { code };

  // SOURCE_MISSING uses the shared default copy. Other codes keep the
  // recorded message so setup/transfer failures stay specific.
  if (code !== health.CODES.SOURCE_MISSING && account.error) {
    issue.message = String(account.error);
  }

  if (typeof account.errorSince === "number" && isFinite(account.errorSince)) {
    issue.since = account.errorSince;
  }

  return issue;
}

function normalizeErrorFields(data, current) {
  if (!data.error) {
    return { error: null, errorCode: null, errorSince: null };
  }

  const code =
    data.errorCode && health.CODES[data.errorCode]
      ? data.errorCode
      : classifyError(data.error);

  const sameIssue =
    current &&
    (current.error || current.errorCode) &&
    resolveCode(current) === code;

  let errorSince;
  if (typeof data.errorSince === "number" && isFinite(data.errorSince)) {
    errorSince = data.errorSince;
  } else if (sameIssue && typeof current.errorSince === "number") {
    errorSince = current.errorSince;
  } else {
    errorSince = Date.now();
  }

  return {
    error: data.error,
    errorCode: code,
    errorSince,
  };
}

function shouldSkipBackgroundSync(account) {
  return (
    !account ||
    account.setupComplete !== true ||
    Boolean(account.error) ||
    account.transferringToiCloud === true
  );
}

function isSetupInProgress(account) {
  if (!account || account.error || account.errorCode) return false;
  if (account.transferringToiCloud === true) return true;
  return account.setupComplete !== true && Boolean(account.sharingLink);
}

function backfillFields(account) {
  if (!account || !account.error) return null;
  if (
    account.errorCode &&
    health.CODES[account.errorCode] &&
    typeof account.errorSince === "number"
  ) {
    return null;
  }
  return normalizeErrorFields(
    {
      error: account.error,
      errorCode: account.errorCode,
      errorSince: account.errorSince,
    },
    account
  );
}

module.exports = {
  BLOG_DIRECTORY_DELETED,
  classifyError,
  resolveCode,
  resolveIssue,
  normalizeErrorFields,
  shouldSkipBackgroundSync,
  isSetupInProgress,
  backfillFields,
};
