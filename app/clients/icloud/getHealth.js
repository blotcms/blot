const health = require("../health");
const database = require("./database");
const { resolveIssue, isSetupInProgress } = require("./error");

module.exports = async function getHealth(blogID) {
  const account = await database.get(blogID);

  if (!account) return health.ok();

  // A failed setup is not an issue here (see error.js): the dashboard shows
  // it with its own retry/cancel, and nothing is syncing, so it is ok.
  const issue = resolveIssue(account);
  if (issue) return health.error([issue]);

  if (isSetupInProgress(account)) return health.syncing();

  // Reported by the macserver's share permission check
  if (account.permission === "readOnly")
    return health.error([
      {
        code: health.CODES.VIEW_ONLY,
        since: account.permissionSince || undefined,
      },
    ]);

  return health.ok();
};
