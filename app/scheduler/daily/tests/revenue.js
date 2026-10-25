const User = require("models/user");
const config = require("config");
const revenue = require("../revenue");
const fs = require("fs");
const Mustache = require("mustache");

describe("scheduler/daily/revenue sites per customer", function () {
  let users;
  let originalPlans;

  function stripeUser(quantity, overrides = {}) {
    return Object.assign({
      blogs: [],
      paypal: {},
      subscription: {
        status: "active",
        customer: "cus_test",
        plan: { amount: 500, interval: "month" },
        quantity
      }
    }, overrides);
  }

  const collect = () => new Promise((resolve, reject) =>
    revenue((err, result) => err ? reject(err) : resolve(result))
  );

  beforeEach(function () {
    users = [];
    originalPlans = config.paypal.plans;
    config.paypal.plans = { monthly_5: "P-TEST-MONTHLY-5" };
    spyOn(User, "getAllIds").and.callFake(callback => callback(null, users.map((_, i) => i)));
    spyOn(User, "getById").and.callFake((id, callback) => callback(null, users[id]));
  });

  afterEach(function () {
    config.paypal.plans = originalPlans;
  });

  it("averages subscribed sites across Stripe and PayPal customers, excluding inactive users", async function () {
    users = [
      stripeUser(1),
      stripeUser(2),
      {
        blogs: [],
        subscription: {},
        paypal: {
          status: "ACTIVE",
          plan_id: "P-TEST-MONTHLY-5",
          quantity: "2",
          billing_info: { next_billing_time: "2099-01-01T00:00:00Z" }
        }
      },
      stripeUser(100, { isDisabled: true }),
      stripeUser(100, { subscription: {} }),
      null
    ];

    const result = await collect();
    expect(result.total_customers).toBe(3);
    expect(result.total_active_blogs).toBe("5");
    expect(result.sites_per_customer).toBe("1.67");
  });

  it("calculates before formatting site totals and renders the stat in the email", async function () {
    users = [stripeUser(1000), stripeUser(1001)];
    const result = await collect();
    const template = fs.readFileSync(__dirname + "/../../../helper/email/admin/DAILY_UPDATE.txt", "utf8");

    expect(Mustache.render(template, result)).toContain(
      "Sites: 2,001 sites, 2 customers, 1000.50 sites per customer"
    );
  });

  it("reports zero when there are no customers", async function () {
    expect((await collect()).sites_per_customer).toBe("0.00");
  });
});
