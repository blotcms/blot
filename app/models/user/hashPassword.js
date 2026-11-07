var bcrypt = require("bcryptjs");
var promiseOnly = require("helper/promiseOnly");
var { passwordIsTooLong } = require("./auth-limits");

module.exports = promiseOnly(async function hashPassword(password) {
  if (passwordIsTooLong(password)) {
    throw new Error("Password is too long");
  }

  return await bcrypt.hash(password, 10);
});
