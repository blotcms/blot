var Express = require("express");
var Subscription = new Express.Router();
var User = require("models/user");
var User = require("models/user");
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var email = require("helper/email");
var subscriptionLifecycle = require("models/user/subscriptionLifecycle");
var prettyPrice = require("helper/prettyPrice");
const PLAN_MAP = config.stripe.plan_map;

Subscription.route("/").get(function (req, res) {
  res.render("dashboard/account/subscription", {
    title: "Your account",
    monthly: req.user.isMonthly
  });
});

Subscription.use("/delete", require("./delete"));

Subscription.use("/payment-method", require("./payment-method"));

Subscription.route("/cancel")

  .all(requireSubscription)

  .get(function (req, res) {
    res.render("dashboard/account/cancel", {
      title: "Cancel your subscription",
      // Only an ACTIVE PayPal subscription is cancelled at PayPal
      paypal: req.user.paypal && req.user.paypal.status === "ACTIVE"
    });
  })

  .post(
    cancelStripeSubscription,
    cancelPaypalSubscription,
    function (req, res) {
      // PayPal's cancellation email is sent by updateSubscription, once,
      // however many times PayPal's webhook also reports the cancellation.
      if (req.cancelledStripe) {
        if (subscriptionLifecycle.isFirstPeriod(req.user)) {
          email.CANCELLED_FIRST_PERIOD(req.user.uid);
        } else {
          email.CANCELLED(req.user.uid);
        }
      }

      res.message(req.baseUrl, "Your subscription has been cancelled");
    }
  );

Subscription.route("/billing-interval")

  .all(requireSubscription)

  .all(retrieveSubscription)

  .all(determineNewPlan)

  .get(function (req, res) {
    let credit;
    let proration;
    let now = Date.now() / 1000;
    let monthly =
      req.user.subscription &&
      req.user.subscription.plan &&
      req.user.subscription.plan.interval === "month";

    let new_plan_amount_integer =
      parseInt(req.new_plan_id.split("_").pop()) * 100;
    let new_amount = prettyPrice(
      new_plan_amount_integer * req.user.subscription.quantity
    );
    let percentage =
      (req.user.subscription.current_period_end - now) /
      (req.user.subscription.current_period_end -
        req.user.subscription.current_period_start);

    if (monthly) {
      proration = prettyPrice(
        new_plan_amount_integer * req.user.subscription.quantity -
          percentage *
            req.user.subscription.plan.amount *
            req.user.subscription.quantity
      );
    } else {
      credit = prettyPrice(
        percentage *
          req.user.subscription.plan.amount *
          req.user.subscription.quantity -
          new_plan_amount_integer * req.user.subscription.quantity
      );
    }

    res.render("dashboard/account/billing-interval", {
      title: "Switch your subscription interval",
      proration: proration,
      credit: credit,
      monthly: monthly,
      new_amount: new_amount
    });
  })

  .post(function (req, res, next) {
    stripe.customers.updateSubscription(
      req.user.subscription.customer,
      req.user.subscription.id,
      {
        quantity: req.user.subscription.quantity,
        cancel_at_period_end: false,
        proration_behavior: "create_prorations",
        plan: req.new_plan_id
      },
      function (err, subscription) {
        if (err) {
          return next(err);
        }

        if (!subscription) {
          return next(new Error("No subscription"));
        }

        User.set(req.user.uid, { subscription: subscription }, function (err) {
          if (err) {
            return next(err);
          }

          email.BILLING_INTERVAL(req.user.uid);
          res.message(
            req.baseUrl,
            "You are now billed once a " +
              (subscription.plan.interval === "month" ? "month" : "year")
          );
        });
      }
    );
  });

Subscription.route("/create")

  .all(requireLackOfSubscription)

  .get(function (req, res) {
    res.locals.price =
      "$" +
      parseInt(config.stripe.plan.split("_").pop()) * req.user.blogs.length;
    res.locals.interval =
      config.stripe.plan.indexOf("monthly") === 0 ? "month" : "year";
    res.locals.stripe_key = config.stripe.key;
    res.render("dashboard/account/create-subscription", {
      title: "Create subscription",
      breadcrumb: "Create subscription"
    });
  })

  .post(createStripeSubscription, function (req, res) {
    email.CREATED_BLOG(req.user.uid);
    res.message(req.baseUrl, "You created a subscription");
  });

Subscription.route("/restart")

  .all(retrieveSubscription)

  .all(requireCancelledSubscription)

  .get(function (req, res) {
    res.render("dashboard/account/restart", {
      title: "Restart your subscription",
      breadcrumb: "Restart"
    });
  })

  .post(restartStripeSubscription, function (req, res) {
    email.RESTART(req.user.uid);
    res.message(req.baseUrl, "Restarted your subscription");
  });

Subscription.route("/restart/pay")

  .all(requireCancelledSubscription)

  .get(function (req, res) {
    res.render("dashboard/account/restart-pay", {
      title: "Restart your subscription",
      stripe_key: config.stripe.key,
      breadcrumb: "Restart"
    });
  })

  .post(recreateStripeSubscription, function (req, res) {
    email.RESTART(req.user.uid);
    res.message(req.baseUrl, "Restarted your subscription");
  });

function determineNewPlan (req, res, next) {
  let new_plan_id = PLAN_MAP[req.user.subscription.plan.id];

  if (!new_plan_id) return next(new Error("You cannot switch your plan"));

  req.new_plan_id = new_plan_id;

  return next();
}

