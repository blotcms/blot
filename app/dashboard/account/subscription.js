var Express = require("express");
var Subscription = new Express.Router();
var User = require("models/user");
var User = require("models/user");
var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var email = require("helper/email");
var prettyPrice = require("helper/prettyPrice");
const PLAN_MAP = config.stripe.plan_map;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

Subscription.route("/").get(function (req, res) {
  res.render("dashboard/account/subscription", {
    title: "Your account",
    monthly: req.user.isMonthly
  });
});

Subscription.use("/delete", require("./delete"));

// The purpose of this page is to allow the user to update the
// card used by Stripe to charge their subscription fee
Subscription.route("/payment-method")

  .all(function (req, res, next) {
    // User does not have a payment method on file, so redirect them
    if (!req.user || !req.user.subscription || !req.user.subscription.plan)
      return res.redirect(req.baseUrl);

    return next();
  })

  .get(function (req, res) {
    res.render("dashboard/account/payment-method", {
      stripe_key: config.stripe.key,
      breadcrumb: "Edit payment method",
      title: "Edit payment information"
    });
  })

  .post(function (req, res, next) {
    // Stripe generates a token for a payment method
    // on the client. This token is passed to Blot
    // through the update payment method form. We store
    // this token to authenticate future charges.
    if (!req.body.stripeToken) {
      return next(new Error("No Stripe token"));
    }

    // We now store the new card token against the existing
    // subscription information for this customer
    stripe.customers.updateSubscription(
      req.user.subscription.customer,
      req.user.subscription.id,
      { card: req.body.stripeToken, quantity: req.user.subscription.quantity },
      function (err, subscription) {
        if (err) return next(err);

        if (subscription) req.latestSubscription = subscription;

        next();
      }
    );
  })

  // Sometimes, somehow, a customer is deleted on Stripe
  // but the Blot account exists. Not sure exactly what
  // causes this but it happened. This middleware will
  // create a new subscription and customer, without
  // charging the new payment information and then store
  // it against this blot user.
  .post(function (err, req, res, next) {
    // This is some other error, proceed.
    if (err.code !== "resource_missing") {
      return next(err);
    }

    // Make sure we use the user's old suscription
    // plan, in case Blot's price for new customers
    // has changed since they signed up.
    // Setting the quantity to zero will ensure the
    // customer is not charged right now.
    stripe.customers.create(
      {
        card: req.body.stripeToken,
        email: req.user.email,
        plan: req.user.subscription.plan.id,
        quantity: 0,
        description: "Blot subscription"
      },
      function (err, customer) {
        if (err) return next(err);

        // Now we ensure the new subscription has the correct
        // quantity. We couldn't do this earlier because it
        // would involve incorrectly charging the customer. If
        // we set prorate to false, they won't be charged now.
        stripe.customers.updateSubscription(
          customer.subscription.customer,
          customer.subscription.id,
          { quantity: req.user.blogs.length || 1, prorate: false },
          function (err, subscription) {
            if (err) return next(err);

            if (subscription) req.latestSubscription = subscription;

            next();
          }
        );
      }
    );
  })

  // This middleware will save a valid, updated
  // subscription with the new payment method.
  .post(function (req, res, next) {
    if (!req.latestSubscription) return next(new Error("No subscription"));

    User.set(
      req.user.uid,
      { subscription: req.latestSubscription },
      function (err) {
        if (err) return next(err);

        email.UPDATE_BILLING(req.user.uid);
        res.message(
          req.baseUrl,
          "Your payment information was updated successfully!"
        );
      }
    );
  });
Subscription.route("/cancel")

  .all(requireSubscription)

  .get(function (req, res) {
    res.render("dashboard/account/cancel", {
      title: "Cancel your subscription"
    });
  })

  .post(
    cancelStripeSubscription,
    cancelPaypalSubscription,
    function (req, res) {
      const now = Date.now();
      const stripeCreatedMs = toMs(req.user.subscription?.created);
      const stripePeriodStartMs = toMs(req.user.subscription?.current_period_start);
      const paypalStartMs = toMs(req.user.paypal?.start_time);
      const subscriptionStartMs =
        paypalStartMs ||
        stripeCreatedMs ||
        stripePeriodStartMs;
      const isFirstPeriod = Boolean(
        subscriptionStartMs && now - subscriptionStartMs <= THIRTY_DAYS_MS
      );

      if (isFirstPeriod) {
        email.CANCELLED_FIRST_PERIOD(req.user.uid);
      } else {
        email.CANCELLED(req.user.uid);
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
  // Make sure the user has a subscription
  // otherwise they have nothing to cancel
  if (!req.user.isSubscribed) {
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

const { updateSubscription } = require("dashboard/webhooks/paypal_webhook");

async function cancelPaypalSubscription (req, res, next) {
  // The cancel button is hidden for PayPal subscribers. They must delete their
  // account to end their subscription immediately through the deletion flow.
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

function toMs(timestamp) {
  if (!timestamp) return null;

  if (timestamp instanceof Date) return timestamp.getTime();

  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp)) return null;

    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }

  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);

    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

module.exports = Subscription;
