// A customer whose Stripe subscription is for more sites than they have.
//
// Deleting a site removes it first and reduces the subscription afterwards
// (dashboard/site/delete.js), so a deploy between the two leaves the customer
// paying for a site that is gone. Nothing here changes billing: the daily
// email lists these accounts for the maintainer to look at.
//
// It reads the stored user.subscription (no Stripe calls). A subscription is
// never for fewer than one site, and a customer with free sites has more sites
// than quantity, which is not a mismatch.
function billingMismatch(user) {
  const subscription = user && user.subscription;

  if (!subscription || subscription.status !== "active") return null;

  const quantity = Number(subscription.quantity);
  const blogs = Array.isArray(user.blogs) ? user.blogs.length : 0;

  if (!(quantity > Math.max(blogs, 1))) return null;

  return { email: user.email, quantity, blogs };
}

module.exports = billingMismatch;
