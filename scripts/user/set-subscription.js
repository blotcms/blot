var from = process.argv[2];
var newSubscriptionID = process.argv[4];
var newCustomerID = process.argv[3];
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);

var User = require("models/user");

User.getByEmail(from, function (err, user) {
  if (!user) throw "No user";
  if (!newSubscriptionID) throw "No Subscription id";
  if (!newCustomerID) throw "No Customer id";

  console.log("Previous subscription is ", user.subscription);

  stripe.customers.retrieveSubscription(
    newCustomerID,
    newSubscriptionID,
    function (err, subscription) {
      if (err) throw err;

      if (!subscription) throw "No subscription found from Stripe";

      console.log("------------------");
      console.log("new subscription is:");

      console.log(subscription);

      User.set(user.uid, { subscription: subscription }, function (err) {
        if (err) throw err;

        process.exit();
      });
    }
  );
});
