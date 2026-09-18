var config = require("config");
var createStripe = require("stripe");

var stripe;

// Stripe rolls current_period_end forward on unpaid subscriptions, so it can't
// say when the account went overdue. The renewal that first failed stays
// `open` (later invoices are drafts), so its creation time is the answer.
// Calls back with epoch ms, or null if the user isn't unpaid or no open
// invoice exists.
module.exports = function overdueSince(user, callback) {
  var subscription = user && user.subscription;

  if (!subscription || subscription.status !== "unpaid" || !subscription.id)
    return callback(null, null);

  stripe = stripe || createStripe(config.stripe.secret);

  var oldest = null;

  stripe.invoices
    .list({ subscription: subscription.id, status: "open", limit: 100 })
    .autoPagingEach(function (invoice) {
      if (oldest === null || invoice.created < oldest) oldest = invoice.created;
    })
    .then(function () {
      callback(null, oldest === null ? null : oldest * 1000);
    })
    .catch(callback);
};
