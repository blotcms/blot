var ensure = require("helper/ensure");
var client = require("models/client");
var key = require("./key");
function applyUserDefaults(user) {
  if (!user || typeof user !== "object") return user;

  if (typeof user.created === "undefined") user.created = 0;
  if (typeof user.welcomeEmailSent === "undefined")
    user.welcomeEmailSent = true;
  if (typeof user.paymentMethods === "undefined") user.paymentMethods = [];

  return user;
}

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

      return callback(null, applyUserDefaults(user));
    } catch (err) {
      return callback(err);
    }
  })();
};
