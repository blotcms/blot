var ensure = require("helper/ensure");
var client = require("models/client");
var key = require("./key");

module.exports = async function getById(uid) {
  ensure(uid, "string");

  var user = await client.get(key.user(uid));

  if (!user) return null;

  try {
    user = JSON.parse(user);
    ensure(user, "object");
  } catch (err) {
    throw new Error("BADJSON", { cause: err });
  }

  return user;
};
