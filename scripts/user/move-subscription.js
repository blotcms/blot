var from = process.argv[2];
var to = process.argv[3];

var get = require("../get/user");

var User = require("models/user");
var { promisify } = require("util");

console.log(from);
console.log(to);

async function main() {
  var oldUser = await promisify(get)(from);
  var newUser = await promisify(get)(to);

  var customerID = oldUser.subscription.customer;

  var newSubscription = { subscription: oldUser.subscription };
  var oldSubscription = {
    subscription: newUser.subscription,
  };

  console.log("Customer ID", customerID);

  console.log("Subscription for ", to);
  console.log(newSubscription);

  console.log("Subscription for ", from);
  console.log(oldSubscription);

  await User.set(newUser.uid, newSubscription);
  await User.disable(oldUser, oldSubscription);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
