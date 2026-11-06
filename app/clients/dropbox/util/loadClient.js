// Resolves to { error, client, account } and never rejects. createClient
// calls back with several results, (err, client, account), and the account
// comes with an error when the token could not be refreshed (disconnecting
// needs it then), so it cannot be a promise-returning function. It is
// looked up when called, not when this file loads.
module.exports = function loadClient(blogID) {
  return new Promise(function (resolve) {
    require("./createClient")(blogID, function (error, client, account) {
      resolve({ error, client, account });
    });
  });
};
