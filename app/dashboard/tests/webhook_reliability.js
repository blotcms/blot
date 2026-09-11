const User = require("models/user");
const config = require("config");
const stripe = require("dashboard/webhooks/stripe_webhook");
const paypal = require("dashboard/webhooks/paypal_webhook");

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
});
