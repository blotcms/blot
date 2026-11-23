// Resolves to { error, client, account } and never rejects, as createClient
// does: the account comes with an error when the token could not be
// refreshed (disconnecting needs it then). createClient is looked up when
// this is called, not when this file loads. options.signal, the sync's
// folder.signal, cuts off every request the client makes once it aborts.
module.exports = function loadClient(blogID, options) {
  return require("./createClient")(blogID, options);
};