function requireCancelledSubscription (req, res, next) {
  // Only a cancelled Stripe subscription can be restarted: PayPal can't
  // reactivate a cancelled subscription. Historical PayPal data on a user
  // with a Stripe subscription doesn't matter.
  if (
    !req.user.isSubscribed &&
    req.user.subscription &&
    req.user.subscription.customer
  ) {
    next();
  } else {
    res.redirect("/account/subscription");
  }
}

function requireLackOfSubscription (req, res, next) {
  // Make sure the user does not have a subscription
  // otherwise they might create multiple
  if (!req.user.subscription || !req.user.subscription.customer) {
    next();
  } else {
    res.redirect("/account/subscription");
  }
}

function requireSubscription (req, res, next) {
  // Make sure the user has a subscription
  // otherwise they have nothing to cancel
  if (req.user.isSubscribed) {
    next();
  } else if (req.user.subscription && req.user.subscription.customer) {
    res.redirect("/account/restart");
  } else {
    res.redirect("/account/subscription");
  }
}

const paypal = require("dashboard/webhooks/paypal_webhook");

// Cancels at PayPal, then re-fetches the subscription so the CANCELLED status
// is saved and the cancellation email sent now rather than when PayPal's own
// webhook arrives. PayPal keeps the paid period running, as for Stripe's
// cancel_at_period_end, so access continues until it ends.
async function cancelPaypalSubscription (req, res, next) {
  const id = req.user.paypal && req.user.paypal.id;

  if (!id || req.user.paypal.status !== "ACTIVE") return next();

  try {
    const response = await fetch(
      `${config.paypal.api_base}/v1/billing/subscriptions/${id}/cancel`,
      {
        method: "POST",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              `${config.paypal.client_id}:${config.paypal.secret}`
            ).toString("base64"),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ reason: "Customer cancelled subscription" })
      }
    );

    if (response.status !== 204) {
      const rejected = new Error(`PayPal cancel API error: ${response.status}`);
      // A 5xx is indeterminate: PayPal may have applied the cancel.
      rejected.rejected = response.status < 500;
      throw rejected;
    }
  } catch (err) {
    // A transport failure may come after PayPal applied the cancel, so ask
    // PayPal rather than report a failure for a subscription that is
    // cancelled. Otherwise the webhook repairs it when PayPal reports it.
    if (err.rejected) return next(err);

    try {
      const current = await paypal.updateSubscription(id);
      if (current && current.status === "CANCELLED") return next();
    } catch (fetchErr) {
      console.log("PayPal cancel: reconcile after failure failed:", fetchErr);
    }

    return next(err);
  }

  // PayPal has cancelled, so a failed re-fetch is not a failed cancellation.
  // Don't write CANCELLED locally: PayPal's BILLING.SUBSCRIPTION.CANCELLED
  // webhook will save the status and send the email, and it only does so if
  // it sees the transition.
  try {
    await paypal.updateSubscription(id);
  } catch (err) {
    console.log("PayPal cancel: re-fetch after cancelling failed:", err);
  }

  next();
}

function cancelStripeSubscription (req, res, next) {
  if (!req.user.subscription.customer) return next();

  stripe.customers.cancelSubscription(
    req.user.subscription.customer,
    req.user.subscription.id,
    { at_period_end: true },
    function (err, subscription) {
      if (err) return next(err);

      if (!subscription) return next(new Error("No subscription"));

      req.cancelledStripe = true;
      User.set(req.user.uid, { subscription: subscription }, next);
    }
  );
}

// If the customer's subscription has expired it will
// not be possible for them to restart it. Instead
// we create a new one for them.
function recreateStripeSubscription (req, res, next) {
  stripe.customers.update(
    req.user.subscription.customer,
    {
      card: req.body.stripeToken
    },
    function (err) {
      if (err) return next(err);

      stripe.customers.createSubscription(
        req.user.subscription.customer,
        {
          plan: req.user.subscription.plan.id,
          quantity: req.user.subscription.quantity || 1
        },
        function (err, subscription) {
          if (err || !subscription) {
            return next(err || new Error("No subscription"));
          }

          User.set(req.user.uid, { subscription: subscription }, next);
        }
      );
    }
  );
}

// If I created a blog for the customer manually they will
// not have a stripe subscription. In order to create new
// blogs they will need one.
function createStripeSubscription (req, res, next) {
  stripe.customers.create(
    {
      card: req.body.stripeToken,
      email: req.user.email,
      plan: config.stripe.plan,
      quantity: req.user.blogs.length,
      description: "Blot subscription"
    },
    function (err, customer) {
      if (err) return next(err);

      User.set(req.user.uid, { subscription: customer.subscription }, next);
    }
  );
}

function retrieveSubscription (req, res, next) {
  if (!req.user.subscription.customer) return next();

  stripe.customers.retrieveSubscription(
    req.user.subscription.customer,
    req.user.subscription.id,
    function (err, subscription) {
      if (err && err.code === "resource_missing") {
        return res.redirect("/account/subscription/restart/pay");
      }

      if (err) return next(err);

      if (!subscription) return next(new Error("No subscription"));

      User.set(req.user.uid, { subscription: subscription }, function (err) {
        if (err) return next(err);

        next();
      });
    }
  );
}

function restartStripeSubscription (req, res, next) {
  if (!req.user.subscription.customer) return next();
  stripe.customers.updateSubscription(
    req.user.subscription.customer,
    req.user.subscription.id,
    {},
    function (err, subscription) {
      if (err) {
        return next(err);
      }

      if (!subscription) {
        return next(new Error("No subscription"));
      }

      User.set(req.user.uid, { subscription: subscription }, next);
    }
  );
}

module.exports = Subscription;
