// Development-only preload. When a fake error mode is active, Google Drive
// folder lookups (GET /drive/v3/files/:id, which sync uses to detect a
// trashed, deleted or unshared folder) are answered locally with the
// response Drive would send for that condition, without reaching Google.
// Everything above the HTTP layer (googleapis, the classifier, sync,
// getHealth) runs for real.
//
// The mode comes from BLOT_FAKE_DRIVE_ERROR, or from the flag file written
// by `scripts/google-drive/fake-error.js on <mode>` (the running app is
// launched with --require of this file by scripts/development/docker-compose.yml).
const fs = require("fs");
const os = require("os");
const path = require("path");

const flagPath = path.join(os.tmpdir(), "blot-google-drive-fake-error");

// mode -> what Drive answers, and what Blot should make of it
const MODES = {
  trashed: {
    status: 200,
    body: { id: "fake", name: "Fake folder", trashed: true },
    expect: "SOURCE_MISSING (folder in the trash)",
  },
  deleted: {
    status: 404,
    reason: "notFound",
    message: "File not found: fake.",
    expect: "SOURCE_MISSING (deleted; Drive also returns this when unshared)",
  },
  forbidden: {
    status: 403,
    reason: "insufficientFilePermissions",
    message: "The user does not have sufficient permissions for this file.",
    expect: "SOURCE_MISSING (no longer accessible)",
  },
  "rate-limit": {
    status: 429,
    reason: "rateLimitExceeded",
    message: "Rate Limit Exceeded",
    expect: "healthy: transient, sync aborts and retries next poll",
  },
  "user-rate-limit": {
    status: 403,
    reason: "userRateLimitExceeded",
    message: "User Rate Limit Exceeded",
    expect: "healthy: transient, sync aborts and retries next poll",
  },
  "daily-limit": {
    status: 403,
    reason: "dailyLimitExceeded",
    message: "Daily Limit Exceeded",
    expect: "healthy: transient, must NOT drop the folder",
  },
  "server-error": {
    status: 503,
    reason: "backendError",
    message: "Backend Error",
    expect: "healthy: transient, sync aborts and retries next poll",
  },
  quota: {
    status: 403,
    reason: "storageQuotaExceeded",
    message: "The user's Drive storage quota has been exceeded.",
    expect: "healthy: not a lost folder (no QUOTA_EXCEEDED signal yet)",
  },
  policy: {
    status: 403,
    reason: "domainPolicy",
    message: "The domain administrators have disabled Drive apps.",
    expect: "healthy: ambiguous 403 must NOT drop the folder",
  },
};

function activeMode() {
  const mode =
    process.env.BLOT_FAKE_DRIVE_ERROR ||
    (fs.existsSync(flagPath) ? fs.readFileSync(flagPath, "utf8").trim() : "");
  return MODES[mode] ? mode : null;
}

// Only the folder metadata lookup: /drive/v3/files/<id> with no sub-path
const FOLDER_LOOKUP = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[^/?]+(\?|$)/;

function install() {
  const { Gaxios } = require("gaxios");
  const realAdapter = Gaxios.prototype._defaultAdapter;

  Gaxios.prototype._defaultAdapter = async function (opts) {
    const mode = activeMode();
    const method = (opts.method || "GET").toUpperCase();
    const url = String(opts.url || "");

    if (mode && method === "GET" && FOLDER_LOOKUP.test(url)) {
      const fake = MODES[mode];
      console.log("google-drive:fakeError", mode, "->", fake.status, url);

      const data = fake.body || {
        error: {
          code: fake.status,
          message: fake.message,
          errors: [{ message: fake.message, domain: "global", reason: fake.reason }],
        },
      };

      return {
        config: opts,
        data: data,
        status: fake.status,
        statusText: "Fake",
        headers: { "content-type": "application/json" },
        request: { responseURL: url },
      };
    }

    return realAdapter.apply(this, arguments);
  };
}

install();

module.exports = { MODES, flagPath, activeMode };
