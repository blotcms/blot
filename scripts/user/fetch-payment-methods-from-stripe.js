var User = require("models/user");
var syncPaymentMethods = require("models/user/syncPaymentMethods");
var getConfirmation = require("../util/getConfirmation");
var each = require("../each/user");
var colors = require("colors/safe");

function main(user, callback) {
  if (!user.subscription || !user.subscription.customer) {
    console.log(
      colors.dim(
        "User:",
        user.uid,
        user.email,
        "does not have a Stripe subscription"
      )
    );

    return callback();
  }

  syncPaymentMethods(user, function (err, paymentMethods) {
    // Same anomaly fetch-subscription-from-stripe.js guards against: the
    // Blot account still points at a Stripe customer that no longer
    // exists. Log and move on rather than aborting the whole backfill -
    // async.eachSeries in scripts/each/user stops at the first error, so
    // one deleted customer would otherwise silently strand every account
    // after it until someone re-ran the script by hand.
    if (err && err.code === "resource_missing") {
      console.log(
        colors.red(
          "User:",
          user.uid,
          user.email,
          "has a Stripe customer id that no longer exists on Stripe"
        )
      );
      return callback();
    }

    if (err) {
      console.log(
        colors.red("User:", user.uid, user.email, "failed to sync:", err.message)
      );
      return callback(err);
    }

    console.log(
      "User:",
      user.uid,
      user.email,
      user.subscription.customer,
      "found",
      paymentMethods.length,
      "payment method" + (paymentMethods.length === 1 ? "" : "s")
    );

    callback(null, paymentMethods);
  });
}

function done(err) {
  if (err) throw err;
  console.log("Done!");
  process.exit();
}

if (require.main === module) {
  if (process.argv[2]) {
    User.getByEmail(process.argv[2], function (err, user) {
      if (err || !user) throw err || new Error("No user");
      main(user, done);
    });
  } else {
    getConfirmation(
      "Fetch payment methods from Stripe for all users? (y/N)",
      function (err, ok) {
        if (!ok) return process.exit();
        each(main, done);
      }
    );
  }
}

module.exports = main;
