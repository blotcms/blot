var client = require("models/client");
var key = require("./key");

// You cannot check an access token multiple times
// Once checked, it is no longer valid. The value
// stored against an access token might be meaningless
// (in the case of creating a new account) or it might
// be an existing user's UID, in the case of the forgot
// password flow.
module.exports = function (token, callback) {
  (async function () {
    try {
      // GETDEL is atomic, so only one concurrent caller can consume the token.
      var value = await client.getDel(key.accessToken(token));

      if (!value) return callback(new Error("Invalid access token"));

      return callback(null, value);
    } catch (err) {
      return callback(err);
    }
  })();
};
