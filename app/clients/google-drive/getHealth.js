const database = require("./database");
const health = require("clients/health");
const { classify } = require("./database/error");

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
  // work, not a sync failure, even if a previous setup attempt stored
  // a prose-only "Failed to set up account" string.
  if (account.preparing) return health.syncing();

  return health.ok();
};
