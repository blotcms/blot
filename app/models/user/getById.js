var ensure = require("helper/ensure");
var client = require("models/client");
var key = require("./key");

module.exports = function getById(uid, callback) {
  ensure(uid, "string").and(callback, "function");

  (async function () {
    try {
      var user = await client.get(key.user(uid));

      if (!user) return callback(null, null);

      try {
        user = JSON.parse(user);
        ensure(user, "object");
      } catch (err) {
        return callback(new Error("BADJSON"));
      }

      return callback(null, user);
    } catch (err) {
      return callback(err);
    }
  })();
};
