const User = require("models/user");
const config = require("config");
const stripe = require("dashboard/webhooks/stripe_webhook");
const paypal = require("dashboard/webhooks/paypal_webhook");
const email = require("helper/email");
const client = require("models/client");

function route(router) {
  const layers = router.stack.find(layer => layer.route).route.stack;
  return layers[layers.length - 1].handle;
}
function response() {
  let code, complete;
  const done = new Promise(resolve => { complete = resolve; });
  return { done, get code() { return code; },
    sendStatus(value) { code = value; complete(value); },
    status(value) { code = value; return this; },
    send() { complete(code); } };
}

describe("payment webhook delivery reliability", function () {
  let stripeSecret, paypalID, stripeClient;
  const user = { uid: "test-user", blogs: [], isDisabled: false,
    subscription: { status: "active" } };
  const event = { type: "customer.subscription.updated", data: {
    object: { id: "sub_test", customer: "cus_test" } } };
  const paypalEvent = { event_type: "BILLING.SUBSCRIPTION.UPDATED",
    resource: { id: "I-TEST" } };
  beforeEach(function () {
    stripeSecret = config.stripe.webhook_secret;
    paypalID = config.paypal.webhook_id;
    config.stripe.webhook_secret = "";
    config.paypal.webhook_id = "";
    spyOn(console, "warn");
    spyOn(console, "error");
    spyOn(console, "log");
    spyOn(User, "getByCustomerId").and.callFake((id, cb) => cb(null, user));
    spyOn(User, "getByPayPalSubscriptionId").and.callFake((id, cb) => cb(null, user));
    spyOn(User, "set").and.callFake((id, updates, cb) => cb(null));
    spyOn(User, "enable").and.callFake((user, updates, cb) => User.set(user.uid, updates, cb));
    spyOn(User, "disable").and.callFake((user, updates, cb) => User.set(user.uid, updates, cb));
    spyOn(global, "fetch").and.callFake(async () => ({ ok: true,
      json: async () => ({ id: "I-TEST", status: "ACTIVE" }) }));
    stripeClient = { customers: { retrieveSubscription: (customer, id, cb) =>
      cb(null, { id, customer, status: "active" }) } };
    stripe._setStripeClient(stripeClient);
  });
  afterEach(function () {
    config.stripe.webhook_secret = stripeSecret;
    config.paypal.webhook_id = paypalID;
    stripe._resetStripeClient();
  });
  const stripeRequest = () => ({ body: Buffer.from(JSON.stringify(event)) });
  it("acknowledges Stripe only after the update completes", function () {
    let save;
    User.set.and.callFake((id, updates, cb) => { save = cb; });
    const res = response();
    route(stripe)(stripeRequest(), res);
    expect(typeof save).toBe("function");
    expect(res.code).toBeUndefined();
    save(null);
    expect(res.code).toBe(200);
  });
  it("returns a retryable Stripe response on a storage failure", function () {
    User.set.and.callFake((id, updates, cb) => cb(new Error("temporary storage failure")));
    const res = response();
    route(stripe)(stripeRequest(), res);
    expect(res.code).toBe(503);
  });
  it("returns a retryable Stripe response on a provider failure", function () {
    stripeClient.customers.retrieveSubscription = (customer, id, cb) => cb(new Error("offline"));
    const res = response();
    route(stripe)(stripeRequest(), res);
    expect(res.code).toBe(503);
    expect(User.set).not.toHaveBeenCalled();
  });
  it("preserves blog availability when the Stripe account is already enabled", function () {
    const res = response();
    route(stripe)(stripeRequest(), res);
    expect(User.enable).not.toHaveBeenCalled();
    expect(User.disable).not.toHaveBeenCalled();
    expect(User.set).toHaveBeenCalled();
    expect(res.code).toBe(200);
  });
  it("settles PayPal network failures without updating the user", async function () {
    global.fetch.and.callFake(async () => { throw new Error("offline"); });
    const res = response();
    await route(paypal)({ body: paypalEvent }, res);
    expect(res.code).toBe(503);
    expect(User.set).not.toHaveBeenCalled();
  });
  it("settles PayPal JSON failures without updating the user", async function () {
    global.fetch.and.callFake(async () => ({ ok: true, json: async () => { throw new Error("bad JSON"); } }));
    const res = response();
    await route(paypal)({ body: paypalEvent }, res);
    expect(res.code).toBe(503);
    expect(User.set).not.toHaveBeenCalled();
  });
  it("does not persist a PayPal HTTP error body", async function () {
    global.fetch.and.callFake(async () => ({ ok: false, status: 500 }));
    const res = response();
    await route(paypal)({ body: paypalEvent }, res);
    expect(res.code).toBe(503);
    expect(User.set).not.toHaveBeenCalled();
  });
  it("rejects a PayPal response for a different subscription", async function () {
    global.fetch.and.callFake(async () => ({ ok: true, json: async () => ({ id: "OTHER", status: "ACTIVE" }) }));
    const res = response();
    await route(paypal)({ body: paypalEvent }, res);
    expect(res.code).toBe(503);
    expect(User.set).not.toHaveBeenCalled();
  });
  it("waits for PayPal persistence and reports its failure", async function () {
    let save, started;
    const saving = new Promise(resolve => { started = resolve; });
    User.set.and.callFake((id, updates, cb) => { save = cb; started(); });
    const res = response();
    const handling = route(paypal)({ body: paypalEvent }, res);
    await saving;
    expect(res.code).toBeUndefined();
    save(new Error("temporary storage failure"));
    await handling;
    expect(res.code).toBe(503);
  });
  it("acknowledges a persisted PayPal subscription", async function () {
    const res = response();
    await route(paypal)({ body: paypalEvent }, res);
    expect(res.code).toBe(200);
    expect(User.set).toHaveBeenCalled();
    expect(User.enable).not.toHaveBeenCalled();
    expect(User.disable).not.toHaveBeenCalled();
  });
  it("keeps malformed PayPal events as client errors", async function () {
    const res = response();
    await route(paypal)({ body: { event_type: paypalEvent.event_type } }, res);
    expect(res.code).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it("aborts a stalled PayPal request and returns a retryable response", async function () {
    jasmine.clock().install();
    try {
      let started;
      const fetching = new Promise(resolve => { started = resolve; });
      global.fetch.and.callFake((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        started();
      }));
      const res = response();
      const handling = route(paypal)({ body: paypalEvent }, res);
      await fetching;
      jasmine.clock().tick(15001);
      await handling;
      expect(res.code).toBe(503);
      expect(User.set).not.toHaveBeenCalled();
    } finally {
      jasmine.clock().uninstall();
    }
  });

  describe("PayPal cancellation email", function () {
    const DAY = 24 * 60 * 60 * 1000;
    let claimed, failed, subscription;
    const cancel = (overrides) => {
      subscription = Object.assign({ id: "I-TEST", status: "CANCELLED",
        start_time: new Date(Date.now() - 200 * DAY).toISOString(),
        billing_info: { next_billing_time: new Date(Date.now() + 5 * DAY).toISOString() } },
        overrides);
    };
    beforeEach(function () {
      claimed = new Set();
      failed = new Set();
      user.paypal = { status: "ACTIVE" };
      cancel();
      global.fetch.and.callFake(async () => ({ ok: true, json: async () => subscription }));
      spyOn(client, "set").and.callFake(async (k, v, options) =>
        options.NX && claimed.has(k) ? null : (claimed.add(k), "OK"));
      spyOn(client, "getDel").and.callFake(async k => {
        const had = failed.has(k);
        failed.delete(k);
        return had ? "failed" : null;
      });
      ["CANCELLED", "CANCELLED_FIRST_PERIOD", "CLOSED", "ALREADY_CANCELLED"].forEach(name =>
        spyOn(email, name));
    });
    afterEach(function () {
      delete user.paypal;
      user.isDisabled = false;
    });
    it("sends the cancellation email on the first CANCELLED transition", async function () {
      await paypal.updateSubscription("I-TEST");
      expect(email.CANCELLED).toHaveBeenCalledTimes(1);
      expect(email.CANCELLED).toHaveBeenCalledWith("test-user", {}, jasmine.any(Function));
      expect(email.CANCELLED_FIRST_PERIOD).not.toHaveBeenCalled();
      expect(client.set).toHaveBeenCalledWith(
        "user:test-user:paypal_cancel_email:I-TEST", "1",
        { NX: true, EX: 90 * DAY / 1000 });
    });
    it("sends the first-period variant within 30 days of the start", async function () {
      cancel({ start_time: new Date(Date.now() - 3 * DAY).toISOString() });
      await paypal.updateSubscription("I-TEST");
      expect(email.CANCELLED_FIRST_PERIOD).toHaveBeenCalledTimes(1);
      expect(email.CANCELLED_FIRST_PERIOD).toHaveBeenCalledWith("test-user", {}, jasmine.any(Function));
      expect(email.CANCELLED).not.toHaveBeenCalled();
    });
    it("sends it once when the update is retried or concurrent", async function () {
      await Promise.all([paypal.updateSubscription("I-TEST"),
        paypal.updateSubscription("I-TEST")]);
      user.paypal = { status: "CANCELLED" };
      await paypal.updateSubscription("I-TEST");
      expect(email.CANCELLED).toHaveBeenCalledTimes(1);
    });
    it("retries once on the next update after a failed send", async function () {
      const K = "user:test-user:paypal_cancel_email:I-TEST";
      const multi = { del: jasmine.createSpy("del"), set: jasmine.createSpy("set") };
      multi.del.and.returnValue(multi);
      multi.set.and.returnValue(multi);
      multi.exec = () => { claimed.delete(K); failed.add(K + ":failed"); return Promise.resolve([]); };
      spyOn(client, "multi").and.returnValue(multi);
      email.CANCELLED.and.callFake((uid, locals, cb) => cb(new Error("mailgun")));
      await paypal.updateSubscription("I-TEST");
      await new Promise(r => setImmediate(r));
      expect(multi.del).toHaveBeenCalledWith(K);
      expect(multi.set).toHaveBeenCalledWith(K + ":failed", "1", { EX: 90 * DAY / 1000 });
      email.CANCELLED.and.stub();
      user.paypal = { status: "CANCELLED" };
      await paypal.updateSubscription("I-TEST");
      await paypal.updateSubscription("I-TEST");
      expect(email.CANCELLED).toHaveBeenCalledTimes(2);
    });
    it("does not send it when the status was already CANCELLED", async function () {
      user.paypal = { status: "CANCELLED" };
      await paypal.updateSubscription("I-TEST");
      expect(client.set).not.toHaveBeenCalled();
      expect(email.CANCELLED).not.toHaveBeenCalled();
    });
    it("sends CLOSED instead when the paid period has ended", async function () {
      cancel({ billing_info: { next_billing_time: new Date(Date.now() - DAY).toISOString() } });
      await paypal.updateSubscription("I-TEST");
      expect(email.CLOSED).toHaveBeenCalledTimes(1);
      expect(email.CLOSED).toHaveBeenCalledWith("test-user");
      expect(email.CANCELLED).not.toHaveBeenCalled();
      expect(client.set).not.toHaveBeenCalled();
    });
    it("sends ALREADY_CANCELLED instead for a disabled account", async function () {
      user.isDisabled = true;
      await paypal.updateSubscription("I-TEST");
      expect(email.ALREADY_CANCELLED).toHaveBeenCalledTimes(1);
      expect(email.ALREADY_CANCELLED).toHaveBeenCalledWith("test-user");
      expect(email.CANCELLED).not.toHaveBeenCalled();
      expect(client.set).not.toHaveBeenCalled();
    });
    it("does not email when the save fails", async function () {
      User.set.and.callFake((id, updates, cb) => cb(new Error("down")));
      await expectAsync(paypal.updateSubscription("I-TEST")).toBeRejected();
      expect(client.set).not.toHaveBeenCalled();
      expect(email.CANCELLED).not.toHaveBeenCalled();
    });
  });
});
