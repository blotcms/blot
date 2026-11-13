const checkStripeSubscription = require("../stripeSubscription");

describe("account Stripe subscription check", function () {
  const user = { subscription: { customer: "cus_1", id: "sub_1" } };

  const missing = () =>
    Object.assign(new Error("No such subscription"), {
      code: "resource_missing",
    });

  // A fake Stripe client: retrieve answers with `retrieve`, list with `list`
  function client({ retrieve, list }) {
    return {
      customers: {
        retrieveSubscription: jasmine
          .createSpy("retrieveSubscription")
          .and.callFake(retrieve),
      },
      subscriptions: {
        list: jasmine.createSpy("list").and.callFake(list),
      },
    };
  }

  it("finds a subscription Stripe still has, without listing others", async function () {
    const stripe = client({
      retrieve: async () => ({ id: "sub_1", status: "active" }),
    });

    expect(await checkStripeSubscription(user, stripe)).toEqual({
      state: "found",
    });
    expect(stripe.customers.retrieveSubscription).toHaveBeenCalledWith(
      "cus_1",
      "sub_1"
    );
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
  });

  it("returns the customer's other active subscription when the stored one is gone", async function () {
    const other = { id: "sub_2", status: "active" };
    const stripe = client({
      retrieve: async () => {
        throw missing();
      },
      list: async () => ({ data: [other] }),
    });

    expect(await checkStripeSubscription(user, stripe)).toEqual({
      state: "replaced",
      subscription: other,
    });
    expect(stripe.subscriptions.list).toHaveBeenCalledWith({
      customer: "cus_1",
      status: "active",
      limit: 1,
    });
  });

  it("reports the subscription missing when nothing active replaces it", async function () {
    const stripe = client({
      retrieve: async () => {
        throw missing();
      },
      list: async () => ({ data: [] }),
    });

    expect(await checkStripeSubscription(user, stripe)).toEqual({
      state: "missing",
    });
  });

  it("reports it missing when the customer is gone too", async function () {
    const stripe = client({
      retrieve: async () => {
        throw missing();
      },
      list: async () => {
        throw missing();
      },
    });

    expect(await checkStripeSubscription(user, stripe)).toEqual({
      state: "missing",
    });
  });

  // An outage or a bad key must not look like a lapsed subscription
  it("throws any other Stripe error", async function () {
    const outage = Object.assign(new Error("Stripe is down"), {
      code: "api_connection_error",
    });
    const stripe = client({
      retrieve: async () => {
        throw outage;
      },
    });

    let error;
    try {
      await checkStripeSubscription(user, stripe);
    } catch (err) {
      error = err;
    }

    expect(error).toBe(outage);
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
  });

  it("does nothing for a user without a Stripe subscription", async function () {
    const stripe = client({});

    expect(await checkStripeSubscription({ subscription: {} }, stripe)).toEqual(
      { state: "none" }
    );
    expect(stripe.customers.retrieveSubscription).not.toHaveBeenCalled();
  });
});
