var from = process.argv[2];
var newSubscriptionID = process.argv[4];
var newCustomerID = process.argv[3];
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
  if (!newSubscriptionID) throw "No Subscription id";
  if (!newCustomerID) throw "No Customer id";

  console.log("Previous subscription is ", user.subscription);

  var subscription = await stripe.customers.retrieveSubscription(
    newCustomerID,
    newSubscriptionID
  );

  if (!subscription) throw "No subscription found from Stripe";

  console.log("------------------");
  console.log("new subscription is:");

  console.log(subscription);

  await promisify(User.set)(user.uid, { subscription: subscription });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
