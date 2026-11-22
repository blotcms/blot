describe("daily update billing mismatch", function () {
  const billingMismatch = require("../billing-mismatch");
  const User = require("models/user");
  const revenue = require("../revenue");
  const fs = require("fs");
  const Mustache = require("mustache");

  const user = (quantity, blogs, subscription = {}) => ({
    email: "pat@example.com",
    blogs: blogs.slice(),
    paypal: {},
    subscription: {
      status: "active",
      customer: "cus_test",
      plan: { amount: 500, interval: "month" },
      quantity,
      ...subscription,
    },
  });

  it("flags a subscription for more sites than the account has", function () {
    expect(billingMismatch(user(3, ["a", "b"]))).toEqual({
      email: "pat@example.com",
      quantity: 3,
      blogs: 2,
    });
  });

  it("allows a subscription of one with no sites, and free sites", function () {
    expect(billingMismatch(user(1, []))).toBeNull();
    expect(billingMismatch(user(2, ["a", "b"]))).toBeNull();
    expect(billingMismatch(user(1, ["a", "b", "c"]))).toBeNull();
  });

  it("ignores accounts without an active Stripe subscription", function () {
    expect(billingMismatch(user(3, ["a"], { status: "canceled" }))).toBeNull();
    expect(billingMismatch({ blogs: ["a"], subscription: {} })).toBeNull();
    expect(billingMismatch({ blogs: [] })).toBeNull();
  });

  it("is in the daily update, from the scan revenue already makes", async function () {
    const users = [user(3, ["a", "b"]), user(2, ["a", "b"])];

    spyOn(User, "getAllIds").and.callFake(async () => users.map((_, i) => i));
    spyOn(User, "getById").and.callFake(async (id) => users[id]);

    const result = await revenue();
    const template = fs.readFileSync(
      __dirname + "/../../../helper/email/admin/DAILY_UPDATE.txt",
      "utf8"
    );
    const text = Mustache.render(template, result);

    expect(result.billing_mismatches.length).toBe(1);
    expect(text).toContain("Paying for more sites than they have:");
    expect(text).toContain("pays for 3, has 2");
  });
});
