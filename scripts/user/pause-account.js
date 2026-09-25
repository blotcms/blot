// Pauses a user's Stripe subscription collection and disables their blogs,
// so the site stays around (not deleted, not rendering) without collecting
// money. models/user/removal treats any subscription with pause_collection
// set as excluded from the overdue/cancellation deletion checks, so pausing
// here is what keeps the account out of scripts/user/delete-users-to-remove.js
// and the daily subscription-lifecycle job.
//
// Usage: node scripts/user/pause-account.js <email>

var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var colors = require("colors/safe");
var User = require("models/user");
var get = require("../get/user");
var getConfirmation = require("../util/getConfirmation");

var email = process.argv[2];

if (!email) {
  console.log("Usage: node scripts/user/pause-account.js <email>");
  process.exit(1);
}

get(email, function (err, user) {
  if (err) throw err;

  if (!user.subscription || !user.subscription.id || !user.subscription.customer) {
    console.log(colors.red(user.email + " has no Stripe subscription to pause"));
    return process.exit(1);
  }

  if (user.subscription.pause_collection) {
    console.log(colors.yellow(user.email + " is already paused"));
    return process.exit(0);
  }

  var message = [
    "Pause the Stripe subscription for " +
      colors.yellow(user.email) +
      " " +
      colors.dim(user.uid) +
      " (currently " +
      user.subscription.status +
      ") and disable their blogs?",
    "This stops billing without cancelling the subscription, and excludes",
    "the account from the overdue/cancellation deletion checks. (y/n)",
  ].join("\n");

  getConfirmation(message, function (err, ok) {
    if (!ok) {
      console.log(colors.red("Did not pause " + user.email));
      return process.exit();
    }

    stripe.customers.updateSubscription(
      user.subscription.customer,
      user.subscription.id,
      { pause_collection: { behavior: "void" } },
      function (err, subscription) {
        if (err) throw err;

        User.disable(user, { subscription: subscription }, function (err) {
          if (err) throw err;

          console.log(colors.green("Paused and disabled " + user.email));
          process.exit();
        });
      }
    );
  });
});
