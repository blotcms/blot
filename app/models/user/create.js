var ensure = require("helper/ensure");
var key = require("./key");
var client = require("models/client");
var validate = require("./validate");
var generateId = require("./generateId");
var scheduleSubscriptionEmail = require("./scheduleSubscriptionEmail");

module.exports = function create (
  email,
  passwordHash,
  subscription,
  paypal,
  callback
) {
  ensure(email, "string")
    .and(passwordHash, "string")
    .and(subscription, "object")
    .and(paypal, "object")
    .and(callback, "function");

  (async function () {
    try {
      var uid = generateId();

      var user = {
        uid: uid,
        isDisabled: false,
        blogs: [],
        lastSession: "",
        created: Date.now(),
        welcomeEmailSent: false,
        email: email,
        subscription: subscription,
        paypal: paypal,
        passwordHash: passwordHash
      };

      user = await new Promise(function (resolve, reject) {
        validate({ uid: uid }, user, function (err, validatedUser) {
          if (err) return reject(err);
          return resolve(validatedUser);
        });
      });

      var userString = JSON.stringify(user);

      // If I add or remove an index key here (email/customer/paypal),
      // also update the indexes() helper in set.js.
      var multi = client.multi();
      multi.sAdd(key.uids, uid);
      multi.setNX(key.user(uid), userString);
      multi.set(key.email(user.email), uid);
      multi.set(key.user(uid), userString);

      // some users might not have stripe subscriptions
      if (user.subscription && user.subscription.customer)
        multi.set(key.customer(user.subscription.customer), uid);

      // some users might not have paypal subscriptions
      if (user.paypal && user.paypal.id)
        multi.set(key.paypal(user.paypal.id), uid);

      var results = await multi.exec();

      // Retry if generated ID was in use
      if (results && (results[1] === false || results[1] === 0))
        return create(email, passwordHash, subscription, paypal, callback);

      // Schedule a notifcation email for their subscription renewal
      scheduleSubscriptionEmail(user.uid, function (err) {
        if (err) console.log(err);
      });

      return callback(null, user);
    } catch (err) {
      console.log(err);
      return callback(err);
    }
  })();
};
