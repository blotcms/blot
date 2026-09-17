var Express = require("express");
var Password = new Express.Router();
var User = require("models/user");
var checkPassword = require("./util/checkPassword");
var { passwordIsTooLong } = require("models/user/auth-limits");

Password.route("/")

  .all(requireExisting)

  .get(function (req, res) {
    res.render("dashboard/account/change-password", {
      breadcrumb: "Password",
      title: "Change your password",
    });
  })

  .post(checkPassword, checkMatching, save);

Password.route("/set")

  .all(requireTokenOrLackOfPassword)

  .get(function (req, res) {
    res.render("dashboard/account/set-password", {
      title: "Set your password",
    });
  })

  // We check whether the passwords match
  // before verifying the token because token
  // verification can only happen once and the
  // user might make a mistake typing their
  // password twice or submitting an empty form.
  .post(checkMatching, verifyToken, save);

function requireExisting(req, res, next) {
  if (req.user.hasPassword) {
    next();
  } else {
    res.redirect(req.baseUrl + "/set");
  }
}

// If users have an existing password then they should
// not be able to set their password (i.e. overwrite) unless
// they have a password set token which they will have
// retrieved through the email associated with their account.
function requireTokenOrLackOfPassword(req, res, next) {
  if (req.session.passwordSetToken) {
    return next();
  }

  if (!req.user.hasPassword) {
    return next();
  }

  res.redirect("/");
}

function save(req, res, next) {
  User.hashPassword(req.body.newPasswordA, function (err, passwordHash) {
    if (err) return next(err);

    if (!passwordHash) return next(new Error("Could not hash password"));

    User.set(req.user.uid, { passwordHash: passwordHash }, function (err) {
      if (err) return next(err);
      res.message("/sites", "Saved your new password");
    });
  });
}

function checkMatching(req, res, next) {
  if (!req.body.newPasswordA) {
    return next(new Error("Please choose a new password"));
  }

  if (
    passwordIsTooLong(req.body.newPasswordA) ||
    passwordIsTooLong(req.body.newPasswordB)
  ) {
    return next(new Error("Your new password is too long."));
  }

  if (req.body.newPasswordA !== req.body.newPasswordB) {
    return next(new Error("Your new passwords do not match."));
  }

  next();
}

function verifyToken(req, res, next) {
  if (!req.session.passwordSetToken) return next();

  var token = req.session.passwordSetToken;

  delete req.session.passwordSetToken;

  User.checkAccessToken(token, function (err, uid) {
    if (err) return next(err);

    if (uid !== req.user.uid) {
      return next(new Error("Your token was invalid."));
    }

    next();
  });
}

module.exports = Password;
