// Development-only preload (see --require in docker-compose.yml). While a
// fake error mode is active, matching Dropbox API requests are answered
// locally with the response Dropbox sends for that condition, without ever
// reaching Dropbox. Everything above the HTTP layer (SDK, retry, classifier,
// sync, getHealth) runs for real.
//
// The mode comes from BLOT_FAKE_DROPBOX_ERROR, or from the flag file written
// by `scripts/dropbox/fake-error.js on <mode>`.
const fs = require("fs");
const os = require("os");
const path = require("path");

const flagPath = path.join(os.tmpdir(), "blot-dropbox-fake-error");

const API = /^https:\/\/api\.dropboxapi\.com\/2\//;
const TOKEN = /^https:\/\/api\.dropbox(api)?\.com\/oauth2\/token/;
const UPLOAD = /^https:\/\/content\.dropboxapi\.com\/2\/files\/upload/;
const DOWNLOAD = /^https:\/\/content\.dropboxapi\.com\/2\/files\/download/;
// The folder-level calls sync and resync make to find the blog's folder
const FOLDER =
  /^https:\/\/api\.dropboxapi\.com\/2\/files\/(list_folder|list_folder\/continue|get_metadata)$/;
const FOLDER_CONTINUE =
  /^https:\/\/api\.dropboxapi\.com\/2\/files\/list_folder\/continue$/;
const DELETE = /^https:\/\/api\.dropboxapi\.com\/2\/files\/delete/;

function tagged(tag, detail) {
  const error = { ".tag": tag };
  if (detail) error[tag] = detail;
  return { error_summary: tag + "/..", error: error };
}

// mode -> which requests it answers, with what, and what Blot should make of it
const MODES = {
  "quota-full": {
    match: UPLOAD,
    status: 409,
    body: {
      error_summary: "path/insufficient_space/..",
      error: { ".tag": "path", reason: { ".tag": "insufficient_space" } },
    },
    expect: "QUOTA_EXCEEDED (uploads only: try a dashboard save or reset from Blot)",
  },
  revoked: {
    match: API,
    status: 401,
    body: tagged("invalid_access_token"),
    expect: "REAUTH_REQUIRED (401 from any step)",
  },
  "invalid-grant": {
    match: TOKEN,
    status: 400,
    body: {
      error: "invalid_grant",
      error_description: "refresh token is invalid or revoked",
    },
    expect: "REAUTH_REQUIRED (token refresh fails as 400, not 401)",
  },
  "folder-missing": {
    match: FOLDER,
    status: 409,
    body: {
      error_summary: "path/not_found/..",
      error: { ".tag": "path", path: { ".tag": "not_found" } },
    },
    expect: "SOURCE_MISSING (409 from the folder step)",
  },
  "cursor-reset": {
    match: FOLDER_CONTINUE,
    status: 409,
    body: { error_summary: "reset/..", error: { ".tag": "reset" } },
    expect: "healthy: folder moved, sync drops the cursor and lists from scratch",
  },
  "file-conflict": {
    match: (url) => DOWNLOAD.test(url) || DELETE.test(url),
    status: 409,
    body: {
      error_summary: "path/not_found/..",
      error: { ".tag": "path", path: { ".tag": "not_found" } },
    },
    expect: "healthy: a per-file 409 is not a missing folder",
  },
  "rate-limit": {
    match: API,
    status: 429,
    headers: { "retry-after": "1" },
    body: {
      error_summary: "too_many_requests/..",
      error: { ".tag": "too_many_requests", retry_after: 1 },
    },
    expect: "healthy: transient, waits and retries",
  },
  "server-error": {
    match: API,
    status: 503,
    body: { error_summary: "internal_server_error/.." },
    expect: "healthy: transient, retried",
  },
};

function activeMode() {
  const mode =
    process.env.BLOT_FAKE_DROPBOX_ERROR ||
    (fs.existsSync(flagPath) ? fs.readFileSync(flagPath, "utf8").trim() : "");
  return MODES[mode] ? mode : null;
}

function matches(fake, url) {
  return typeof fake.match === "function" ? fake.match(url) : fake.match.test(url);
}

function install() {
  const realFetch = globalThis.fetch;

  globalThis.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input.url || String(input);
    const mode = activeMode();

    if (mode && matches(MODES[mode], url)) {
      const fake = MODES[mode];
      console.log("dropbox:fakeError", mode, "->", fake.status, url);
      return Promise.resolve(
        new Response(JSON.stringify(fake.body), {
          status: fake.status,
          headers: Object.assign(
            { "content-type": "application/json" },
            fake.headers
          ),
        })
      );
    }

    return realFetch.apply(this, arguments);
  };
}

install();

module.exports = { MODES, flagPath, activeMode };
