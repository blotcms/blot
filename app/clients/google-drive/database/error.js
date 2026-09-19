const health = require("clients/health");

const SETUP_ERROR = "Failed to set up account";

const MESSAGES = {
  TRASHED:
    "The Google Drive folder used to sync this site has been moved to the trash. Please select a new folder to continue syncing.",
  DELETED:
    "The Google Drive folder used to sync this site has been deleted. Please select a new folder to continue syncing.",
  INACCESSIBLE:
    "The Google Drive folder used to sync this site is no longer accessible. Please select a new folder to continue syncing.",
};

const TRANSIENT_REASONS = {
  userRateLimitExceeded: true,
  rateLimitExceeded: true,
  sharingRateLimitExceeded: true,
  backendError: true,
};

const LOST_FOLDER_REASONS = {
  notFound: true,
  insufficientFilePermissions: true,
  forbidden: true,
};

const QUOTA_REASONS = {
  storageQuotaExceeded: true,
  quotaExceeded: true,
};

function driveReasons(err) {
  const nested =
    (err && err.errors) ||
    (err && err.response && err.response.data && err.response.data.error &&
      err.response.data.error.errors) ||
    [];

  return nested
    .map(function (item) {
      return item && item.reason;
    })
    .filter(Boolean);
}

function driveStatus(err) {
  if (!err) return undefined;

  if (typeof err.code === "number") return err.code;
  if (typeof err.code === "string" && /^\d+$/.test(err.code)) {
    return Number(err.code);
  }

  if (typeof err.status === "number") return err.status;
  if (err.response && typeof err.response.status === "number") {
    return err.response.status;
  }

  return undefined;
}

function hasReason(err, table) {
  return driveReasons(err).some(function (reason) {
    return table[reason];
  });
}

function isQuotaError(err) {
  return hasReason(err, QUOTA_REASONS);
}

function isTransientDriveError(err) {
  const status = driveStatus(err);
  if (status === 429 || (status && status >= 500)) return true;
  return hasReason(err, TRANSIENT_REASONS);
}

// The folder used to sync this site is gone or the service account can
// no longer see it. Google often returns 404 for both "deleted" and
// "unshared"; 403 covers an explicit permission loss.
function isLostFolderError(err) {
  if (isTransientDriveError(err) || isQuotaError(err)) return false;

  const status = driveStatus(err);
  if (status === 404) return true;
  if (hasReason(err, LOST_FOLDER_REASONS)) return true;
  if (status === 403) return true;

  return false;
}

function isSetupError(error) {
  return typeof error === "string" && error.trim() === SETUP_ERROR;
}

function classifyFromProse(error) {
  if (typeof error !== "string" || !error.trim()) return null;
  if (isSetupError(error)) return null;

  if (/moved to the trash/i.test(error)) return health.CODES.SOURCE_MISSING;
  if (/has been deleted/i.test(error)) return health.CODES.SOURCE_MISSING;
  if (/no longer accessible/i.test(error)) return health.CODES.SOURCE_MISSING;

  return null;
}

function classify(account) {
  if (!account) return null;

  if (
    account.errorCode &&
    Object.prototype.hasOwnProperty.call(health.CODES, account.errorCode)
  ) {
    return account.errorCode;
  }

  return classifyFromProse(account.error);
}

function sourceMissingFields(account, message, now) {
  const already =
    account &&
    account.errorCode === health.CODES.SOURCE_MISSING &&
    typeof account.errorSince === "number" &&
    isFinite(account.errorSince);

  return {
    error: message,
    errorCode: health.CODES.SOURCE_MISSING,
    errorSince: already ? account.errorSince : now || Date.now(),
    folderId: null,
    folderName: null,
  };
}

function lostFolderMessage(err) {
  const status = driveStatus(err);
  if (status === 404 || driveReasons(err).indexOf("notFound") !== -1) {
    return MESSAGES.DELETED;
  }
  return MESSAGES.INACCESSIBLE;
}

function clearAllErrorFields() {
  return {
    error: null,
    errorCode: null,
    errorSince: null,
  };
}

function clearHealthErrorFields() {
  return {
    errorCode: null,
    errorSince: null,
  };
}

// Returns a patch to write, or null when the row already matches.
function backfillPatch(account) {
  if (!account) return null;

  const fromProse = classifyFromProse(account.error);

  if (fromProse) {
    if (account.errorCode === fromProse) return null;
    return { errorCode: fromProse };
  }

  if (isSetupError(account.error) && account.errorCode) {
    return { errorCode: null, errorSince: null };
  }

  return null;
}

module.exports = {
  SETUP_ERROR,
  MESSAGES,
  classify,
  classifyFromProse,
  sourceMissingFields,
  lostFolderMessage,
  clearAllErrorFields,
  clearHealthErrorFields,
  backfillPatch,
  isLostFolderError,
  isTransientDriveError,
  isQuotaError,
  isSetupError,
};
