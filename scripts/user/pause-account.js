// Pauses a user's Stripe subscription collection and disables their blogs,
// so the site stays around (not deleted, not rendering) without collecting
// money. models/user/removal treats any subscription with pause_collection
// set as excluded from the overdue/cancellation deletion checks, so pausing
// here is what keeps the account out of scripts/user/delete-users-to-remove.js
// and the daily subscription-lifecycle job.
//
// Usage: node scripts/user/pause-account.js <email>

var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var colors = require("colors/safe");
var User = require("models/user");
var get = require("../get/user");
var getConfirmation = require("../util/getConfirmation");
var { promisify } = require("util");

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
async function clearExistingInvoices(subscriptionId) {
  var toVoid = [];
  var toDelete = [];

  await Promise.all([
    stripe.invoices
      .list({ subscription: subscriptionId, status: "open", limit: 100 })
      .autoPagingEach(function (invoice) {
        toVoid.push(invoice.id);
      }),
    stripe.invoices
      .list({ subscription: subscriptionId, status: "draft", limit: 100 })
      .autoPagingEach(function (invoice) {
        toDelete.push(invoice.id);
      }),
  ]);

  await Promise.all(
    toVoid.map(function (invoiceId) {
      return stripe.invoices.voidInvoice(invoiceId);
    })
  );

  await Promise.all(
    toDelete.map(function (invoiceId) {
      return stripe.invoices.del(invoiceId);
    })
  );

  return { voided: toVoid, deleted: toDelete };
}

async function main() {
  var user = await promisify(get)(email);

  if (
    !user.subscription ||
    !user.subscription.id ||
    !user.subscription.customer
  ) {
    console.log(
      colors.red(user.email + " has no Stripe subscription to pause")
    );
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

  var ok = await getConfirmation(message);

  if (!ok) {
    console.log(colors.red("Did not pause " + user.email));
    return process.exit();
  }

  // Always check the live subscription rather than trusting our cached
  // copy: pause_collection can have a resumes_at in the past, or the cache
  // can simply be stale, so "already paused" isn't reliable evidence that
  // it's still paused right now.
  var liveSubscription = await stripe.customers.retrieveSubscription(
    user.subscription.customer,
    user.subscription.id
  );

  var subscription = liveSubscription.pause_collection
    ? liveSubscription
    : await stripe.customers.updateSubscription(
        user.subscription.customer,
        user.subscription.id,
        { pause_collection: { behavior: "void" } }
      );

  var cleared = await clearExistingInvoices(subscription.id);

  if (cleared.voided.length) {
    console.log(
      colors.yellow(
        "Voided " +
          cleared.voided.length +
          " open invoice(s): " +
          cleared.voided.join(", ")
      )
    );
  }
  if (cleared.deleted.length) {
    console.log(
      colors.yellow(
        "Deleted " +
          cleared.deleted.length +
          " draft invoice(s): " +
          cleared.deleted.join(", ")
      )
    );
  }

  // Disabling always happens, even if collection was already
  // paused by hand on Stripe: this is what keeps the blogs from
  // rendering.
  await User.disable(user, { subscription: subscription });

  console.log(colors.green("Paused and disabled " + user.email));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
