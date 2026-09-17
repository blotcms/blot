var bcrypt = require("bcryptjs");
var { passwordIsTooLong } = require("./auth-limits");

module.exports = function (password, callback) {
  if (passwordIsTooLong(password)) {
    return callback(new Error("Password is too long"));
  }

  bcrypt.hash(password, 10, callback);
};
