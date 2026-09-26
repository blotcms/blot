var config = require("config");
var async = require("async");
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

function listUnpaidInvoices(req, res, next) {
  stripe.invoices.list({ customer: req.customer }, function (err, invoices) {
    if (err) return next(err);

    res.locals.amountDue = 0;

    invoices.data.forEach(function (invoice) {
      if (invoice.paid === false) res.locals.amountDue += invoice.amount_due;
    });

    if (!res.locals.amountDue) {
      return res.message("/sites", "Thank you, your account is in good standing!");
    }

    res.locals.amountDue = prettyPrice(res.locals.amountDue);

    next();
  });
}

function formatStripeError(err, fallbackMessage) {
  if (!err) return err;

  var message =
    (err.raw && err.raw.message) || err.message || fallbackMessage || "Stripe error";

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

function updateCard(req, res, next) {
  var stripeToken = req.body.stripeToken;

  if (!stripeToken) return next(new Error("No card token passed"));

  function handleCustomerUpdate(err, customer) {
    if (err)
      return next(
        formatStripeError(err, "Unable to update your payment method.")
      );

    storeCustomerOnRequest(req, customer);

    next();
  }

  // Handle modern payment methods (pm_...) separately
  if (stripeToken.indexOf("pm_") === 0) {
    if (!stripe.paymentMethods || !stripe.paymentMethods.attach) {
      return next(
        new Error("Stripe payment methods are not supported on this server.")
      );
    }

    stripe.paymentMethods.attach(
      stripeToken,
      { customer: req.customer },
      function (err) {
        if (err)
          return next(
            formatStripeError(err, "Unable to attach your payment method.")
          );

        stripe.customers.update(
          req.customer,
          {
            invoice_settings: { default_payment_method: stripeToken },
          },
          handleCustomerUpdate
        );
      }
    );

    return;
  }

  stripe.customers.update(
    req.customer,
    { card: stripeToken },
    handleCustomerUpdate
  );
}

function payUnpaidInvoices(req, res, next) {
  stripe.invoices.list({ customer: req.customer }, function (err, invoices) {
    if (err) return next(err);

    async.eachSeries(
      invoices.data,
      function (invoice, nextInvoice) {
        if (invoice.paid) return nextInvoice();

        // You can only pay an invoice once
        var options = {};

        if (req.defaultPaymentMethod) {
          options.payment_method = req.defaultPaymentMethod;
        } else if (req.defaultSource) {
          options.source = req.defaultSource;
        }

        if (Object.keys(options).length) {
          stripe.invoices.pay(invoice.id, options, function (err) {
            nextInvoice(
              formatStripeError(err, "Unable to pay outstanding invoices.")
            );
          });
        } else {
          stripe.invoices.pay(invoice.id, function (err) {
            nextInvoice(
              formatStripeError(err, "Unable to pay outstanding invoices.")
            );
          });
        }
      },
      next
    );
  });
}

function updateSubscription(req, res, next) {
  stripe.customers.retrieveSubscription(
    req.user.subscription.customer,
    req.user.subscription.id,
    function (err, subscription) {
      if (err) return next(err);

      if (!subscription) return next(new Error("No subscription"));

      // Store previous subscription status before updating
      var previousSubscription = req.user.subscription || {};
      var previousStatus = previousSubscription.status;

      User.set(req.user.uid, { subscription: subscription }, function (err) {
        if (err) return next(err);

        // Send recovery email if subscription was recovered
        if (
          subscription.status === "active" &&
          (previousStatus === "past_due" || previousStatus === "unpaid")
        ) {
          email.RECOVERED(req.user.uid);
        }

        next();
      });
    }
  );
}

module.exports = PaySubscription;
