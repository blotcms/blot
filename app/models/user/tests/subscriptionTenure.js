var subscriptionTenure = require("../subscriptionTenure");

describe("subscriptionTenure", function () {
  var now = Date.now();

  describe("stripeTenureStartMs", function () {
    it("returns null for null user", function () {
      expect(subscriptionTenure.stripeTenureStartMs(null)).toBeNull();
    });

    it("returns null for user without subscription", function () {
      expect(subscriptionTenure.stripeTenureStartMs({})).toBeNull();
    });

    it("returns null for subscription without customer", function () {
      var user = { subscription: { created: now } };
      expect(subscriptionTenure.stripeTenureStartMs(user)).toBeNull();
    });

    it("returns created timestamp when available", function () {
      var created = Math.floor((now - 86400000) / 1000);
      var user = { subscription: { customer: "cus_123", created: created } };
      expect(subscriptionTenure.stripeTenureStartMs(user)).toEqual(created * 1000);
    });

    it("falls back to current_period_start when created is missing", function () {
      var periodStart = Math.floor((now - 86400000) / 1000);
      var user = { subscription: { customer: "cus_123", current_period_start: periodStart } };
      expect(subscriptionTenure.stripeTenureStartMs(user)).toEqual(periodStart * 1000);
    });

    it("prefers created over current_period_start", function () {
      var created = Math.floor((now - 172800000) / 1000);
      var periodStart = Math.floor((now - 86400000) / 1000);
      var user = {
        subscription: {
          customer: "cus_123",
          created: created,
          current_period_start: periodStart
        }
      };
      expect(subscriptionTenure.stripeTenureStartMs(user)).toEqual(created * 1000);
    });
  });

  describe("paypalTenureStartMs", function () {
    it("returns null for null user", function () {
      expect(subscriptionTenure.paypalTenureStartMs(null)).toBeNull();
    });

    it("returns null for user without paypal", function () {
      expect(subscriptionTenure.paypalTenureStartMs({})).toBeNull();
    });

    it("returns null for paypal without id", function () {
      var user = { paypal: { start_time: new Date(now - 86400000).toISOString() } };
      expect(subscriptionTenure.paypalTenureStartMs(user)).toBeNull();
    });

    it("returns start_time in milliseconds", function () {
      var startTime = new Date(now - 86400000);
      var user = { paypal: { id: "I-TEST123", start_time: startTime.toISOString() } };
      expect(subscriptionTenure.paypalTenureStartMs(user)).toEqual(startTime.getTime());
    });
  });

  describe("getSubscriptionDurationMs", function () {
    it("returns null for user without subscription", function () {
      expect(subscriptionTenure.getSubscriptionDurationMs({})).toBeNull();
    });

    it("returns null for user with empty subscription and paypal", function () {
      var user = { subscription: {}, paypal: {} };
      expect(subscriptionTenure.getSubscriptionDurationMs(user)).toBeNull();
    });

    it("calculates duration from Stripe subscription", function () {
      var created = Math.floor((now - 86400000) / 1000);
      var user = { subscription: { customer: "cus_123", created: created } };
      var duration = subscriptionTenure.getSubscriptionDurationMs(user, now);
      expect(duration).toBeGreaterThan(86000000);
      expect(duration).toBeLessThanOrEqual(86400000 + 1000);
    });

    it("calculates duration from PayPal subscription", function () {
      var startTime = new Date(now - 172800000);
      var user = { paypal: { id: "I-TEST123", start_time: startTime.toISOString() } };
      var duration = subscriptionTenure.getSubscriptionDurationMs(user, now);
      expect(duration).toBeGreaterThan(172000000);
      expect(duration).toBeLessThanOrEqual(172800000 + 1000);
    });

    it("uses earliest start when both Stripe and PayPal exist", function () {
      var stripeCreated = Math.floor((now - 86400000) / 1000);
      var paypalStart = new Date(now - 172800000);
      var user = {
        subscription: { customer: "cus_123", created: stripeCreated },
        paypal: { id: "I-TEST123", start_time: paypalStart.toISOString() }
      };
      var duration = subscriptionTenure.getSubscriptionDurationMs(user, now);
      expect(duration).toBeGreaterThan(172000000);
    });

    it("returns null when start time is in the future", function () {
      var futureCreated = Math.floor((now + 86400000) / 1000);
      var user = { subscription: { customer: "cus_123", created: futureCreated } };
      expect(subscriptionTenure.getSubscriptionDurationMs(user, now)).toBeNull();
    });

    it("uses current time when now parameter is not provided", function () {
      var created = Math.floor((Date.now() - 86400000) / 1000);
      var user = { subscription: { customer: "cus_123", created: created } };
      var duration = subscriptionTenure.getSubscriptionDurationMs(user);
      expect(duration).toBeGreaterThan(86000000);
    });

    it("ignores invalid start times", function () {
      var validStart = new Date(now - 86400000);
      var user = {
        subscription: { customer: "cus_123", created: "invalid" },
        paypal: { id: "I-TEST123", start_time: validStart.toISOString() }
      };
      var duration = subscriptionTenure.getSubscriptionDurationMs(user, now);
      expect(duration).toBeGreaterThan(86000000);
    });
  });
});
