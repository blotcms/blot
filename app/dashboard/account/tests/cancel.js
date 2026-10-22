const Subscription = require("dashboard/account/subscription");
const paypal = require("dashboard/webhooks/paypal_webhook");
const User = require("models/user");
const email = require("helper/email");
const config = require("config");

// The POST handlers of /cancel, in order
function postHandlers() {
  const layer = Subscription.stack.find(
    layer => layer.route && layer.route.path === "/cancel"
  );
  return layer.route.stack
    .filter(layer => layer.method === "post")
    .map(layer => layer.handle);
}

function post(user) {
  const req = { user, baseUrl: "/account/subscription" };
  return new Promise(resolve => {
    const res = { message: () => resolve({}) };
    const handlers = postHandlers();
    const run = i => {
      if (i === handlers.length - 1) return handlers[i](req, res);
      handlers[i](req, res, err => (err ? resolve({ err }) : run(i + 1)));
    };
    run(0);
  });
}

describe("dashboard subscription cancel", function () {
  const paypalDefaults = {
    client_id: config.paypal.client_id,
    secret: config.paypal.secret,
    api_base: config.paypal.api_base
  };

  beforeEach(function () {
    config.paypal.client_id = "client";
    config.paypal.secret = "secret";
    config.paypal.api_base = "https://api.sandbox.paypal.com";
    spyOn(email, "CANCELLED");
    spyOn(email, "CANCELLED_FIRST_PERIOD");
    spyOn(paypal, "updateSubscription").and.returnValue(Promise.resolve());
    spyOn(global, "fetch").and.returnValue(Promise.resolve({ status: 204 }));
  });

  afterEach(function () {
    Object.assign(config.paypal, paypalDefaults);
  });

  const paypalUser = status => ({
    uid: "uid",
    subscription: {},
    paypal: { id: "I-TEST", status, start_time: "2001-01-01T00:00:00Z" }
  });

  it("cancels a PayPal subscription, then re-fetches it, without emailing itself", async function () {
    const result = await post(paypalUser("ACTIVE"));

    expect(result.err).toBeUndefined();
    const [url, options] = fetch.calls.mostRecent().args;
    expect(url).toBe(
      "https://api.sandbox.paypal.com/v1/billing/subscriptions/I-TEST/cancel"
    );
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe(
      "Basic " + Buffer.from("client:secret").toString("base64")
    );
    expect(paypal.updateSubscription).toHaveBeenCalledWith("I-TEST");
    expect(email.CANCELLED).not.toHaveBeenCalled();
    expect(email.CANCELLED_FIRST_PERIOD).not.toHaveBeenCalled();
  });

  it("does not call PayPal again when the subscription is already cancelled", async function () {
    const result = await post(paypalUser("CANCELLED"));

    expect(result.err).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(paypal.updateSubscription).not.toHaveBeenCalled();
    expect(email.CANCELLED).not.toHaveBeenCalled();
  });

  it("passes a PayPal API failure on and does not re-fetch", async function () {
    fetch.and.returnValue(Promise.resolve({ status: 422 }));

    const result = await post(paypalUser("ACTIVE"));

    expect(result.err).toEqual(jasmine.any(Error));
    expect(paypal.updateSubscription).not.toHaveBeenCalled();
  });

  it("reconciles by re-fetching when the cancel request fails in transport", async function () {
    fetch.and.returnValue(Promise.reject(new Error("socket hang up")));
    paypal.updateSubscription.and.returnValue(Promise.resolve({ status: "CANCELLED" }));

    const result = await post(paypalUser("ACTIVE"));

    expect(paypal.updateSubscription).toHaveBeenCalledWith("I-TEST");
    expect(result.err).toBeUndefined();
  });

  it("reconciles after an indeterminate 5xx from PayPal", async function () {
    fetch.and.returnValue(Promise.resolve({ status: 502 }));
    paypal.updateSubscription.and.returnValue(Promise.resolve({ status: "CANCELLED" }));

    const result = await post(paypalUser("ACTIVE"));

    expect(result.err).toBeUndefined();
  });

  it("still fails when a transport failure left the subscription active", async function () {
    fetch.and.returnValue(Promise.reject(new Error("socket hang up")));
    paypal.updateSubscription.and.returnValue(Promise.resolve({ status: "ACTIVE" }));

    const result = await post(paypalUser("ACTIVE"));

    expect(result.err).toBeDefined();
  });

  it("still succeeds when the re-fetch fails after PayPal cancelled", async function () {
    spyOn(console, "log");
    paypal.updateSubscription.and.returnValue(Promise.reject(new Error("boom")));

    const result = await post(paypalUser("ACTIVE"));

    expect(result.err).toBeUndefined();
    expect(paypal.updateSubscription).toHaveBeenCalledWith("I-TEST");
    expect(console.log).toHaveBeenCalled();
    expect(email.CANCELLED).not.toHaveBeenCalled();
    expect(email.CANCELLED_FIRST_PERIOD).not.toHaveBeenCalled();
  });

  it("sends the Stripe email for a Stripe user with historical cancelled PayPal data", async function () {
    const cancelled = { id: "sub_1", customer: "cus_1" };
    const customers = Object.getPrototypeOf(
      require("stripe")("sk_test_unused").customers
    );
    spyOn(customers, "cancelSubscription").and.callFake(
      (customer, id, options, cb) => cb(null, cancelled)
    );
    spyOn(User, "set").and.callFake((uid, updates, cb) => cb(null));

    const result = await post({
      uid: "uid",
      subscription: { id: "sub_1", customer: "cus_1", created: 1 },
      paypal: { id: "I-OLD", status: "CANCELLED" }
    });

    expect(result.err).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(paypal.updateSubscription).not.toHaveBeenCalled();
    expect(email.CANCELLED).toHaveBeenCalledWith("uid");
  });

  it("still cancels a Stripe subscription and sends the cancellation email", async function () {
    const cancelled = { id: "sub_1", customer: "cus_1" };
    // stripe.customers methods live on the resource prototype
    const customers = Object.getPrototypeOf(
      require("stripe")("sk_test_unused").customers
    );
    spyOn(customers, "cancelSubscription").and.callFake(
      (customer, id, options, cb) => cb(null, cancelled)
    );
    spyOn(User, "set").and.callFake((uid, updates, cb) => cb(null));

    const result = await post({
      uid: "uid",
      subscription: { id: "sub_1", customer: "cus_1", created: 1 }
    });

    expect(result.err).toBeUndefined();
    expect(customers.cancelSubscription).toHaveBeenCalledWith(
      "cus_1",
      "sub_1",
      { at_period_end: true },
      jasmine.any(Function)
    );
    expect(User.set).toHaveBeenCalledWith(
      "uid",
      { subscription: cancelled },
      jasmine.any(Function)
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(paypal.updateSubscription).not.toHaveBeenCalled();
    expect(email.CANCELLED).toHaveBeenCalledWith("uid");
  });

  describe("restart guard", function () {
    function guard(user) {
      const layer = Subscription.stack.find(
        layer => layer.route && layer.route.path === "/restart/pay"
      );
      const handle = layer.route.stack[0].handle;
      return new Promise(resolve => {
        handle(
          { user },
          { redirect: location => resolve({ redirected: location }) },
          () => resolve({ allowed: true })
        );
      });
    }

    it("allows restart for a cancelled Stripe user with PayPal history", async function () {
      const result = await guard({
        isSubscribed: false,
        subscription: { customer: "cus_1" },
        paypal: { id: "I-OLD", status: "CANCELLED" }
      });
      expect(result.allowed).toBe(true);
    });

    it("redirects a PayPal-only user", async function () {
      const result = await guard({
        isSubscribed: false,
        subscription: {},
        paypal: { id: "I-TEST", status: "CANCELLED" }
      });
      expect(result.redirected).toBe("/account/subscription");
    });

    it("redirects a subscribed user", async function () {
      const result = await guard({
        isSubscribed: true,
        subscription: { customer: "cus_1" }
      });
      expect(result.redirected).toBe("/account/subscription");
    });
  });
});
