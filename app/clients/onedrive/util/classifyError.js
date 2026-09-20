// Turns a Microsoft Graph / OAuth error plus the step it came from into a
// health decision (see app/clients/health.js). Only conditions the user
// must act on are persisted:
//
//   401 / invalid_grant / InvalidAuthenticationToken -> REAUTH_REQUIRED
//   404 while looking up the blog's own folder       -> SOURCE_MISSING
//   507 / quotaLimitReached                          -> QUOTA_EXCEEDED
//
// A 404 from any other step is a per-file problem (a single item vanished),
// not the blog folder going missing. Transient failures (429, 5xx, network)
// stay in the sync status log and are retried.
const health = require("clients/health");

const SOURCES = {
  AUTH: "auth",
  FOLDER: "folder",
  APPLY: "apply",
};

const AUTH_CODES = {
  invalid_grant: true,
  InvalidAuthenticationToken: true,
};

const QUOTA_CODES = {
  quotaLimitReached: true,
};

function classify(err, source) {
  const status = err && typeof err.status === "number" ? err.status : 0;
  const code = (err && err.code) || "";
  const result = { persist: false, healthCode: null, status, source };

  if (!err || err.name === "AbortError") return result;

  if (status === 401 || AUTH_CODES[code]) {
    result.persist = true;
    result.healthCode = health.CODES.REAUTH_REQUIRED;
    // A refresh failure arrives as a 400 invalid_grant; store it as 401.
    result.status = 401;
  } else if (status === 507 || QUOTA_CODES[code]) {
    result.persist = true;
    result.healthCode = health.CODES.QUOTA_EXCEEDED;
    result.status = 507;
  } else if (status === 404 && source === SOURCES.FOLDER) {
    result.persist = true;
    result.healthCode = health.CODES.SOURCE_MISSING;
  }

  return result;
}

// Maps a stored account row to a health issue, or null if none.
function issueFromAccount(account) {
  if (!account || !account.error_code) return null;

  let code = null;

  if (account.error_code === 401) code = health.CODES.REAUTH_REQUIRED;
  else if (account.error_code === 404) code = health.CODES.SOURCE_MISSING;
  else if (account.error_code === 507) code = health.CODES.QUOTA_EXCEEDED;

  if (!code) return null;

  const issue = { code };

  if (typeof account.error_since === "number" && account.error_since > 0) {
    issue.since = account.error_since;
  }

  return issue;
}

function flagsFromAccount(account) {
  const issue = issueFromAccount(account);

  return {
    revoked: !!(issue && issue.code === health.CODES.REAUTH_REQUIRED),
    folder_missing: !!(issue && issue.code === health.CODES.SOURCE_MISSING),
    quota_exceeded: !!(issue && issue.code === health.CODES.QUOTA_EXCEEDED),
  };
}

module.exports = { SOURCES, classify, issueFromAccount, flagsFromAccount };
