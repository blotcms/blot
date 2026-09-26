const { promisify } = require("util");
const database = require("./database");
const health = require("clients/health");
const { issueFromAccount } = require("./util/classifyError");

const get = promisify(database.get);

module.exports = async function getHealth(blogID) {
  const account = await get(blogID);
  const issue = issueFromAccount(account);
  if (!issue) return health.ok();
  return health.error([issue]);
};
