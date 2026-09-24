const health = require("clients/health");

const MESSAGES = {
  SETUP_FAILED: "Git repository setup failed. Try connecting again.",
  SOURCE_MISSING:
    "The Git repository for this site is missing. Reconnect Git to resume syncing.",
  REAUTH_REQUIRED:
    "Git credentials are missing. Reset your Git password to resume syncing.",
};

function errorMessage(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  return String(err);
}

function isMissingRepoError(err) {
  return /Git repo does not exist/i.test(errorMessage(err));
}

function issueFromSyncError(err) {
  if (isMissingRepoError(err)) {
    return {
      code: health.CODES.SOURCE_MISSING,
      message: MESSAGES.SOURCE_MISSING,
    };
  }

  const message = errorMessage(err).trim();

  return {
    code: health.CODES.SYNC_ERROR,
    message: message || health.ISSUES.SYNC_ERROR.message,
  };
}

module.exports = {
  MESSAGES,
  isMissingRepoError,
  issueFromSyncError,
};
