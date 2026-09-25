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
// anything already generated (e.g. the invoice that made the account
// overdue in the first place) keeps retrying/finalizing on its own schedule
// unless we clear it too. Open invoices are voided; draft invoices haven't
// been finalized yet (never charged), so they're deleted outright instead.
function clearExistingInvoices(subscriptionId, callback) {
  var toVoid = [];
  var toDelete = [];

  async.parallel(
    [
      function (next) {
        stripe.invoices
          .list({ subscription: subscriptionId, status: "open", limit: 100 })
          .autoPagingEach(function (invoice) {
            toVoid.push(invoice.id);
          })
          .then(function () {
            next();
          })
          .catch(next);
      },
      function (next) {
        stripe.invoices
          .list({ subscription: subscriptionId, status: "draft", limit: 100 })
          .autoPagingEach(function (invoice) {
            toDelete.push(invoice.id);
          })
          .then(function () {
            next();
          })
          .catch(next);
      },
    ],
    function (err) {
      if (err) return callback(err);

      async.series(
        [
          function (next) {
            async.each(toVoid, function (invoiceId, done) {
              stripe.invoices.voidInvoice(invoiceId, done);
            }, next);
          },
          function (next) {
            async.each(toDelete, function (invoiceId, done) {
              stripe.invoices.del(invoiceId, done);
            }, next);
          },
        ],
        function (err) {
          callback(err, { voided: toVoid, deleted: toDelete });
        }
      );
    }
  );
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

    function pauseSubscription(next) {
      stripe.customers.updateSubscription(
        user.subscription.customer,
        user.subscription.id,
        { pause_collection: { behavior: "void" } },
        next
      );
    }

    // Always check the live subscription rather than trusting our cached
    // copy: pause_collection can have a resumes_at in the past, or the cache
    // can simply be stale, so "already paused" isn't reliable evidence that
    // it's still paused right now.
    stripe.customers.retrieveSubscription(
      user.subscription.customer,
      user.subscription.id,
      function (err, liveSubscription) {
        if (err) throw err;

        var next = liveSubscription.pause_collection
          ? function (cb) {
              cb(null, liveSubscription);
            }
          : pauseSubscription;

        next(function (err, subscription) {
          if (err) throw err;

          clearExistingInvoices(subscription.id, function (err, cleared) {
            if (err) throw err;

            if (cleared.voided.length) {
              console.log(colors.yellow("Voided " + cleared.voided.length + " open invoice(s): " + cleared.voided.join(", ")));
            }
            if (cleared.deleted.length) {
              console.log(colors.yellow("Deleted " + cleared.deleted.length + " draft invoice(s): " + cleared.deleted.join(", ")));
            }

            // Disabling always happens, even if collection was already
            // paused by hand on Stripe: this is what keeps the blogs from
            // rendering.
            User.disable(user, { subscription: subscription }, function (err) {
              if (err) throw err;

              console.log(colors.green("Paused and disabled " + user.email));
              process.exit();
            });
          });
        });
      }
    );
  });
});
