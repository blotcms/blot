// Typed error state for the iCloud client. The dashboard historically stored
// a free-text `error` string; health reporting needs a stable code, so every
// writer now records `errorCode` beside it (and `errorSince`, kept in step by
// database.store()). Writers that can't require this file - the macserver is
// a separate ESM process - post the same string literals.
//
//   SOURCE_MISSING        macserver watcher: the shared folder was deleted
//   TRANSFER_INCOMPLETE   sync/initialTransfer.js: copying Blot's files into
//                         iCloud failed after the folder was accepted
//   SETUP_FAILED          macserver/routes/setup.js and routes/dashboard.js:
//                         the sharing link was never accepted
//
// SETUP_FAILED is the one code that is not a health code. As with Google
// Drive, a failed setup isn't a sync problem the user can be told about by
// the badge: nothing was connected yet. The dashboard shows it itself, with
// retry/cancel (views/index.html), so getHealth reports nothing for it.

const health = require("../health");

// Sentinel written by the macserver watcher when the shared folder is gone.
// Keep this string stable: existing Redis rows and the watcher still use it.
const BLOG_DIRECTORY_DELETED = "Blog directory deleted";

const SETUP_FAILED = "SETUP_FAILED";

function isKnownCode(code) {
  return (
    code === SETUP_FAILED ||
    (typeof code === "string" &&
      Object.prototype.hasOwnProperty.call(health.CODES, code))
  );
}

// The code for an account whose error was written without one: rows from
// before errorCode existed, and status posts from a macserver that hasn't
// been redeployed. Only the watcher's sentinel is recognisable by text. For
// anything else, where the account got to tells us which stage failed: after
// setup the shared folder exists, and acceptedSharingLink (stored from the
// macserver's status post) means setup got as far as the transfer.
function inferCode(account) {
  if (account.error === BLOG_DIRECTORY_DELETED) {
    return health.CODES.SOURCE_MISSING;
  }

  if (account.setupComplete === true) return health.CODES.SYNC_ERROR;

  return account.acceptedSharingLink === true
    ? health.CODES.TRANSFER_INCOMPLETE
    : SETUP_FAILED;
}

// The code for the stored error, including SETUP_FAILED, or null when the
// account has no error.
function resolveCode(account) {
  if (!account || (!account.error && !account.errorCode)) return null;
  if (isKnownCode(account.errorCode)) return account.errorCode;
  return inferCode(account);
}

// The health code for the stored error, or null when there is nothing to
// report: no error, or a setup failure (see above).
function classify(account) {
  const code = resolveCode(account);
  return code === SETUP_FAILED ? null : code;
}

function isSetupError(account) {
  return resolveCode(account) === SETUP_FAILED;
}

// Turns a stored account record into a health issue, or null. The message is
// left to the shared copy: the raw error can be an HTTP failure naming the
// macserver, and it is still in the sync status log.
function resolveIssue(account) {
  const code = classify(account);
  if (!code) return null;

  const issue = { code };

  if (typeof account.errorSince === "number" && isFinite(account.errorSince)) {
    issue.since = account.errorSince;
  }

  return issue;
}

// The error / errorCode / errorSince fields database.store() writes for
// `data`. `current` is the stored row, so a repeat write of the same code
// keeps its errorSince and a different code starts a new one.
function normalizeErrorFields(data, current) {
  if (!data.error) {
    return { error: null, errorCode: null, errorSince: null };
  }

  const code = isKnownCode(data.errorCode)
    ? data.errorCode
    : inferCode(Object.assign({}, current, data));

  const currentCode = resolveCode(current);

  let errorSince;
  if (typeof data.errorSince === "number" && isFinite(data.errorSince)) {
    errorSince = data.errorSince;
  } else if (
    currentCode === code &&
    typeof current.errorSince === "number" &&
    isFinite(current.errorSince)
  ) {
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

// Returns a patch to write, or null when the row already matches. Only the
// code: errorSince is when we noticed, which the backfill can't know.
function backfillPatch(account) {
  if (!account || !account.error) return null;
  if (isKnownCode(account.errorCode)) return null;
  return { errorCode: inferCode(account) };
}

module.exports = {
  BLOG_DIRECTORY_DELETED,
  SETUP_FAILED,
  classify,
  resolveCode,
  resolveIssue,
  isSetupError,
  normalizeErrorFields,
  shouldSkipBackgroundSync,
  isSetupInProgress,
  backfillPatch,
};
