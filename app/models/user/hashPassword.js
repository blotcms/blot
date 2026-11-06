var bcrypt = require("bcryptjs");
var withCallback = require("helper/withCallback");
var { passwordIsTooLong } = require("./auth-limits");

module.exports = withCallback(async function hashPassword(password) {
  if (passwordIsTooLong(password)) {
    throw new Error("Password is too long");
  }

  return await bcrypt.hash(password, 10);
});
