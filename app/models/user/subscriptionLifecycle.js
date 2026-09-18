var config = require("config");

var ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function toMs(value) {
  if (!value) return null;

  if (value instanceof Date) return value.getTime();

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return value < 1e12 ? value * 1000 : value;
  }

  if (typeof value === "string") {
    var parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function resolvePaypalIntervalMs(paypal) {
  if (!paypal || !paypal.plan_id) return null;

  var plans = (config.paypal && config.paypal.plans) || {};

  var planIdentifier = Object.keys(plans).find(function (id) {
    return plans[id] === paypal.plan_id;
  });

  if (!planIdentifier) return null;

  if (planIdentifier.indexOf("monthly") !== -1) return ONE_MONTH_MS;
  if (planIdentifier.indexOf("yearly") !== -1) return 365 * 24 * 60 * 60 * 1000;

  return null;
}

function stripePeriodEndAtMs(subscription) {
  if (!subscription) return null;
  return toMs(subscription.current_period_end);
}

function paypalPeriodEndAtMs(paypal) {
  if (!paypal) return null;

  var nextBilling = toMs(paypal.billing_info && paypal.billing_info.next_billing_time);
  if (nextBilling) return nextBilling;

  var lastPayment = toMs(
    paypal.billing_info &&
      paypal.billing_info.last_payment &&
      paypal.billing_info.last_payment.time
  );

  var intervalMs = resolvePaypalIntervalMs(paypal);
  if (lastPayment && intervalMs) return lastPayment + intervalMs;

  return toMs(paypal.status_update_time);
}

function shouldDisableFromStripeSubscription(subscription, now) {
  now = now || Date.now();

  if (!subscription) return false;

  if (subscription.status === "canceled") return true;

  if (subscription.cancel_at_period_end) {
    var periodEnd = stripePeriodEndAtMs(subscription);
    return Boolean(periodEnd && periodEnd <= now);
  }

  return false;
}

function shouldDisableFromPaypalSubscription(paypal, now) {
  now = now || Date.now();

  if (!paypal || !paypal.status) return false;

  var status = paypal.status.toUpperCase();
  if (status === "EXPIRED" || status === "SUSPENDED") return true;

  if (status !== "CANCELLED") return false;

  var periodEnd = paypalPeriodEndAtMs(paypal);
  return Boolean(periodEnd && periodEnd <= now);
}

function cancellationDetails(user, now) {
  now = now || Date.now();

  var stripe = user && user.subscription;
  var paypal = user && user.paypal;

  var stripePeriodEnd = stripePeriodEndAtMs(stripe);
  var stripeStatus = stripe && stripe.status;
  var stripeIsActiveStatus =
    stripeStatus === "active" || stripeStatus === "trialing";
  var stripeActive =
    Boolean(stripe && stripeIsActiveStatus) &&
    (!stripePeriodEnd || stripePeriodEnd > now);

  var paypalStatus = paypal && paypal.status && paypal.status.toUpperCase();
  var paypalActive = paypalStatus === "ACTIVE";

  if (stripeActive || paypalActive) {
    return {
      cancelled: false,
      provider: null,
      periodEndedAt: null,
      periodEnded: false,
    };
  }

  var cancellationCandidates = [];

  if (stripe) {
    var stripeCancelled =
      stripe.status === "canceled" || stripe.cancel_at_period_end;

    if (stripeCancelled) {
      cancellationCandidates.push({
        cancelled: true,
        provider: "stripe",
        periodEndedAt: stripePeriodEnd,
        periodEnded: Boolean(stripePeriodEnd && stripePeriodEnd <= now),
      });
    }
  }

  if (paypalStatus) {
    var paypalPeriodEnd = paypalPeriodEndAtMs(paypal);
    var cancelled =
      paypalStatus === "CANCELLED" ||
      paypalStatus === "EXPIRED" ||
      paypalStatus === "SUSPENDED";

    if (cancelled) {
      cancellationCandidates.push({
        cancelled: true,
        provider: "paypal",
        periodEndedAt: paypalPeriodEnd,
        periodEnded: Boolean(paypalPeriodEnd && paypalPeriodEnd <= now),
      });
    }
  }

  if (cancellationCandidates.length) {
    cancellationCandidates.sort(function (a, b) {
      if (a.periodEndedAt && b.periodEndedAt) return b.periodEndedAt - a.periodEndedAt;
      if (a.periodEndedAt) return -1;
      if (b.periodEndedAt) return 1;
      return 0;
    });

    return cancellationCandidates[0];
  }

  return {
    cancelled: false,
    provider: null,
    periodEndedAt: null,
    periodEnded: false,
  };
}

function deletionDue(user, now, graceMs) {
  now = now || Date.now();
  graceMs = typeof graceMs === "number" ? graceMs : ONE_MONTH_MS;

  var details = cancellationDetails(user, now);
  if (!details.cancelled || !details.periodEndedAt) return false;

  return details.periodEndedAt + graceMs <= now;
}

// startedAtMs optionally overrides when the subscription went overdue. Stripe
// rolls current_period_end forward on unpaid subscriptions, so for those the
// caller should pass the date from models/user/overdueSince instead.
function overdueDetails(user, now, startedAtMs) {
  now = now || Date.now();

  var stripe = user && user.subscription;

  if (!stripe) {
    return {
      overdue: false,
      startedAt: null,
      phase: null,
    };
  }

  var status = stripe.status;
  if (status !== "past_due" && status !== "unpaid") {
    return {
      overdue: false,
      startedAt: null,
      phase: null,
    };
  }

  var startedAt = startedAtMs || stripePeriodEndAtMs(stripe);
  if (!startedAt) {
    return {
      overdue: false,
      startedAt: null,
      phase: null,
    };
  }

  if (startedAt > now) {
    return {
      overdue: false,
      startedAt: null,
      phase: null,
    };
  }

  var elapsed = now - startedAt;
  var phase = "grace_active";

  if (elapsed >= 2 * ONE_MONTH_MS) phase = "deletion_flow";
  else if (elapsed >= ONE_MONTH_MS) phase = "disabled_grace";

  return {
    overdue: true,
    startedAt: startedAt,
    phase: phase,
  };
}

module.exports = {
  ONE_MONTH_MS: ONE_MONTH_MS,
  cancellationDetails: cancellationDetails,
  deletionDue: deletionDue,
  overdueDetails: overdueDetails,
  paypalPeriodEndAtMs: paypalPeriodEndAtMs,
  shouldDisableFromPaypalSubscription: shouldDisableFromPaypalSubscription,
  shouldDisableFromStripeSubscription: shouldDisableFromStripeSubscription,
  stripePeriodEndAtMs: stripePeriodEndAtMs,
  toMs: toMs,
};
