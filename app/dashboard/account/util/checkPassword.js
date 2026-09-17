var User = require("models/user");
var { passwordIsTooLong } = require("models/user/auth-limits");

module.exports = function checkPassword(req, res, next) {
  if (!req.body.password) {
    return next(new Error("Please enter your password"));
  }

  if (passwordIsTooLong(req.body.password)) {
    return next(new Error("Your password is too long."));
  }

  User.checkPassword(req.user.uid, req.body.password, function (err, match) {
    if (err) return next(err);

    if (!match) {
      return next(new Error("Your existing password is incorrect."));
    }

    next();
  });
};
