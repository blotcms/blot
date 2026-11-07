var config = require("config");
var stripe = require("stripe")(config.stripe.secret);
var User = require("models/user");
var prettyPrice = require("helper/prettyPrice");
var email = require("helper/email");
var Express = require("express");
var PaySubscription = new Express.Router();

PaySubscription.route("/")

  // First, make sure the customer has a subscription
  // through Stripe, then fetch its latest state. We
  // typically recieve the latest version of a subscription
  // through Stripe's webhooks – this is just a double-check.
  .all(checkCustomer)
  .all(updateSubscription)

  // We want to tell the user how much they will have to pay to
  // re-open their account, so work that out before rendering
  // the payment form on the dashboard.
  .get(listUnpaidInvoices)
  .get(function (req, res) {
    res.render("dashboard/account/pay-subscription", {
      stripe_key: config.stripe.key,
      title: "Restart subscription",
    });
  })

  // The user must submit a valid card to restart their account
  // Then we list all outstanding invoices and pay them.
  .post(updateCard)
  .post(payUnpaidInvoices)
  .post(updateSubscription)
  .post(function (req, res) {
    res.message("/sites", "Payment recieved, thank you!");
  });

function checkCustomer(req, res, next) {
  req.customer = req.user.subscription && req.user.subscription.customer;
  req.subscription = req.user.subscription && req.user.subscription.id;

  if (!req.customer) {
    return res.message("/sites", "You are not a customer!");
  }

  if (!req.subscription) {
    return res.message("/sites", "You need to have a subscription!");
  }

  next();
}

async function listUnpaidInvoices(req, res, next) {
  try {
    const invoices = await stripe.invoices.list({ customer: req.customer });

    res.locals.amountDue = 0;

    invoices.data.forEach(function (invoice) {
      if (invoice.paid === false) res.locals.amountDue += invoice.amount_due;
    });

    if (!res.locals.amountDue) {
      return res.message(
        "/sites",
        "Thank you, your account is in good standing!"
      );
    }

    res.locals.amountDue = prettyPrice(res.locals.amountDue);
  } catch (err) {
    return next(err);
  }

  next();
}

function formatStripeError(err, fallbackMessage) {
  if (!err) return err;

  var message =
    (err.raw && err.raw.message) ||
    err.message ||
    fallbackMessage ||
    "Stripe error";

  var declineCode =
    (err.raw && err.raw.decline_code) || err.decline_code || err.code;

  if (
    err.type === "StripeCardError" ||
    err.type === "card_error" ||
    declineCode === "card_declined"
  ) {
    message = "Stripe declined your payment method: " + message;
  }

  var formattedError = new Error(message);
  formattedError.cause = err;

  return formattedError;
}

function storeCustomerOnRequest(req, customer) {
  req.updatedCustomer = customer;
  req.defaultPaymentMethod =
    customer &&
    customer.invoice_settings &&
    customer.invoice_settings.default_payment_method;
  req.defaultSource = customer && customer.default_source;
}

async function updateCard(req, res, next) {
  try {
    var stripeToken = req.body.stripeToken;

    if (!stripeToken) return next(new Error("No card token passed"));

    let customer;

    // Handle modern payment methods (pm_...) separately
    if (stripeToken.indexOf("pm_") === 0) {
      if (!stripe.paymentMethods || !stripe.paymentMethods.attach) {
        return next(
          new Error("Stripe payment methods are not supported on this server.")
        );
      }

      try {
        await stripe.paymentMethods.attach(stripeToken, {
          customer: req.customer,
        });
      } catch (err) {
        return next(
          formatStripeError(err, "Unable to attach your payment method.")
        );
      }

      customer = await stripe.customers.update(req.customer, {
        invoice_settings: { default_payment_method: stripeToken },
      });
    } else {
      customer = await stripe.customers.update(req.customer, {
        card: stripeToken,
      });
    }

    storeCustomerOnRequest(req, customer);
  } catch (err) {
    return next(
      formatStripeError(err, "Unable to update your payment method.")
    );
  }

  next();
}

async function payUnpaidInvoices(req, res, next) {
  try {
    const invoices = await stripe.invoices.list({ customer: req.customer });

    for (const invoice of invoices.data) {
      if (invoice.paid) continue;

      // You can only pay an invoice once
      var options = {};

      if (req.defaultPaymentMethod) {
        options.payment_method = req.defaultPaymentMethod;
      } else if (req.defaultSource) {
        options.source = req.defaultSource;
      }

      try {
        if (Object.keys(options).length) {
          await stripe.invoices.pay(invoice.id, options);
        } else {
          await stripe.invoices.pay(invoice.id);
        }
      } catch (err) {
        return next(
          formatStripeError(err, "Unable to pay outstanding invoices.")
        );
      }
    }
  } catch (err) {
    return next(err);
  }

  next();
}

async function updateSubscription(req, res, next) {
  try {
    const subscription = await stripe.customers.retrieveSubscription(
      req.user.subscription.customer,
      req.user.subscription.id
    );

    if (!subscription) return next(new Error("No subscription"));

    // Store previous subscription status before updating
    var previousSubscription = req.user.subscription || {};
    var previousStatus = previousSubscription.status;

    await User.set(req.user.uid, { subscription: subscription });

    // Send recovery email if subscription was recovered
    if (
      subscription.status === "active" &&
      (previousStatus === "past_due" || previousStatus === "unpaid")
    ) {
      email.RECOVERED(req.user.uid);
    }
  } catch (err) {
    return next(err);
  }

  next();
}

module.exports = PaySubscription;
