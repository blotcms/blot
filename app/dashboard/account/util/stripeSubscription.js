const config = require("config");
const stripe = require("stripe")(config.stripe.secret);

// What Stripe says of the subscription stored on a user:
//   { state: "found" }                      it exists
//   { state: "replaced", subscription }     it's gone, but the customer has
//                                           another active one
//   { state: "missing" }                    it's gone, and nothing replaces it
//   { state: "none" }                       the user has no Stripe subscription
// Only Stripe's "resource_missing" answer counts as gone. Any other error is
// thrown, so a Stripe outage never looks like a lapsed subscription. A stored
// subscription can go missing when its cancellation webhook was lost; nothing
// here changes the stored state.
async function checkStripeSubscription(user, client = stripe) {
  const { customer, id } = (user && user.subscription) || {};
  if (!customer || !id) return { state: "none" };

  try {
    await client.customers.retrieveSubscription(customer, id);
    return { state: "found" };
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  let active;

  try {
    active = await client.subscriptions.list({
      customer,
      status: "active",
      limit: 1,
    });
  } catch (err) {
    // The customer itself is gone
    if (isMissing(err)) return { state: "missing" };
    throw err;
  }

  const subscription = active && active.data && active.data[0];
  return subscription
    ? { state: "replaced", subscription }
    : { state: "missing" };
}

function isMissing(err) {
  return !!err && err.code === "resource_missing";
}

module.exports = checkStripeSubscription;
