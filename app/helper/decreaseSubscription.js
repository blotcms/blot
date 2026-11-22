const config = require("config");
const stripe = require("stripe")(config.stripe.secret);
const User = require("models/user");
const Email = require("helper/email");

// Reduces a customer's Stripe subscription to the number of sites they have
// left, after a site was deleted. The quantity comes from the owner's current
// blogs, not from taking one off the stored quantity, so running it again
// changes nothing. Used by the delete route and by the scheduler, which
// finishes it when a deploy interrupted the route.
//
// Resolves to { changed, quantity } or { skipped: reason } when the account is
// deleted, has no active Stripe subscription (cancelled, PayPal, free) or is
// not paying for more sites than it has. Rejects if Stripe fails.
//
// A subscription is never for fewer than one site, and a customer with free
// sites has more sites than quantity, which is left alone.
async function decreaseSubscription(uid) {
  const user = await User.getById(uid);

  if (!user) return { skipped: "no user" };

  const subscription = user.subscription;

  if (
    !subscription ||
    !subscription.customer ||
    !subscription.id ||
    subscription.status !== "active"
  )
    return { skipped: "no active subscription" };

  const quantity = Math.max(1, (user.blogs || []).length);

  if (quantity >= subscription.quantity) return { skipped: "already reduced" };

  const updated = await stripe.customers.updateSubscription(
    subscription.customer,
    subscription.id,
    { quantity: quantity, prorate: false }
  );

  if (!updated) throw new Error("No subscription");

  await User.set(uid, { subscription: updated });
  Email.SUBSCRIPTION_DECREASE(uid);

  return { changed: true, quantity: quantity };
}

module.exports = decreaseSubscription;
// So specs can replace the Stripe calls
module.exports.stripe = stripe;
