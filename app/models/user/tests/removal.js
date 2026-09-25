describe("removal", function () {
  var removal = require("../removal");
  var subscriptionLifecycle = require("../subscriptionLifecycle");

  var ONE_MONTH_MS = subscriptionLifecycle.ONE_MONTH_MS;
  var now = Date.now();

  function overdueFor(user, startedAt) {
    return subscriptionLifecycle.overdueDetails(user, now, startedAt);
  }

  describe("removalCandidate", function () {
    it("returns null for an active subscription", function () {
      var user = { subscription: { status: "active" } };
      expect(removal.removalCandidate(user, overdueFor(user))).toBeNull();
    });

    it("returns a cancelled candidate once the grace period has passed", function () {
      var periodEnd = now - ONE_MONTH_MS - 86400000;
      var user = {
        subscription: {
          status: "canceled",
          current_period_end: Math.floor(periodEnd / 1000),
        },
      };
      var candidate = removal.removalCandidate(user, overdueFor(user));
      expect(candidate.reason).toEqual("cancelled");
    });

    it("returns null for a cancelled user still within the grace period", function () {
      var periodEnd = now - 86400000;
      var user = {
        subscription: {
          status: "canceled",
          current_period_end: Math.floor(periodEnd / 1000),
        },
      };
      expect(removal.removalCandidate(user, overdueFor(user))).toBeNull();
    });

    it("returns an overdue candidate in the deletion flow", function () {
      var user = {
        subscription: {
          status: "unpaid",
          current_period_end: Math.floor((now + 86400000 * 20) / 1000),
        },
      };
      var startedAt = now - ONE_MONTH_MS * 2 - 86400000;
      var candidate = removal.removalCandidate(user, overdueFor(user, startedAt));
      expect(candidate.reason).toEqual("overdue");
    });

    it("returns null for an overdue user still in a grace phase", function () {
      var user = {
        subscription: {
          status: "unpaid",
          current_period_end: Math.floor((now + 86400000 * 20) / 1000),
        },
      };
      var startedAt = now - ONE_MONTH_MS - 86400000;
      expect(removal.removalCandidate(user, overdueFor(user, startedAt))).toBeNull();
    });

    it("returns null for a paused subscription even deep in the deletion flow", function () {
      var user = {
        subscription: {
          status: "unpaid",
          current_period_end: Math.floor((now + 86400000 * 20) / 1000),
          pause_collection: { behavior: "void" },
        },
      };
      var startedAt = now - ONE_MONTH_MS * 2 - 86400000;
      expect(removal.removalCandidate(user, overdueFor(user, startedAt))).toBeNull();
    });

    it("returns null for a paused, cancelled subscription past its grace period", function () {
      var periodEnd = now - ONE_MONTH_MS - 86400000;
      var user = {
        subscription: {
          status: "canceled",
          current_period_end: Math.floor(periodEnd / 1000),
          pause_collection: { behavior: "void" },
        },
      };
      expect(removal.removalCandidate(user, overdueFor(user))).toBeNull();
    });
  });

  describe("overdueFor", function () {
    it("reports not overdue for a paused subscription with a stale unpaid status", function (done) {
      var user = {
        subscription: {
          id: "sub_1",
          status: "unpaid",
          current_period_end: Math.floor((now + 86400000 * 20) / 1000),
          pause_collection: { behavior: "void" },
        },
      };

      removal.overdueFor(user, function (err, overdue) {
        expect(err).toBeNull();
        expect(overdue.overdue).toBe(false);
        done();
      });
    });
  });
});
