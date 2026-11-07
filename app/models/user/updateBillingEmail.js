var config = require("config");
var stripe = require("stripe")(config.stripe.secret);

// This function is reponsible for updating the billing email
// address of the customer at the payment processor. Right
// now it's just Stripe we have to worry about, so it's easy.
module.exports = async function updateBillingEmail(user) {
  if (!user.subscription || !user.subscription.customer) return;

  return await stripe.customers.update(user.subscription.customer, {
    email: user.email,
  });
};
