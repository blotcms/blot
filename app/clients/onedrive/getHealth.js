const { promisify } = require("util");
const database = require("./database");
const health = require("clients/health");
const { issueFromAccount } = require("./util/classifyError");

const get = promisify(database.get);

// See the "Health" section of app/clients/README. Reports only conditions
// the user must act on: revoked access, a deleted folder, or full storage.
module.exports = async function getHealth(blogID) {
  const issue = issueFromAccount(await get(blogID));

  if (!issue) return health.ok();

  return health.error([issue]);
};
