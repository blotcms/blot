var config = require("config");
var withCallback = require("helper/withCallback");
var stripe = require("stripe")(config.stripe.secret);

// This function is reponsible for updating the billing email
// address of the customer at the payment processor. Right
// now it's just Stripe we have to worry about, so it's easy.
module.exports = withCallback(async function updateBillingEmail(user) {
  if (!user.subscription || !user.subscription.customer) return;

  return await new Promise(function (resolve, reject) {
    stripe.customers.update(
      user.subscription.customer,
      { email: user.email },
      function (err, customer) {
        if (err) return reject(err);
        resolve(customer);
      }
    );
  });
});
