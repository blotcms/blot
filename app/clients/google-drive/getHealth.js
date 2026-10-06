const database = require("./database");
const health = require("clients/health");
const { classify, isSetupError } = require("./database/error");

module.exports = async function getHealth(blogID) {
  const account = await database.blog.get(blogID);

  if (!account) return health.ok();

  const code = classify(account);

  if (code) {
    const issue = { code };

    if (typeof account.error === "string" && account.error.trim()) {
      issue.message = account.error;
    }

    if (typeof account.errorSince === "number" && isFinite(account.errorSince)) {
      issue.since = account.errorSince;
    }

    return health.error([issue]);
  }

  // Setup waits for the user to share a folder. That is in-progress
  // work, not a sync failure. A failed setup leaves preparing: true
  // beside the prose "Failed to set up account" string (see
  // routes/setup.js), but nothing is running any more, so it is not
  // syncing either.
  if (account.preparing && !isSetupError(account.error)) {
    return health.syncing();
  }

  return health.ok();
};
