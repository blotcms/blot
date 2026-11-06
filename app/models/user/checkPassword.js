var bcrypt = require("bcryptjs");
var getById = require("./getById");
var ensure = require("helper/ensure");
var withCallback = require("helper/withCallback");

module.exports = withCallback(async function checkPassword(uid, password) {
  ensure(uid, "string").and(password, "string");

  var user = await getById(uid);

  if (!user) throw new Error("No user");

  return await bcrypt.compare(password, user.passwordHash);
});
