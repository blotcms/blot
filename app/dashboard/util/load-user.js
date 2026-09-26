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

    // Read the persisted flags before extend() overwrites isDisabled with a
    // forward-looking prediction of whether Stripe/PayPal state means the
    // account *should* be disabled - we only want to let someone through
    // here if they're actually disabled right now, and specifically because
    // subscription-lifecycle.js disabled them for non-payment (not because
    // an admin disabled or paused them directly - see disable.js/
    // pause-account.js - even if their subscription also happens to read
    // past_due/unpaid).
    var isDisabled = user.isDisabled;
    var disabledForNonpayment = user.disabledForNonpayment;

    User.extend(user);

    var canPayToReactivate =
      disabledForNonpayment &&
      !(user.subscription && user.subscription.pause_collection);

    // A disabled account can still log in and pay if that's why it was
    // disabled - completing payment re-enables it automatically. Any other
    // disabled account (a cancelled subscription, a paused subscription, or
    // one an admin disabled directly) still gets sent away.
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
