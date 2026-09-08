/*

SIGNUP SUCCESS
customer.created
invoice.created
invoice.payment_succeeded
customer.card.created
charge.succeeded
customer.subscription.created

SIGNUP FAILED
charge.failed

UPDATE PAYMENT METHOD
customer.card.deleted
customer.card.created
customer.updated
customer.subscription.updated

CANCEL SUBSCRIPTION
customer.subscription.updated

RENEW SUCCESS
invoice.created
customer.subscription.updated
invoice.payment_succeeded
charge.succeeded
customer.updated IF prev failed renew attempt then

RENEW FAIL
invoice.created
customer.subscription.updated
invoice.payment_failed
charge.failed
customer.updated to set delinquent flag
invoice.updated to track attempted charges
customer.subscription.updated IF NOT FINAL CHARGE ATTEMPT
customer.subscription.deleted IF IS FINAL CHARGE ATTEMPT


*/

var parser = require("body-parser");
var Express = require("express");
var config = require("config");
var email = require("helper/email");
var User = require("models/user");
var subscriptionLifecycle = require("models/user/subscriptionLifecycle");
var createStripe = require("stripe");

var webhooks = Express.Router();

// Stripe event codes
var UPDATED_SUBSCRIPTION = "customer.subscription.updated";
var DELETED_SUBSCRIPTION = "customer.subscription.deleted";

// Error messages
var NO_SUBSCRIPTION = "No subscription retrieved from Stripe";
var NO_USER = "No user retrieved from the database";
var NO_STRIPE_CLIENT = "Stripe secret is not configured";

var stripeClient;

function getStripeClient() {
  if (stripeClient) return stripeClient;

  if (!config.stripe || !config.stripe.secret) return null;

  stripeClient = createStripe(config.stripe.secret);

  return stripeClient;
}

// Stripe sends us a webhook when user subscriptions change
// Some reasons they might change:
// - Renewal payment fails
// - I make some change to a user subscription directly on the
//   Stripe dashboard, this webhook tells Blot to pull the latest
//   state from Stripe.
// - There are probably other things I'm missing....

// If a signing secret is configured we verify Stripe's signature over the raw
// request body and construct the event via the Stripe SDK. If it is not
// configured we fall back to parsing the (unverified) body, so this change is
// safe to deploy before BLOT_STRIPE_WEBHOOK_SECRET is set. Returns the event,
// or null after already sending an error response.
function verifyStripeEvent(req, res) {
  var rawBody = req.body;
  var signingSecret = config.stripe && config.stripe.webhook_secret;

  if (signingSecret) {
    var stripe = getStripeClient();

    if (!stripe || !stripe.webhooks || !stripe.webhooks.constructEvent) {
      console.error(NO_STRIPE_CLIENT);
      res.sendStatus(500);
      return null;
    }

    try {
      return stripe.webhooks.constructEvent(
        rawBody,
        req.headers["stripe-signature"],
        signingSecret
      );
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      res.sendStatus(400);
      return null;
    }
  }

  // No signing secret configured: preserve the previous, unverified behaviour.
  console.warn(
    "Stripe webhook signature NOT verified - set BLOT_STRIPE_WEBHOOK_SECRET to enable"
  );

  try {
    return Buffer.isBuffer(rawBody)
      ? JSON.parse(rawBody.toString("utf8"))
      : rawBody;
  } catch (err) {
    console.error("Stripe webhook body is not valid JSON");
    res.sendStatus(400);
    return null;
  }
}

webhooks.post("/", parser.raw({ type: "application/json" }), function (req, res) {
  // Down for maintenance, Stripe should
  // back off and try again later.
  if (config.maintenance) return res.sendStatus(503);

  var event = verifyStripeEvent(req, res);

  // verifyStripeEvent has already sent a response if it returned null.
  if (!event) return;

  if (!event.type) {
    console.error("Stripe webhook missing event type");
    return res.sendStatus(400);
  }

  var event_data = event.data && event.data.object;

  if (
    event.type === UPDATED_SUBSCRIPTION ||
    event.type === DELETED_SUBSCRIPTION
  ) {
    if (!event_data || !event_data.customer || !event_data.id) {
      console.error("Stripe subscription event missing identifiers");
      return res.sendStatus(400);
    }
  }

  // A customer's subscription was changed, save changed info
  if (event.type === UPDATED_SUBSCRIPTION || event.type === DELETED_SUBSCRIPTION) {
    var stripe = getStripeClient();

    if (!stripe || !stripe.customers || !stripe.customers.retrieveSubscription) {
      console.error(NO_STRIPE_CLIENT);
      return res.sendStatus(500);
    }

    return stripe.customers.retrieveSubscription(
      event_data.customer,
      event_data.id,
      function (err, subscription) {
        if (err || !subscription) {
          console.error("Failed to retrieve Stripe subscription", err);
          return res.sendStatus(400);
        }

        update_subscription(
          event_data.customer,
          subscription,
          function (updateErr) {
            if (updateErr) console.error("Failed to update subscription", updateErr);
          }
        );

        return res.sendStatus(200);
      }
    );
  }

  return res.sendStatus(200);
});

function update_subscription(customer_id, subscription, callback) {
  callback = callback || function () {};

  if (!subscription) return callback(new Error(NO_SUBSCRIPTION));

  User.getByCustomerId(customer_id, function (err, user) {
    if (err || !user) return callback(err || new Error(NO_USER));

    var previousSubscription = user.subscription || {};
    var shouldDisable = subscriptionLifecycle.shouldDisableFromStripeSubscription(
      subscription
    );

    if (subscription.status === "canceled" && user.isDisabled)
      email.ALREADY_CANCELLED(user.uid);

    if (subscription.status === "canceled" && !user.isDisabled)
      email.CLOSED(user.uid);

    if (subscription.status === "past_due") email.OVERDUE(user.uid);

    if (
      subscription.status === "active" &&
      (previousSubscription.status === "past_due" ||
        previousSubscription.status === "unpaid")
    )
      email.RECOVERED(user.uid);

    if (
      subscription.status === "unpaid" &&
      previousSubscription.status !== "unpaid"
    )
      email.OVERDUE_CLOSURE(user.uid);

    var updates = { subscription: subscription };
    var handler = function (next) {
      User.set(user.uid, updates, next);
    };

    if (shouldDisable && !user.isDisabled) {
      handler = function (next) {
        User.disable(user, updates, next);
      };
    } else if (!shouldDisable && subscription.status === "active" && user.isDisabled) {
      handler = function (next) {
        User.enable(user, updates, next);
      };
    }

    handler(callback);
  });
}

module.exports = webhooks;
module.exports.update_subscription = update_subscription;
module.exports._setStripeClient = function (client) {
  stripeClient = client;
};
module.exports._resetStripeClient = function () {
  stripeClient = null;
};
