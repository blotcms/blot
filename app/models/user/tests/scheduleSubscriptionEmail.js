describe("scheduleSubscriptionEmail", function () {
  var email = require("helper/email");
  var client = require("models/client");
  var User = require("models/user");
  var subscriptionEmail = require("models/user/scheduleSubscriptionEmail");

  var DAY = 24 * 60 * 60;
  var now = 1700000000000; // fixed clock, ms
  var nowSeconds = Math.floor(now / 1000);

  // A subscription whose period ends `daysLeft` days from `now`
  function subscription(daysLeft, extra) {
    var periodEnd = nowSeconds + daysLeft * DAY;
    return Object.assign(
      {
        status: "active",
        plan: { interval: "year" },
        created: periodEnd - 200 * DAY,
        current_period_start: periodEnd - 365 * DAY,
        current_period_end: periodEnd,
      },
      extra || {}
    );
  }

  function decide(sub) {
    return subscriptionEmail.decide({ subscription: sub }, now);
  }

  describe("decide", function () {
    it("sends a renewal email for an annual plan inside the window", function () {
      var sub = subscription(5);
      expect(decide(sub)).toEqual({
        name: "UPCOMING_RENEWAL",
        periodEnd: sub.current_period_end,
      });
    });

    it("is due exactly 8 days before the period ends", function () {
      expect(decide(subscription(8)).name).toBe("UPCOMING_RENEWAL");
    });

    it("sends nothing outside the 8 day window", function () {
      expect(decide(subscription(9))).toBe(null);
    });

    it("sends nothing once the period has ended", function () {
      expect(decide(subscription(0))).toBe(null);
      expect(decide(subscription(-1))).toBe(null);
    });

    it("sends an expiry email when the subscription will cancel", function () {
      expect(decide(subscription(5, { cancel_at_period_end: true })).name).toBe(
        "UPCOMING_EXPIRY"
      );
    });

    it("sends nothing for an inactive subscription", function () {
      expect(decide(subscription(5, { status: "canceled" }))).toBe(null);
      expect(decide(subscription(5, { status: "past_due" }))).toBe(null);
    });

    it("sends nothing without a subscription or period end", function () {
      expect(subscriptionEmail.decide({}, now)).toBe(null);
      expect(subscriptionEmail.decide(null, now)).toBe(null);
      expect(decide({ status: "active" })).toBe(null);
    });

    it("sends the first monthly renewal email", function () {
      var periodEnd = nowSeconds + 5 * DAY;
      var sub = subscription(5, {
        plan: { interval: "month" },
        created: periodEnd - 30 * DAY,
        current_period_start: periodEnd - 30 * DAY,
      });
      expect(decide(sub).name).toBe("UPCOMING_MONTHLY_FIRST_RENEWAL");
    });

    it("skips later monthly renewals", function () {
      var periodEnd = nowSeconds + 5 * DAY;
      var sub = subscription(5, {
        plan: { interval: "month" },
        created: periodEnd - 90 * DAY,
        current_period_start: periodEnd - 30 * DAY,
      });
      expect(decide(sub)).toBe(null);
    });
  });

  describe("scan", function () {
    global.test.user();

    beforeEach(function () {
      this.sends = [];
      this.periodEnds = [];
      var sends = this.sends;
      [
        "UPCOMING_RENEWAL",
        "UPCOMING_EXPIRY",
        "UPCOMING_MONTHLY_FIRST_RENEWAL",
      ].forEach(function (name) {
        spyOn(email, name).and.callFake(function (uid, locals, callback) {
          sends.push([name, uid]);
          callback();
        });
      });
    });

    afterEach(async function () {
      for (var periodEnd of this.periodEnds) {
        await client.del(subscriptionEmail.sentKey(this.user.uid, periodEnd));
        await client.del(subscriptionEmail.sendingKey(this.user.uid, periodEnd));
      }
    });

    function setUser(uid, updates) {
      return new Promise(function (resolve, reject) {
        User.set(uid, updates, function (err) {
          err ? reject(err) : resolve();
        });
      });
    }

    function mine(spec) {
      return spec.sends.filter(function (send) {
        return send[1] === spec.user.uid;
      });
    }

    it("sends once per user per period even when run twice", async function () {
      var uid = this.user.uid;
      var sub = subscription(5);
      this.periodEnds.push(sub.current_period_end);

      await setUser(uid, { subscription: sub });

      await subscriptionEmail.scan(now);
      await subscriptionEmail.scan(now);

      expect(mine(this)).toEqual([["UPCOMING_RENEWAL", uid]]);
    });

    it("sends once when two runs happen at the same time", async function () {
      var uid = this.user.uid;
      var sub = subscription(5);
      this.periodEnds.push(sub.current_period_end);

      await setUser(uid, { subscription: sub });
      await Promise.all([
        subscriptionEmail.sendForUser(uid, now),
        subscriptionEmail.sendForUser(uid, now),
      ]);

      expect(this.sends.length).toBe(1);
    });

    it("sends again for the next billing period", async function () {
      var uid = this.user.uid;
      var first = subscription(5);
      var second = subscription(5 + 365);
      this.periodEnds.push(first.current_period_end, second.current_period_end);

      await setUser(uid, { subscription: first });
      await subscriptionEmail.sendForUser(uid, now);
      await setUser(uid, { subscription: second });
      await subscriptionEmail.sendForUser(uid, now + 365 * DAY * 1000);

      expect(this.sends.length).toBe(2);
    });

    it("clears its claim when the send fails so the next scan retries", async function () {
      var uid = this.user.uid;
      var sub = subscription(5);
      this.periodEnds.push(sub.current_period_end);

      await setUser(uid, { subscription: sub });

      email.UPCOMING_RENEWAL.and.callFake(function (u, locals, callback) {
        callback(new Error("mail is down"));
      });

      var failed = false;
      try {
        await subscriptionEmail.sendForUser(uid, now);
      } catch (err) {
        failed = true;
      }
      expect(failed).toBe(true);

      email.UPCOMING_RENEWAL.and.callFake(function (u, locals, callback) {
        callback();
      });

      expect(await subscriptionEmail.sendForUser(uid, now)).toBe(
        "UPCOMING_RENEWAL"
      );
    });

    it("can resend after a crash between the send and the durable marker, once the claim expires", async function () {
      var uid = this.user.uid;
      var sub = subscription(5);
      this.periodEnds.push(sub.current_period_end);

      await setUser(uid, { subscription: sub });
      // Simulate a process that sent, then died before setting the durable
      // marker: only a (short-lived) claim remains.
      await client.set(subscriptionEmail.sendingKey(uid, sub.current_period_end), "1", { PX: 150 });

      expect(await subscriptionEmail.sendForUser(uid, now)).toBe(null);
      await new Promise(function (r) { setTimeout(r, 250); });
      expect(await subscriptionEmail.sendForUser(uid, now)).toBe("UPCOMING_RENEWAL");
      expect(await subscriptionEmail.sendForUser(uid, now)).toBe(null);
    });

    it("sends nothing to users outside the window", async function () {
      await setUser(this.user.uid, { subscription: subscription(30) });

      await subscriptionEmail.scan(now);

      expect(mine(this)).toEqual([]);
    });
  });
});
