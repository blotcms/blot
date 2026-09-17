var User = require("models/user");
var LogInError = require("./logInError");
var { emailIsTooLong } = require("models/user/auth-limits");

module.exports = function checkEmail(req, res, next) {
  var email = req.body && req.body.email;

  if (typeof email !== "string" || !email) return next(new LogInError("NOEMAIL"));
  if (emailIsTooLong(email)) return next(new LogInError("EMAILTOOLONG"));

  res.locals.email = email;

  User.getByEmail(email, function (err, user) {
    if (err) return next(err);

    // The supplied email address does not
    // match a user in our database.
    if (!user) return next(new LogInError("BADEMAIL"));

    res.locals.email = user.email;
    res.locals.validemail = true;
    req.user = user;
    res.locals.then = req.query.then;

    next();
  });
};
