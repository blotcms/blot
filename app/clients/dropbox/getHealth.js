const { promisify } = require("util");
const database = require("./database");
const health = require("clients/health");
const { issueFromAccount } = require("./util/classifyError");

const get = promisify(database.get);

module.exports = async function getHealth(blogID) {
  const account = await get(blogID);
  const issue = issueFromAccount(account);
  if (issue) return health.error([issue]);

  // A durable error_code (handled above) already covers the out-of-space
  // case with its own more specific QUOTA_EXCEEDED issue; this only fires
  // when the initial transfer stopped for some other reason (a non-quota
  // upload failure, an API error, or the process dying mid-transfer) and
  // left transfer_pending set with no error_code to explain it.
  if (account && account.transfer_pending === true) {
    return health.error([{ code: health.CODES.TRANSFER_INCOMPLETE }]);
  }

  return health.ok();
};
