const { promisify } = require("util");
const database = require("./database");
const health = require("clients/health");
const { issueFromAccount } = require("./util/classifyError");
const folderLock = require("sync/lock");

const get = promisify(database.get);

module.exports = async function getHealth(blogID) {
  const account = await get(blogID);
  const issue = issueFromAccount(account);
  if (issue) return health.error([issue]);

  // A durable error_code (handled above) already covers the out-of-space
  // case with its own more specific QUOTA_EXCEEDED issue. transfer_pending
  // alone just means the initial transfer hasn't finished - true for the
  // entire duration of every normal connect/reconnect, not just a stuck
  // one - so report syncing rather than an error while it's actually
  // running (held by the blog's folder lock, the same one resetFromBlot/
  // resetToBlot/sync/index.js all acquire). Only once nothing holds that
  // lock is a pending transfer genuinely stuck (a non-quota upload
  // failure, an API error, or the process dying mid-transfer) and worth
  // surfacing as an issue.
  if (account && account.transfer_pending === true) {
    let held = true;
    try {
      held = (await folderLock.inspect(blogID)).held;
    } catch (e) {
      // Can't tell either way - assume it's still running rather than
      // showing a false alarm.
      held = true;
    }

    if (held) return health.syncing();
    return health.error([{ code: health.CODES.TRANSFER_INCOMPLETE }]);
  }

  return health.ok();
};
