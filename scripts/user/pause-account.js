// Pauses a user's Stripe subscription collection and disables their blogs,
// so the site stays around (not deleted, not rendering) without collecting
// money. models/user/removal treats any subscription with pause_collection
// set as excluded from the overdue/cancellation deletion checks, so pausing
// here is what keeps the account out of scripts/user/delete-users-to-remove.js
// and the daily subscription-lifecycle job.
//
// Usage: node scripts/user/pause-account.js <email>

var async = require("async");
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var colors = require("colors/safe");
var User = require("models/user");
var get = require("../get/user");
var getConfirmation = require("../util/getConfirmation");

var email = process.argv[2];

if (!email) {
  console.log("Usage: node scripts/user/pause-account.js <email>");
  process.exit(1);
}

// pause_collection only stops invoices from being created going forward -
// any invoice already open (e.g. the one that made the account overdue in
// the first place) keeps retrying on its own schedule unless we void it too.
function voidOpenInvoices(subscriptionId, callback) {
  var voided = [];

  stripe.invoices
    .list({ subscription: subscriptionId, status: "open", limit: 100 })
    .autoPagingEach(function (invoice) {
      voided.push(invoice.id);
    })
    .then(function () {
      async.each(voided, function (invoiceId, next) {
        stripe.invoices.voidInvoice(invoiceId, next);
      }, function (err) {
        callback(err, voided);
      });
    })
    .catch(callback);
}

get(email, function (err, user) {
  if (err) throw err;

  if (!user.subscription || !user.subscription.id || !user.subscription.customer) {
    console.log(colors.red(user.email + " has no Stripe subscription to pause"));
    return process.exit(1);
  }

  var alreadyPaused = Boolean(user.subscription.pause_collection);

  var message = [
    alreadyPaused
      ? "Collection is already paused for " +
        colors.yellow(user.email) +
        " " +
        colors.dim(user.uid) +
        " (status " +
        user.subscription.status +
        "). Disable their blogs and make sure any open invoices are voided?"
      : "Pause the Stripe subscription for " +
        colors.yellow(user.email) +
        " " +
        colors.dim(user.uid) +
        " (currently " +
        user.subscription.status +
        ") and disable their blogs?",
    "This stops billing without cancelling the subscription, and excludes",
    "the account from the overdue/cancellation deletion checks. (y/n)",
  ].join("\n");

  getConfirmation(message, function (err, ok) {
    if (!ok) {
      console.log(colors.red("Did not pause " + user.email));
      return process.exit();
    }

    var pause = alreadyPaused
      ? function (next) {
          stripe.customers.retrieveSubscription(
            user.subscription.customer,
            user.subscription.id,
            next
          );
        }
      : function (next) {
          stripe.customers.updateSubscription(
            user.subscription.customer,
            user.subscription.id,
            { pause_collection: { behavior: "void" } },
            next
          );
        };

    pause(function (err, subscription) {
      if (err) throw err;

      voidOpenInvoices(subscription.id, function (err, voided) {
        if (err) throw err;

        if (voided.length) {
          console.log(colors.yellow("Voided " + voided.length + " open invoice(s): " + voided.join(", ")));
        }

        // Disabling always happens, even if collection was already paused by
        // hand on Stripe: this is what keeps the blogs from rendering.
        User.disable(user, { subscription: subscription }, function (err) {
          if (err) throw err;

          console.log(colors.green("Paused and disabled " + user.email));
          process.exit();
        });
      });
    });
  });
});
