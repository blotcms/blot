var prettyPrice = require("helper/prettyPrice");
var User = require("models/user");

var PAY = "/sites/account/pay-subscription";
var DELETE = "/sites/account/subscription/delete";
var LOGOUT = "/sites/account/log-out";
var PASSWORD_SET = "/sites/account/password/set";

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

    // Read the persisted flag before extend() overwrites it with a
    // forward-looking prediction of whether Stripe/PayPal state means the
    // account *should* be disabled - we only want to let someone through
    // here if they're actually disabled right now.
    var isDisabled = user.isDisabled;

    User.extend(user);

    // A subscription an admin has paused (scripts/user/pause-account.js)
    // is deliberately kept disabled without billing, even if its Stripe
    // status still reads past_due/unpaid - don't treat that as payable.
    var canPayToReactivate =
      user.needsToPay &&
      !(user.subscription && user.subscription.pause_collection);

    // A disabled account can still log in and pay if that's why it was
    // disabled - completing payment re-enables it automatically via the
    // subscription webhook. Any other disabled account (a cancelled
    // subscription, a paused subscription, or one an admin disabled
    // directly) still gets sent away.
    if (isDisabled && !canPayToReactivate) {
      return res.redirect("/sites/disabled");
    }

    // Lets append the user and
    // set the partials to 'logged in mode'
    req.user = user;
    res.locals.user = user;

    if (
      user.needsToPay &&
      req.originalUrl !== PAY &&
      req.originalUrl !== DELETE &&
      req.originalUrl !== LOGOUT &&
      req.originalUrl !== PASSWORD_SET
    ) {
      return res.redirect(PAY);
    }

    if (user.subscription && user.subscription.plan) {
      res.locals.price = prettyPrice(user.subscription.plan.amount);
      res.locals.interval = user.subscription.plan.interval;
    }

    next();
  });
};
