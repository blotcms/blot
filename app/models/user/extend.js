var amountInWords = require("helper/amountInWords");
var prettyDate = require("helper/prettyDate");
var prettyPrice = require("helper/prettyPrice");
var config = require("config");
var subscriptionLifecycle = require("./subscriptionLifecycle");
var markPaymentMethodExpiry = require("./paymentMethodExpiry");

module.exports = function extend (user) {
  // True if the user has set a password, false otherwise
  user.hasPassword = !!user.passwordHash;

  // Don't expose these to the
  // view renderer
  delete user.credentials;
  delete user.passwordHash;
  delete user.created;
  delete user.welcomeEmailSent;

  user.pretty = {};

  var subscription = user.subscription;

  if (subscription) {
    if (subscription.plan) {
      user.totalFee = subscription.plan.amount * subscription.quantity;
      user.pretty.amount = subscription.quantity;
      user.pretty.s = subscription.quantity === 1 ? "" : "s";
      user.pretty.amount_in_words = amountInWords(subscription.quantity);
      user.pretty.interval = subscription.plan.interval;
      user.pretty.expiry = prettyDate(subscription.current_period_end * 1000);
      user.pretty.price = prettyPrice(
        subscription.plan.amount * subscription.quantity
      );
      user.isMonthly = subscription.plan.interval === "month";
    }

    if (subscription.cancel_at_period_end) user.cancel_at_period_end = true;

    if (
      (!subscription.cancel_at_period_end &&
        subscription.status === "active") ||
      subscription.status === "trialing"
    )
      user.isSubscribed = true;

    if (subscription.cancel_at_period_end) user.willCancel = true;

    if (!subscription.customer && !user.paypal.status)
      user.isFreeForLife = true;

    if (subscription.status === "unpaid") user.isUnpaid = true;

    if (subscription.status === "past_due") user.isPastDue = true;

    if (
      subscriptionLifecycle.shouldDisableFromStripeSubscription(subscription)
    )
      user.isDisabled = true;

    if (user.isUnpaid || user.isPastDue) user.needsToPay = true;
  }

  if (user.paypal && user.paypal.status) {
    if (user.paypal.status === "ACTIVE") user.isSubscribed = true;

    if (user.paypal.status === "CANCELLED") user.willCancel = true;

    if (
      subscriptionLifecycle.shouldDisableFromPaypalSubscription(user.paypal)
    )
      user.isDisabled = true;

    const plan_identifier = Object.keys(config.paypal.plans).find(
      identifier => config.paypal.plans[identifier] === user.paypal.plan_id
    );

    const amount = parseInt(plan_identifier.split("_")[1]) * 100;

    const quantity = parseInt(user.paypal.quantity);

    user.isMonthly = plan_identifier.includes("monthly");
    user.totalFee = amount * quantity;
    user.pretty.interval = user.isMonthly ? "month" : "year";
    user.pretty.amount = quantity;
    user.pretty.s = quantity === 1 ? "" : "s";
    user.pretty.amount_in_words = amountInWords(quantity);

    // if the user has cancelled their subscription, next_billing_time will be null
    user.pretty.expiry = user.paypal.billing_info.next_billing_time
      ? prettyDate(
          new Date(user.paypal.billing_info.next_billing_time).getTime()
        )
      : prettyDate(
          new Date(user.paypal.billing_info.last_payment.time).getTime() +
            (plan_identifier.includes("monthly")
              ? 30 * 24 * 60 * 60 * 1000
              : 365 * 24 * 60 * 60 * 1000)
        );

    user.pretty.price = prettyPrice(amount * quantity);
  }

  // Whether to show a "manage payment methods" link at all: true for any
  // Stripe subscriber (the page manages their cards) and any PayPal
  // subscriber (the page instead points them at PayPal), since
  // subscription.status is only ever set for Stripe.
  user.showPaymentMethodsLink = Boolean(
    (subscription && subscription.status) || (user.paypal && user.paypal.status)
  );

  if (user.paymentMethods && user.paymentMethods.length) {
    markPaymentMethodExpiry(user.paymentMethods);

    user.paymentMethods.forEach(function (paymentMethod) {
      if (paymentMethod.isExpired) user.hasExpiredPaymentMethod = true;
      if (paymentMethod.isExpiringSoon) user.hasExpiringSoonPaymentMethod = true;
    });
  }

  if (user.blogs.length !== 1) {
    user.multipleBlogs = true;
    user.s = "s"; // used like this: you run blog{{s}} on blot...
    user.are = "are";
  } else {
    user.multipleBlogs = false;
    user.s = "";
    user.are = "is";
  }

  return user;
};
