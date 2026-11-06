var User = require("models/user");
var { passwordIsTooLong } = require("models/user/auth-limits");

module.exports = async function checkPassword(req, res, next) {
  try {
    if (!req.body.password) {
      return next(new Error("Please enter your password"));
    }

    if (passwordIsTooLong(req.body.password)) {
      return next(new Error("Your password is too long."));
    }

    const match = await User.checkPassword(req.user.uid, req.body.password);

    if (!match) {
      return next(new Error("Your existing password is incorrect."));
    }
  } catch (err) {
    return next(err);
  }

  next();
};
