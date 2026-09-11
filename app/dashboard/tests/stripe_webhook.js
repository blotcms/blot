const { promisify } = require("util");
const Blog = require("models/blog");
const User = require("models/user");
const webhook = require("dashboard/webhooks/stripe_webhook");

const setUser = promisify(User.set);
const setBlog = promisify(Blog.set);
const getUser = promisify(User.getById);
const getBlog = promisify(Blog.get);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Stripe subscription webhooks", function () {
  global.test.server(webhook);
  global.test.blog();

  beforeEach(async function () {
    const uniqueSuffix = `${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
    this.customerId = `cus_${uniqueSuffix}`;
    this.subscriptionId = `sub_${uniqueSuffix}`;

    await setUser(this.user.uid, {
      subscription: {
        id: this.subscriptionId,
        customer: this.customerId,
        status: "past_due",
        plan: { amount: 500, interval: "month" },
        quantity: 1,
        cancel_at_period_end: false,
      },
    });
  });

  beforeEach(function () {
    this.stripeClient = {
      customers: {
        retrieveSubscription: jasmine
          .createSpy("retrieveSubscription")
          .and.callFake((customerId, subscriptionId, callback) =>
            callback(null, {
              id: subscriptionId,
              customer: customerId,
              status: "active",
              plan: { amount: 700, interval: "month" },
              quantity: 2,
              cancel_at_period_end: false,
            })
          ),
      },
    };

    webhook._setStripeClient(this.stripeClient);
  });

  afterEach(function () {
    webhook._resetStripeClient();
  });

  it("preserves an independently disabled blog on an active subscription update", async function () {
    await setBlog(this.blog.id, { isDisabled: true });
    const event = {
      type: "customer.subscription.updated",
      data: { object: { id: this.subscriptionId, customer: this.customerId } },
    };

    const response = await this.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });

    expect(response.status).toBe(200);
    expect((await getUser(this.user.uid)).isDisabled).toBe(false);
    expect((await getBlog({ id: this.blog.id })).isDisabled).toBe(true);
  });

  it("updates subscription details on update event", async function () {
    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: this.subscriptionId,
          customer: this.customerId,
          status: "active",
          plan: { amount: 700, interval: "month" },
          quantity: 2,
          cancel_at_period_end: false,
        },
      },
    };

    const response = await this.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });

    expect(response.status).toBe(200);
    expect(this.stripeClient.customers.retrieveSubscription).toHaveBeenCalledWith(
      this.customerId,
      this.subscriptionId,
      jasmine.any(Function)
    );

    await delay(100);

    const user = await getUser(this.user.uid);
    expect(user.subscription.status).toBe("active");
    expect(user.subscription.quantity).toBe(2);
    expect(user.subscription.plan.amount).toBe(700);
    expect(user.isDisabled).toBe(false);

    const blog = await getBlog({ id: this.blog.id });
    expect(blog.isDisabled).toBe(false);
  });

  it("disables the account on deleted event", async function () {
    this.stripeClient.customers.retrieveSubscription.and.callFake(
      (customerId, subscriptionId, callback) =>
        callback(null, {
          id: subscriptionId,
          customer: customerId,
          status: "canceled",
          plan: { amount: 500, interval: "month" },
          quantity: 1,
          cancel_at_period_end: false,
        })
    );

    const event = {
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: this.subscriptionId,
          customer: this.customerId,
          status: "canceled",
          plan: { amount: 500, interval: "month" },
          quantity: 1,
          cancel_at_period_end: false,
        },
      },
    };

    const response = await this.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });

    expect(response.status).toBe(200);
    expect(this.stripeClient.customers.retrieveSubscription).toHaveBeenCalledWith(
      this.customerId,
      this.subscriptionId,
      jasmine.any(Function)
    );

    await delay(100);

    const user = await getUser(this.user.uid);
    expect(user.subscription.status).toBe("canceled");
    expect(user.isDisabled).toBe(true);

    const blog = await getBlog({ id: this.blog.id });
    expect(blog.isDisabled).toBe(true);
  });


  it("disables active subscriptions once cancel_at_period_end has elapsed", async function () {
    await setUser(this.user.uid, {
      subscription: {
        id: this.subscriptionId,
        customer: this.customerId,
        status: "active",
        plan: { amount: 500, interval: "month" },
        quantity: 1,
        cancel_at_period_end: true,
      },
    });

    this.stripeClient.customers.retrieveSubscription.and.callFake(
      (customerId, subscriptionId, callback) =>
        callback(null, {
          id: subscriptionId,
          customer: customerId,
          status: "active",
          plan: { amount: 500, interval: "month" },
          quantity: 1,
          cancel_at_period_end: true,
          current_period_end: Math.floor(Date.now() / 1000) - 10,
        })
    );

    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: this.subscriptionId,
          customer: this.customerId,
        },
      },
    };

    const response = await this.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });

    expect(response.status).toBe(200);

    await delay(100);

    const user = await getUser(this.user.uid);
    expect(user.subscription.status).toBe("active");
    expect(user.subscription.cancel_at_period_end).toBe(true);
    expect(user.isDisabled).toBe(true);

    const blog = await getBlog({ id: this.blog.id });
    expect(blog.isDisabled).toBe(true);
  });

  it("re-enables disabled accounts when subscription becomes active", async function () {
    await setUser(this.user.uid, {
      isDisabled: true,
      subscription: {
        id: this.subscriptionId,
        customer: this.customerId,
        status: "canceled",
        plan: { amount: 500, interval: "month" },
        quantity: 1,
        cancel_at_period_end: false,
      },
    });

    await setBlog(this.blog.id, { isDisabled: true });

    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: this.subscriptionId,
          customer: this.customerId,
          status: "active",
          plan: { amount: 700, interval: "month" },
          quantity: 2,
          cancel_at_period_end: false,
        },
      },
    };

    const response = await this.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });

    expect(response.status).toBe(200);

    await delay(100);

    const user = await getUser(this.user.uid);
    expect(user.subscription.status).toBe("active");
    expect(user.isDisabled).toBe(false);

    const blog = await getBlog({ id: this.blog.id });
    expect(blog.isDisabled).toBe(false);
  });

  it("returns 503 when subscription retrieval fails", async function () {
    this.stripeClient.customers.retrieveSubscription.and.callFake((_, __, callback) =>
      callback(new Error("nope"))
    );

    const event = {
      type: "customer.subscription.updated",
      data: {
        object: {
          id: this.subscriptionId,
          customer: this.customerId,
          status: "active",
          plan: { amount: 700, interval: "month" },
          quantity: 2,
          cancel_at_period_end: false,
        },
      },
    };

    const response = await this.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });

    expect(response.status).toBe(503);
    expect(this.stripeClient.customers.retrieveSubscription).toHaveBeenCalled();

    await delay(100);

    const user = await getUser(this.user.uid);
    expect(user.subscription.status).toBe("past_due");
    expect(user.isDisabled).toBe(false);

    const blog = await getBlog({ id: this.blog.id });
    expect(blog.isDisabled).toBe(false);
  });

  it("returns 400 for malformed payloads without touching state", async function () {
    const malformedEvent = {
      data: {
        object: {
          id: this.subscriptionId,
          customer: this.customerId,
        },
      },
    };

    const response = await this.fetch("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(malformedEvent),
    });

    expect(response.status).toBe(400);
    expect(this.stripeClient.customers.retrieveSubscription).not.toHaveBeenCalled();

    await delay(100);

    const user = await getUser(this.user.uid);
    expect(user.subscription.status).toBe("past_due");
    expect(user.subscription.quantity).toBe(1);
    expect(user.subscription.plan.amount).toBe(500);
    expect(user.isDisabled).toBe(false);

    const blog = await getBlog({ id: this.blog.id });
    expect(blog.isDisabled).toBe(false);
  });
});
