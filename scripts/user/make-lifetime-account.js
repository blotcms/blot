var from = process.argv[2];
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var User = require("models/user");
var { promisify } = require("util");

async function main() {
  var user;

  try {
    user = await User.getByEmail(from);
  } catch {
    // Ignored before: a failed lookup ends as "No user" below
  }

  if (!user) throw "No user";

  console.log("Removing:", user.subscription);

  var customerID = user.subscription.customer;
  var subscriptionID = user.subscription.id;

  try {
    await stripe.customers.cancelSubscription(customerID, subscriptionID, {
      at_period_end: false,
    });
  } catch (err) {
    console.error(err);
  }

  await promisify(User.set)(user.uid, { subscription: {} });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
