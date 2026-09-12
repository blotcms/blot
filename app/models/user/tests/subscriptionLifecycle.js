var subscriptionLifecycle = require("../subscriptionLifecycle");

describe("subscriptionLifecycle", function () {
  var ONE_MONTH_MS = subscriptionLifecycle.ONE_MONTH_MS;
  var now = Date.now();

  describe("toMs", function () {
    it("returns null for null input", function () {
      expect(subscriptionLifecycle.toMs(null)).toBeNull();
    });

    it("returns null for undefined input", function () {
      expect(subscriptionLifecycle.toMs(undefined)).toBeNull();
    });

    it("converts Date object to milliseconds", function () {
      var date = new Date(now);
      expect(subscriptionLifecycle.toMs(date)).toEqual(now);
    });

    it("converts Unix seconds to milliseconds", function () {
      var seconds = Math.floor(now / 1000);
      expect(subscriptionLifecycle.toMs(seconds)).toEqual(seconds * 1000);
    });

    it("keeps milliseconds as-is when already in ms range", function () {
      expect(subscriptionLifecycle.toMs(now)).toEqual(now);
    });

    it("parses ISO 8601 date strings", function () {
      var date = new Date(now);
      var isoString = date.toISOString();
      expect(subscriptionLifecycle.toMs(isoString)).toEqual(date.getTime());
    });

    it("returns null for invalid strings", function () {
      expect(subscriptionLifecycle.toMs("invalid")).toBeNull();
    });

    it("returns null for NaN", function () {
      expect(subscriptionLifecycle.toMs(NaN)).toBeNull();
    });

    it("returns null for Infinity", function () {
      expect(subscriptionLifecycle.toMs(Infinity)).toBeNull();
    });
  });

  describe("stripePeriodEndAtMs", function () {
    it("returns null for null subscription", function () {
      expect(subscriptionLifecycle.stripePeriodEndAtMs(null)).toBeNull();
    });

    it("returns period end in milliseconds", function () {
      var periodEnd = Math.floor(now / 1000) + 86400;
      var subscription = { current_period_end: periodEnd };
      expect(subscriptionLifecycle.stripePeriodEndAtMs(subscription)).toEqual(periodEnd * 1000);
    });

    it("returns null when current_period_end is missing", function () {
      var subscription = {};
      expect(subscriptionLifecycle.stripePeriodEndAtMs(subscription)).toBeNull();
    });
  });

  describe("paypalPeriodEndAtMs", function () {
    it("returns null for null paypal", function () {
      expect(subscriptionLifecycle.paypalPeriodEndAtMs(null)).toBeNull();
    });

    it("returns next_billing_time when available", function () {
      var nextBilling = new Date(now + 86400000).toISOString();
      var paypal = {
        billing_info: { next_billing_time: nextBilling }
      };
      expect(subscriptionLifecycle.paypalPeriodEndAtMs(paypal)).toEqual(new Date(nextBilling).getTime());
    });

    it("falls back to status_update_time when no billing info", function () {
      var statusTime = new Date(now).toISOString();
      var paypal = { status_update_time: statusTime };
      expect(subscriptionLifecycle.paypalPeriodEndAtMs(paypal)).toEqual(new Date(statusTime).getTime());
    });
  });

  describe("shouldDisableFromStripeSubscription", function () {
    it("returns false for null subscription", function () {
      expect(subscriptionLifecycle.shouldDisableFromStripeSubscription(null)).toBe(false);
    });

    it("returns true for canceled status", function () {
      var subscription = { status: "canceled" };
      expect(subscriptionLifecycle.shouldDisableFromStripeSubscription(subscription)).toBe(true);
    });

    it("returns false for active subscription", function () {
      var subscription = { status: "active" };
      expect(subscriptionLifecycle.shouldDisableFromStripeSubscription(subscription)).toBe(false);
    });

    it("returns true when cancel_at_period_end and period has ended", function () {
      var periodEnd = Math.floor((now - 86400000) / 1000);
      var subscription = {
        status: "active",
        cancel_at_period_end: true,
        current_period_end: periodEnd
      };
      expect(subscriptionLifecycle.shouldDisableFromStripeSubscription(subscription, now)).toBe(true);
    });

    it("returns false when cancel_at_period_end but period has not ended", function () {
      var periodEnd = Math.floor((now + 86400000) / 1000);
      var subscription = {
        status: "active",
        cancel_at_period_end: true,
        current_period_end: periodEnd
      };
      expect(subscriptionLifecycle.shouldDisableFromStripeSubscription(subscription, now)).toBe(false);
    });
  });

  describe("shouldDisableFromPaypalSubscription", function () {
    it("returns false for null paypal", function () {
      expect(subscriptionLifecycle.shouldDisableFromPaypalSubscription(null)).toBe(false);
    });

    it("returns false for paypal without status", function () {
      expect(subscriptionLifecycle.shouldDisableFromPaypalSubscription({})).toBe(false);
    });

    it("returns true for EXPIRED status", function () {
      var paypal = { status: "EXPIRED" };
      expect(subscriptionLifecycle.shouldDisableFromPaypalSubscription(paypal)).toBe(true);
    });

    it("returns true for SUSPENDED status", function () {
      var paypal = { status: "SUSPENDED" };
      expect(subscriptionLifecycle.shouldDisableFromPaypalSubscription(paypal)).toBe(true);
    });

    it("returns false for ACTIVE status", function () {
      var paypal = { status: "ACTIVE" };
      expect(subscriptionLifecycle.shouldDisableFromPaypalSubscription(paypal)).toBe(false);
    });

    it("returns true for CANCELLED when period has ended", function () {
      var paypal = {
        status: "CANCELLED",
        status_update_time: new Date(now - 86400000).toISOString()
      };
      expect(subscriptionLifecycle.shouldDisableFromPaypalSubscription(paypal, now)).toBe(true);
    });

    it("handles lowercase status", function () {
      var paypal = { status: "expired" };
      expect(subscriptionLifecycle.shouldDisableFromPaypalSubscription(paypal)).toBe(true);
    });
  });

  describe("cancellationDetails", function () {
    it("returns not cancelled for active Stripe subscription", function () {
      var user = {
        subscription: { status: "active", current_period_end: Math.floor((now + 86400000) / 1000) }
      };
      var details = subscriptionLifecycle.cancellationDetails(user, now);
      expect(details.cancelled).toBe(false);
      expect(details.provider).toBeNull();
    });

    it("returns not cancelled for ACTIVE PayPal subscription", function () {
      var user = {
        subscription: {},
        paypal: { status: "ACTIVE" }
      };
      var details = subscriptionLifecycle.cancellationDetails(user, now);
      expect(details.cancelled).toBe(false);
    });

    it("returns cancelled for canceled Stripe subscription", function () {
      var user = {
        subscription: { status: "canceled", current_period_end: Math.floor((now - 86400000) / 1000) }
      };
      var details = subscriptionLifecycle.cancellationDetails(user, now);
      expect(details.cancelled).toBe(true);
      expect(details.provider).toEqual("stripe");
      expect(details.periodEnded).toBe(true);
    });

    it("returns cancelled for CANCELLED PayPal subscription", function () {
      var user = {
        subscription: {},
        paypal: { status: "CANCELLED", status_update_time: new Date(now - 86400000).toISOString() }
      };
      var details = subscriptionLifecycle.cancellationDetails(user, now);
      expect(details.cancelled).toBe(true);
      expect(details.provider).toEqual("paypal");
    });

    it("handles trialing status as active", function () {
      var user = {
        subscription: { status: "trialing", current_period_end: Math.floor((now + 86400000) / 1000) }
      };
      var details = subscriptionLifecycle.cancellationDetails(user, now);
      expect(details.cancelled).toBe(false);
    });
  });

  describe("deletionDue", function () {
    it("returns false for active subscription", function () {
      var user = {
        subscription: { status: "active", current_period_end: Math.floor((now + 86400000) / 1000) }
      };
      expect(subscriptionLifecycle.deletionDue(user, now)).toBe(false);
    });

    it("returns false for recently cancelled subscription", function () {
      var periodEnd = now - (ONE_MONTH_MS / 2);
      var user = {
        subscription: { status: "canceled", current_period_end: Math.floor(periodEnd / 1000) }
      };
      expect(subscriptionLifecycle.deletionDue(user, now)).toBe(false);
    });

    it("returns true when grace period has passed", function () {
      var periodEnd = now - (ONE_MONTH_MS * 2);
      var user = {
        subscription: { status: "canceled", current_period_end: Math.floor(periodEnd / 1000) }
      };
      expect(subscriptionLifecycle.deletionDue(user, now)).toBe(true);
    });

    it("respects custom grace period", function () {
      var periodEnd = now - 86400000;
      var user = {
        subscription: { status: "canceled", current_period_end: Math.floor(periodEnd / 1000) }
      };
      expect(subscriptionLifecycle.deletionDue(user, now, 86400000)).toBe(true);
      expect(subscriptionLifecycle.deletionDue(user, now, 86400000 * 2)).toBe(false);
    });
  });

  describe("overdueDetails", function () {
    it("returns not overdue for null subscription", function () {
      var user = { subscription: null };
      var details = subscriptionLifecycle.overdueDetails(user, now);
      expect(details.overdue).toBe(false);
    });

    it("returns not overdue for active subscription", function () {
      var user = { subscription: { status: "active" } };
      var details = subscriptionLifecycle.overdueDetails(user, now);
      expect(details.overdue).toBe(false);
    });

    it("returns overdue with grace_active phase for recent past_due", function () {
      var periodEnd = now - 86400000;
      var user = {
        subscription: { status: "past_due", current_period_end: Math.floor(periodEnd / 1000) }
      };
      var details = subscriptionLifecycle.overdueDetails(user, now);
      expect(details.overdue).toBe(true);
      expect(details.phase).toEqual("grace_active");
    });

    it("returns overdue with disabled_grace phase after one month", function () {
      var periodEnd = now - ONE_MONTH_MS - 86400000;
      var user = {
        subscription: { status: "past_due", current_period_end: Math.floor(periodEnd / 1000) }
      };
      var details = subscriptionLifecycle.overdueDetails(user, now);
      expect(details.overdue).toBe(true);
      expect(details.phase).toEqual("disabled_grace");
    });

    it("returns overdue with deletion_flow phase after two months", function () {
      var periodEnd = now - (ONE_MONTH_MS * 2) - 86400000;
      var user = {
        subscription: { status: "unpaid", current_period_end: Math.floor(periodEnd / 1000) }
      };
      var details = subscriptionLifecycle.overdueDetails(user, now);
      expect(details.overdue).toBe(true);
      expect(details.phase).toEqual("deletion_flow");
    });

    it("returns not overdue when period end is in the future", function () {
      var periodEnd = now + 86400000;
      var user = {
        subscription: { status: "past_due", current_period_end: Math.floor(periodEnd / 1000) }
      };
      var details = subscriptionLifecycle.overdueDetails(user, now);
      expect(details.overdue).toBe(false);
    });
  });
});
