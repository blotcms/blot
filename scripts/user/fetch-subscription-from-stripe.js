var User = require("models/user");
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var getConfirmation = require("../util/getConfirmation");
var each = require("../each/user");
var colors = require("colors/safe");

async function setUserSubscription(uid, subscription) {
  await User.set(uid, { subscription: subscription });
}

async function main(user) {
  if (
    !user.subscription ||
    !user.subscription.customer ||
    !user.subscription.id
  ) {
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

  var subscription;

  try {
    subscription = await stripe.customers.retrieveSubscription(
      user.subscription.customer,
      user.subscription.id
    );
  } catch (err) {
    if (err.code === "resource_missing" && err.param === "subscription") {
      console.log(
        colors.red(
          "User:",
          user.uid,
          user.email,
          "used to have a Stripe subscription but no longer does, customer still exists on Stripe"
        )
      );
      return;
    }

    if (err.code === "resource_missing" && err.param === "id") {
      console.log(
        colors.red(
          "User:",
          user.uid,
          user.email,
          "used to have a Stripe subscription but no longer does, customer does not exist on Stripe"
        )
      );
      return;
    }

    console.log(err);
    throw err;
  }

  if (!subscription) throw new Error("No subscription");

  await setUserSubscription(user.uid, subscription);

  console.log(
    "User:",
    user.uid,
    user.email,
    user.subscription.customer,
    "updated subscription",
    user.subscription.id
  );

  return subscription;
}

async function run() {
  if (process.argv[2]) {
    var user = await User.getByEmail(process.argv[2]);
    if (!user) throw new Error("No user");

    await main(user);
  } else {
    var ok = await getConfirmation(
      "Fetch latest subscription information from Stripe for all users? (y/N)"
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
