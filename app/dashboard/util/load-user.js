var prettyPrice = require("helper/prettyPrice");
var User = require("models/user");

var PAY = "/sites/account/pay-subscription";
var DELETE = "/sites/account/subscription/delete";
var LOGOUT = "/sites/account/log-out";

module.exports = function (req, res, next) {
  if (!req.session || !req.session.uid) return next();

  var uid = req.session.uid;

  User.getById(uid, function (err, user) {
    if (err) return next(err);

    if (!user) {
      req.user = null;
      req.session.uid = null;
      return next();
    }

    User.extend(user);

    // A disabled account can still log in and pay if that's why it was
    // disabled - completing payment re-enables it automatically via the
    // subscription webhook. Any other disabled account (a cancelled
    // subscription, or one an admin disabled directly) still gets sent away.
    if (user.isDisabled && !user.needsToPay) {
      return res.redirect("/sites/disabled");
    }

    // Lets append the user and
    // set the partials to 'logged in mode'
    req.user = user;
    res.locals.user = user;

    if (user.needsToPay && req.originalUrl !== PAY && req.originalUrl !== DELETE && req.originalUrl !== LOGOUT) {
      return res.redirect(PAY);
    }

    if (user.subscription && user.subscription.plan) {
      res.locals.price = prettyPrice(user.subscription.plan.amount);
      res.locals.interval = user.subscription.plan.interval;
    }

    next();
  });
};
