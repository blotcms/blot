// Turns a Dropbox SDK / OAuth error plus the step it came from into a
// health decision. Only conditions the user must act on are persisted:
//
//   401 / invalid_grant from any step → REAUTH_REQUIRED
//   409 from the delta (folder listing) step → SOURCE_MISSING
//   507 / insufficient_space → QUOTA_EXCEEDED
//
// A 409 from apply / write / remove is a per-file conflict (restricted
// content, path-not-found on a single item) and is not the blog folder
// going missing. Transient failures (429, 5xx, network) stay in the
// sync status log and are retried.

const health = require("clients/health");

const SOURCES = {
  AUTH: "auth",
  DELTA: "delta",
  APPLY: "apply",
};

const AUTH_TAGS = {
  invalid_access_token: true,
  expired_access_token: true,
  invalid_grant: true,
};

const QUOTA_TAGS = {
  insufficient_space: true,
};

function dropboxTag(err) {
  if (!err) return "";

  const body = err.error;
  if (!body) {
    if (typeof err.error_summary === "string") {
      return err.error_summary;
    }
    return "";
  }

  if (typeof body === "string") return body;

  if (typeof body.error === "string") return body.error;

  if (typeof body.error_summary === "string") {
    return body.error_summary;
  }

  const tagged = body.error && body.error[".tag"] ? body.error : body;
  if (tagged && typeof tagged[".tag"] === "string") {
    const tag = tagged[".tag"];
    const nested = tagged[tag];
    if (nested && typeof nested[".tag"] === "string") {
      return tag + "/" + nested[".tag"];
    }
    return tag;
  }

  return "";
}

function statusOf(err) {
  if (!err) return 0;
  if (typeof err.status === "number" && err.status > 0) return err.status;
  if (typeof err.statusCode === "number" && err.statusCode > 0) {
    return err.statusCode;
  }
  return 0;
}

function classify(err, source) {
  source = source || "";
  const status = statusOf(err);
  const tag = dropboxTag(err);
  const result = {
    persist: false,
    healthCode: null,
    status: status,
    source: source,
    tag: tag,
  };

  if (!err) return result;

  const authFailure =
    status === 401 || AUTH_TAGS[tag] || AUTH_TAGS[tag.split("/")[0]];

  if (authFailure) {
    result.persist = true;
    result.healthCode = health.CODES.REAUTH_REQUIRED;
    result.status = status || 401;
    // A refresh failure can surface from any step (with status 400), so
    // always store it as auth: issueFromAccount maps that source.
    result.source = SOURCES.AUTH;
    return result;
  }

  if (status === 507 || tag.split("/").some((part) => QUOTA_TAGS[part])) {
    result.persist = true;
    result.healthCode = health.CODES.QUOTA_EXCEEDED;
    // Store the canonical status: issueFromAccount maps 507, and
    // Dropbox reports this condition as 409 on uploads.
    result.status = 507;
    result.source = source || result.source;
    return result;
  }

  if (status === 409 && source === SOURCES.DELTA) {
    result.persist = true;
    result.healthCode = health.CODES.SOURCE_MISSING;
    return result;
  }

  return result;
}

function isRetryable(err) {
  if (!err) return true;
  if (err.code === "ENAMETOOLONG") return false;
  const classified = classify(err);
  if (classified.healthCode) return false;
  if (classified.status === 409) return false;
  return true;
}

// Map a stored Dropbox account row to a health issue. Legacy rows have
// error_code but no error_source: 401 → reauth, 409 → folder missing
// (apply never persisted errors historically), 400 → reauth (refresh
// failures), 507 → quota. Other codes
// were transients that should not have been surfaced.
function issueFromAccount(account) {
  if (!account || !account.error_code) return null;

  const source = account.error_source || "";
  const status = account.error_code;
  let code = null;

  // Legacy rows stored a refresh failure (HTTP 400 invalid_grant) with no
  // source; new rows always carry source "auth" for it.
  if (
    status === 401 ||
    source === SOURCES.AUTH ||
    (status === 400 && source === "")
  ) {
    code = health.CODES.REAUTH_REQUIRED;
  } else if (status === 409 && (source === SOURCES.DELTA || source === "")) {
    code = health.CODES.SOURCE_MISSING;
  } else if (status === 507) {
    code = health.CODES.QUOTA_EXCEEDED;
  }

  if (!code) return null;

  const issue = { code };
  if (typeof account.error_since === "number" && account.error_since > 0) {
    issue.since = account.error_since;
  }
  return issue;
}

// A pass that only downloads proves auth and the folder are fine, but
// not that Dropbox has room for uploads, so it must not clear a quota error.
function keepsErrorAfterDownload(account) {
  const issue = issueFromAccount(account);
  return !!(issue && issue.code === health.CODES.QUOTA_EXCEEDED);
}

function flagsFromAccount(account) {
  const issue = issueFromAccount(account);
  return {
    revoked: !!(issue && issue.code === health.CODES.REAUTH_REQUIRED),
    folder_missing: !!(issue && issue.code === health.CODES.SOURCE_MISSING),
    quota_exceeded: !!(issue && issue.code === health.CODES.QUOTA_EXCEEDED),
  };
}

function backfillPatch(account) {
  if (!account) return null;

  const status = account.error_code || 0;
  const source = account.error_source || "";

  if (!status) {
    if (source || (account.error_since && account.error_since > 0)) {
      return { error_source: "", error_since: 0 };
    }
    return null;
  }

  const actionable =
    status === 401 ||
    status === 400 ||
    status === 409 ||
    status === 507 ||
    source === SOURCES.AUTH;

  if (!actionable) {
    return { error_code: 0, error_source: "", error_since: 0 };
  }

  const patch = {};

  if (!source) {
    if (status === 401 || status === 400) patch.error_source = SOURCES.AUTH;
    else if (status === 409 || status === 507) patch.error_source = SOURCES.DELTA;
  }

  if (!(typeof account.error_since === "number" && account.error_since > 0)) {
    patch.error_since = account.last_sync || Date.now();
  }

  return Object.keys(patch).length ? patch : null;
}

module.exports = {
  SOURCES,
  classify,
  isRetryable,
  dropboxTag,
  issueFromAccount,
  flagsFromAccount,
  keepsErrorAfterDownload,
  backfillPatch,
};
