// Resolves to { error, client, account } and never rejects, as createClient
// does: the account comes with an error when the token could not be
// refreshed (disconnecting needs it then). createClient is looked up when
// this is called, not when this file loads.
module.exports = function loadClient(blogID) {
  return require("./createClient")(blogID);
};
