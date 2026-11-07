var User = require("models/user");
var syncPaymentMethods = require("models/user/syncPaymentMethods");
var getConfirmation = require("../util/getConfirmation");
var each = require("../each/user");
var colors = require("colors/safe");

function syncUserPaymentMethods(user) {
  return syncPaymentMethods(user);
}

async function main(user) {
  if (!user.subscription || !user.subscription.customer) {
    console.log(
      colors.dim(
        "User:",
        user.uid,
        user.email,
        "does not have a Stripe subscription"
      )
    );

    return;
  }

  var paymentMethods;

  try {
    paymentMethods = await syncUserPaymentMethods(user);
  } catch (err) {
    // Same anomaly fetch-subscription-from-stripe.js guards against: the
    // Blot account still points at a Stripe customer that no longer
    // exists. Log and move on rather than aborting the whole backfill -
    // scripts/each/user stops at the first error, so one deleted customer
    // would otherwise silently strand every account after it until someone
    // re-ran the script by hand.
    if (err.code === "resource_missing") {
      console.log(
        colors.red(
          "User:",
          user.uid,
          user.email,
          "has a Stripe customer id that no longer exists on Stripe"
        )
      );
      return;
    }

    console.log(
      colors.red("User:", user.uid, user.email, "failed to sync:", err.message)
    );
    throw err;
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

  return paymentMethods;
}

async function run() {
  if (process.argv[2]) {
    var user = await User.getByEmail(process.argv[2]);
    if (!user) throw new Error("No user");

    await main(user);
  } else {
    var ok = await getConfirmation(
      "Fetch payment methods from Stripe for all users? (y/N)"
    );

    if (!ok) return process.exit();

    await each(main);
  }

  console.log("Done!");
  process.exit();
}

if (require.main === module) {
  run().then(
    function () {
      process.exit(0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = main;
