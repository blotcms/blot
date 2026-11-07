var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");
var key = require("./key");
var client = require("models/client");
var validate = require("./validate");
var generateId = require("./generateId");

module.exports = promiseOnly(
  async function create(email, passwordHash, subscription, paypal) {
    ensure(email, "string")
      .and(passwordHash, "string")
      .and(subscription, "object")
      .and(paypal, "object");

    try {
      // Retry with a new ID if the generated one was in use
      while (true) {
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
          paymentMethods: [],
          passwordHash: passwordHash,
        };

        user = (await validate({ uid: uid }, user)).user;

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

        if (results && (results[1] === false || results[1] === 0)) continue;

        return user;
      }
    } catch (err) {
      console.log(err);
      throw err;
    }
  }
);
