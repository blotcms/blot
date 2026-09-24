// The shared vocabulary clients use to report whether a blog's sync is
// healthy. A client opts in by exposing an optional method:
//
//   getHealth(blogID) -> Promise<health>
//
// where health is built with the helpers below:
//
//   { state: "ok" | "syncing" | "error", issues: [{ code, message, since }] }
//
// `code` is the source of truth and is shared between clients (Dropbox and
// Google Drive both report SOURCE_MISSING). `message` is display copy; it
// defaults to the entry in ISSUES but a client may supply more specific
// text. `since` is the ms epoch when the issue first appeared, if known.
//
// Only conditions that need the user to act belong here. Transient
// failures that a client will retry should stay in the sync status log.

const STATES = {
  OK: "ok",
  SYNCING: "syncing",
  ERROR: "error",
};

// Listed most severe first: this order picks the issue shown when a site
// has more than one.
const ISSUES = {
  REAUTH_REQUIRED: {
    label: "Reconnect required",
    message: "Access to your folder was revoked. Reconnect to resume syncing.",
  },
  SOURCE_MISSING: {
    label: "Folder missing",
    message:
      "The folder used to sync this site no longer exists. Choose a new folder to resume syncing.",
  },
  QUOTA_EXCEEDED: {
    label: "Storage full",
    message: "Your storage is full, so changes can't sync.",
  },
  SYNC_ERROR: {
    label: "Sync problem",
    message: "Something went wrong while syncing this site.",
  },
};

const CODES = Object.keys(ISSUES).reduce(function (codes, code) {
  codes[code] = code;
  return codes;
}, {});

const PRIORITY = Object.keys(ISSUES);

function issue(code, options) {
  if (!Object.prototype.hasOwnProperty.call(ISSUES, code)) {
    throw new Error("Unknown health issue code: " + code);
  }

  options = options || {};

  const result = {
    code: code,
    message: options.message || ISSUES[code].message,
  };

  if (options.since !== undefined) {
    if (typeof options.since !== "number" || !isFinite(options.since)) {
      throw new Error("Health issue since must be a millisecond timestamp");
    }
    result.since = options.since;
  }

  return result;
}

function ok() {
  return { state: STATES.OK, issues: [] };
}

function syncing() {
  return { state: STATES.SYNCING, issues: [] };
}

// Accepts issues as { code, message?, since? } and returns an error state
// with the issues normalized and ordered most severe first. An empty list
// means nothing is wrong, so it returns ok rather than an empty error.
function error(issues) {
  if (!Array.isArray(issues) || !issues.length) return ok();

  const normalized = issues
    .map(function (item) {
      return issue(item.code, item);
    })
    .sort(function (a, b) {
      return PRIORITY.indexOf(a.code) - PRIORITY.indexOf(b.code);
    });

  return { state: STATES.ERROR, issues: normalized };
}

// The issue to show when there is only room for one, e.g. a badge.
function primaryIssue(health) {
  return health && health.issues && health.issues[0]
    ? health.issues[0]
    : undefined;
}

function label(code) {
  return ISSUES[code] ? ISSUES[code].label : undefined;
}

module.exports = {
  STATES,
  CODES,
  ISSUES,
  issue,
  ok,
  syncing,
  error,
  primaryIssue,
  label,
};
