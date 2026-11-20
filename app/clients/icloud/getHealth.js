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

  // scripts/icloud/migrate-nested.js is moving this blog's folder on the
  // macserver (#2874): nothing syncs until it's done, so say so. An hour on,
  // the script has died without clearing it, and it no longer applies
  if (
    account.migratingSince &&
    Date.now() - account.migratingSince < 60 * 60 * 1000
  )
    return health.error([
      {
        code: health.CODES.SYNC_PAUSED,
        message:
          "Syncing is paused for a few minutes while Blot updates how it connects to your folder. Changes you make meanwhile will sync once it's done.",
        since: account.migratingSince,
      },
    ]);

  if (isSetupInProgress(account)) return health.syncing();

  return health.ok();
};
