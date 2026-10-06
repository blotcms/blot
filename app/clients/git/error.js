const health = require("clients/health");

const MESSAGES = {
  SETUP_FAILED: "Git repository setup failed. Try connecting again.",
  SOURCE_MISSING:
    "The Git repository for this site is missing. Reconnect Git to resume syncing.",
  REAUTH_REQUIRED:
    "Git credentials are missing. Reset your Git password to resume syncing.",
  TREE_REJECTED:
    "Your last push was rejected: Git blogs support regular files only (no symbolic links or submodules). Remove them and push again.",
};

// validateTree.js tags the error it throws for a rejected tree with this
// code so we never have to match on its prose.
const TREE_REJECTED = "GIT_TREE_REJECTED";

function errorMessage(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  return String(err);
}

function isMissingRepoError(err) {
  return /Git repo does not exist/i.test(errorMessage(err));
}

function isTreeRejectedError(err) {
  return !!err && typeof err === "object" && err.code === TREE_REJECTED;
}

// Only the failures a person has to act on are classified specifically.
// Everything else (git fetch/reset stderr and so on) gets the generic
// SYNC_ERROR copy: the raw message is for the sync log, not the dashboard.
function issueFromSyncError(err) {
  if (isMissingRepoError(err)) {
    return {
      code: health.CODES.SOURCE_MISSING,
      message: MESSAGES.SOURCE_MISSING,
    };
  }

  if (isTreeRejectedError(err)) {
    return {
      code: health.CODES.SYNC_ERROR,
      message: MESSAGES.TREE_REJECTED,
    };
  }

  return {
    code: health.CODES.SYNC_ERROR,
    message: health.ISSUES.SYNC_ERROR.message,
  };
}

// The health action button defaults to the client's /setup page, which Git
// doesn't have. Returns the { action, actionUrl } to show for an issue. An
// undefined action hides the button: a rejected push can only be fixed by
// pushing again, so there is nowhere useful to send the user.
function healthAction(code, createFailed, base) {
  if (code === health.CODES.REAUTH_REQUIRED) {
    return { action: "Reset password", actionUrl: base + "/reset-password" };
  }

  if (code === health.CODES.SOURCE_MISSING) {
    return { action: "Reconnect", actionUrl: base + "/disconnect" };
  }

  if (code === health.CODES.SYNC_ERROR) {
    if (createFailed) {
      return { action: "Try again", actionUrl: base + "/create" };
    }

    return { action: undefined, actionUrl: undefined };
  }

  return null;
}

module.exports = {
  MESSAGES,
  TREE_REJECTED,
  isMissingRepoError,
  isTreeRejectedError,
  issueFromSyncError,
  healthAction,
};
