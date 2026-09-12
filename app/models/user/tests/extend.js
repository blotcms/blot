var extend = require("../extend");
var prettyDate = require("helper/prettyDate");
var prettyPrice = require("helper/prettyPrice");

describe("user extend", function () {
  function createUser(overrides) {
    return Object.assign({
      uid: "user_extend_test",
      email: "extend@example.com",
      blogs: ["blog1"],
      isDisabled: false,
      lastSession: "",
      passwordHash: "hash123",
      created: Date.now(),
      welcomeEmailSent: true,
      subscription: {},
      paypal: {}
    }, overrides);
  }

  describe("sensitive field removal", function () {
    it("removes passwordHash", function () {
      var user = createUser({ passwordHash: "secrethash" });
      extend(user);
      expect(user.passwordHash).toBeUndefined();
    });

    it("removes credentials", function () {
      var user = createUser({ credentials: { key: "secret" } });
      extend(user);
      expect(user.credentials).toBeUndefined();
    });

    it("removes created", function () {
      var user = createUser({ created: 1234567890 });
      extend(user);
      expect(user.created).toBeUndefined();
    });

    it("removes welcomeEmailSent", function () {
      var user = createUser({ welcomeEmailSent: true });
      extend(user);
      expect(user.welcomeEmailSent).toBeUndefined();
    });

    it("sets hasPassword true when passwordHash exists", function () {
      var user = createUser({ passwordHash: "hash123" });
      extend(user);
      expect(user.hasPassword).toBe(true);
    });

    it("sets hasPassword false when passwordHash is empty", function () {
      var user = createUser({ passwordHash: "" });
      extend(user);
      expect(user.hasPassword).toBe(false);
    });
  });

  describe("blog plurality", function () {
    it("sets multipleBlogs false for single blog", function () {
      var user = createUser({ blogs: ["blog1"] });
      extend(user);
      expect(user.multipleBlogs).toBe(false);
      expect(user.s).toEqual("");
      expect(user.are).toEqual("is");
    });

    it("sets multipleBlogs true for multiple blogs", function () {
      var user = createUser({ blogs: ["blog1", "blog2"] });
      extend(user);
      expect(user.multipleBlogs).toBe(true);
      expect(user.s).toEqual("s");
      expect(user.are).toEqual("are");
    });

    it("sets multipleBlogs true for zero blogs", function () {
      var user = createUser({ blogs: [] });
      extend(user);
      expect(user.multipleBlogs).toBe(true);
    });
  });

  describe("Stripe subscription", function () {
    it("sets isSubscribed for active subscription", function () {
      var user = createUser({
        subscription: {
          status: "active",
          customer: "cus_123",
          plan: { amount: 4400, interval: "year" },
          quantity: 1
        }
      });
      extend(user);
      expect(user.isSubscribed).toBe(true);
    });

    it("sets isSubscribed for trialing subscription", function () {
      var user = createUser({
        subscription: {
          status: "trialing",
          customer: "cus_123",
          plan: { amount: 4400, interval: "year" },
          quantity: 1
        }
      });
      extend(user);
      expect(user.isSubscribed).toBe(true);
    });

    it("sets willCancel when cancel_at_period_end is true", function () {
      var user = createUser({
        subscription: {
          status: "active",
          cancel_at_period_end: true,
          customer: "cus_123",
          plan: { amount: 4400, interval: "year" },
          quantity: 1
        }
      });
      extend(user);
      expect(user.willCancel).toBe(true);
      expect(user.cancel_at_period_end).toBe(true);
      expect(user.isSubscribed).toBeUndefined();
    });

    it("sets isFreeForLife when no customer and no paypal", function () {
      var user = createUser({
        subscription: { status: "active" },
        paypal: {}
      });
      extend(user);
      expect(user.isFreeForLife).toBe(true);
    });

    it("sets isUnpaid for unpaid status", function () {
      var user = createUser({
        subscription: {
          status: "unpaid",
          customer: "cus_123"
        }
      });
      extend(user);
      expect(user.isUnpaid).toBe(true);
      expect(user.needsToPay).toBe(true);
    });

    it("sets isPastDue for past_due status", function () {
      var user = createUser({
        subscription: {
          status: "past_due",
          customer: "cus_123"
        }
      });
      extend(user);
      expect(user.isPastDue).toBe(true);
      expect(user.needsToPay).toBe(true);
    });

    it("sets isMonthly for monthly interval", function () {
      var user = createUser({
        subscription: {
          status: "active",
          customer: "cus_123",
          plan: { amount: 500, interval: "month" },
          quantity: 1
        }
      });
      extend(user);
      expect(user.isMonthly).toBe(true);
    });

    it("calculates totalFee correctly", function () {
      var user = createUser({
        subscription: {
          status: "active",
          customer: "cus_123",
          plan: { amount: 4400, interval: "year" },
          quantity: 2
        }
      });
      extend(user);
      expect(user.totalFee).toBe(8800);
    });

    it("sets pretty fields for subscription", function () {
      var currentPeriodEnd = Math.floor(Date.now() / 1000) + 86400;
      var user = createUser({
        subscription: {
          status: "active",
          customer: "cus_123",
          plan: { amount: 4400, interval: "year" },
          quantity: 2,
          current_period_end: currentPeriodEnd
        }
      });
      extend(user);
      expect(user.pretty.amount).toBe(2);
      expect(user.pretty.s).toEqual("s");
      expect(user.pretty.interval).toEqual("year");
      expect(user.pretty.price).toEqual(prettyPrice(4400 * 2));
      expect(user.pretty.expiry).toEqual(prettyDate(currentPeriodEnd * 1000));
    });

    it("sets pretty.s empty for quantity 1", function () {
      var user = createUser({
        subscription: {
          status: "active",
          customer: "cus_123",
          plan: { amount: 4400, interval: "year" },
          quantity: 1
        }
      });
      extend(user);
      expect(user.pretty.s).toEqual("");
    });
  });

  describe("PayPal subscription", function () {
    var config = require("config");
    var originalPlans;

    // Deterministic, test-only plan IDs so these specs exercise the real
    // code path regardless of whether BLOT_PAYPAL_* secrets are configured
    // in the environment running the tests (they aren't in CI).
    var testPlans = {
      monthly_4: "P-TEST-MONTHLY-4",
      yearly_44: "P-TEST-YEARLY-44"
    };

    beforeEach(function () {
      originalPlans = config.paypal.plans;
      config.paypal.plans = testPlans;
    });

    afterEach(function () {
      config.paypal.plans = originalPlans;
    });

    it("sets isSubscribed for ACTIVE paypal status", function () {
      var user = createUser({
        subscription: {},
        paypal: {
          status: "ACTIVE",
          plan_id: testPlans.yearly_44,
          quantity: "1",
          billing_info: {
            next_billing_time: new Date(Date.now() + 86400000).toISOString()
          }
        }
      });
      extend(user);
      expect(user.isSubscribed).toBe(true);
    });

    it("sets willCancel for CANCELLED paypal status", function () {
      var user = createUser({
        subscription: {},
        paypal: {
          status: "CANCELLED",
          plan_id: testPlans.yearly_44,
          quantity: "1",
          billing_info: {
            last_payment: { time: new Date().toISOString() }
          }
        }
      });
      extend(user);
      expect(user.willCancel).toBe(true);
    });

    it("sets isMonthly for monthly PayPal plan", function () {
      var user = createUser({
        subscription: {},
        paypal: {
          status: "ACTIVE",
          plan_id: testPlans.monthly_4,
          quantity: "1",
          billing_info: {
            next_billing_time: new Date(Date.now() + 86400000).toISOString()
          }
        }
      });
      extend(user);
      expect(user.isMonthly).toBe(true);
      expect(user.pretty.interval).toEqual("month");
    });

    it("sets yearly interval for yearly PayPal plan", function () {
      var user = createUser({
        subscription: {},
        paypal: {
          status: "ACTIVE",
          plan_id: testPlans.yearly_44,
          quantity: "1",
          billing_info: {
            next_billing_time: new Date(Date.now() + 86400000).toISOString()
          }
        }
      });
      extend(user);
      expect(user.isMonthly).toBe(false);
      expect(user.pretty.interval).toEqual("year");
    });
  });

  it("returns the modified user object", function () {
    var user = createUser();
    var result = extend(user);
    expect(result).toBe(user);
  });
});
