const Delete = require("dashboard/account/delete");
const Email = require("helper/email");
const config = require("config");
const prettyPrice = require("helper/prettyPrice");

function runMiddleware(middleware, req) {
  return new Promise((resolve, reject) => {
    middleware(req, {}, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

describe("Dashboard account deletion refunds", function () {
  const paypalDefaults = {
    client_id: config.paypal.client_id,
    secret: config.paypal.secret,
    api_base: config.paypal.api_base,
  };

  beforeEach(function () {
    this.originalFetch = global.fetch;
    Delete._resetStripeClient();

    config.paypal.client_id = "client";
    config.paypal.secret = "secret";
    config.paypal.api_base = "https://api.sandbox.paypal.com";
  });

  afterEach(function () {
    Delete._resetStripeClient();
    global.fetch = this.originalFetch;

    config.paypal.client_id = paypalDefaults.client_id;
    config.paypal.secret = paypalDefaults.secret;
    config.paypal.api_base = paypalDefaults.api_base;
  });

  it("issues a Stripe refund within the first 30 days", async function () {
    const now = Date.now();
    const created = Math.floor((now - 10 * 24 * 60 * 60 * 1000) / 1000);

    const stripeClient = {
      invoices: {
        list: jasmine.createSpy("list").and.returnValue(
          Promise.resolve({
            data: [
              {
                id: "in_123",
                paid: true,
                charge: "ch_123",
                created,
              },
            ],
          })
        ),
      },
      refunds: {
        create: jasmine
          .createSpy("create")
          .and.returnValue(
            Promise.resolve({ id: "re_123", amount: 1200, currency: "usd" })
          ),
      },
      customers: {
        del: jasmine.createSpy("del"),
      },
    };

    Delete._setStripeClient(stripeClient);

    const req = {
      user: {
        subscription: { customer: "cus_123", created },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(stripeClient.invoices.list).toHaveBeenCalledWith({
      customer: "cus_123",
      limit: 100,
    });
    expect(stripeClient.refunds.create).toHaveBeenCalledWith({
      charge: "ch_123",
      reason: "requested_by_customer",
    });
    expect(req.refund).toEqual(
      jasmine.objectContaining({
        issued: true,
        provider: "stripe",
        providerPretty: "Stripe",
        amount: 1200,
        currency: "USD",
        amountPretty: prettyPrice(1200),
      })
    );
  });

  it("refunds the most recent eligible Stripe invoice when older history exists", async function () {
    const now = Date.now();
    const recentCreated = Math.floor((now - 6 * 24 * 60 * 60 * 1000) / 1000);
    const oldCreated = Math.floor((now - 120 * 24 * 60 * 60 * 1000) / 1000);

    const stripeClient = {
      invoices: {
        list: jasmine.createSpy("list").and.returnValue(
          Promise.resolve({
            data: [
              {
                id: "in_old",
                paid: true,
                charge: "ch_old",
                created: oldCreated,
              },
              {
                id: "in_recent",
                paid: true,
                charge: "ch_recent",
                created: recentCreated,
              },
            ],
          })
        ),
      },
      refunds: {
        create: jasmine
          .createSpy("create")
          .and.returnValue(
            Promise.resolve({ id: "re_recent", amount: 500, currency: "usd" })
          ),
      },
      customers: { del: jasmine.createSpy("del") },
    };

    Delete._setStripeClient(stripeClient);

    const req = {
      user: {
        subscription: { customer: "cus_history", created: recentCreated },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(stripeClient.invoices.list).toHaveBeenCalled();
    expect(stripeClient.refunds.create).toHaveBeenCalledWith({
      charge: "ch_recent",
      reason: "requested_by_customer",
    });
    expect(req.refund).toEqual(
      jasmine.objectContaining({
        issued: true,
        provider: "stripe",
        invoice: "in_recent",
        charge: "ch_recent",
      })
    );
  });

  it("skips Stripe refunds outside the first month", async function () {
    const created = Math.floor((Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000);

    const stripeClient = {
      invoices: {
        list: jasmine.createSpy("list"),
      },
      refunds: {
        create: jasmine.createSpy("create"),
      },
      customers: {
        del: jasmine.createSpy("del"),
      },
    };

    Delete._setStripeClient(stripeClient);

    const req = {
      user: {
        subscription: { customer: "cus_old", created },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(stripeClient.invoices.list).not.toHaveBeenCalled();
    expect(stripeClient.refunds.create).not.toHaveBeenCalled();
    expect(req.refund).toBeUndefined();
  });

  it("issues a PayPal refund within the first 30 days", async function () {
    const startTime = new Date(
      Date.now() - 5 * 24 * 60 * 60 * 1000
    ).toISOString();
    const expectedAuth = `Basic ${Buffer.from("client:secret").toString("base64")}`;

    const transactionsData = {
      transactions: [
        {
          id: "CAPTURE123",
          status: "COMPLETED",
          time: new Date().toISOString(),
          amount_with_breakdown: {
            gross_amount: { value: "12.00", currency_code: "USD" },
          },
        },
      ],
    };

    const refundData = {
      id: "REFUND123",
      amount: { value: "12.00", currency_code: "USD" },
    };

    const fetchSpy = jasmine
      .createSpy("fetch")
      .and.callFake((url, options = {}) => {
        if (url.includes("/transactions")) {
          expect(options.headers.Authorization).toBe(expectedAuth);
          return Promise.resolve(mockResponse(200, transactionsData));
        }

        if (url.includes("/refund")) {
          expect(options.method).toBe("POST");
          expect(options.headers.Authorization).toBe(expectedAuth);
          return Promise.resolve(mockResponse(201, refundData));
        }

        return Promise.reject(new Error(`Unexpected URL ${url}`));
      });

    global.fetch = fetchSpy;

    const req = {
      user: {
        paypal: { id: "I-123", status: "ACTIVE", start_time: startTime },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(fetchSpy.calls.count()).toBe(2);
    expect(req.refund).toEqual(
      jasmine.objectContaining({
        issued: true,
        provider: "paypal",
        providerPretty: "PayPal",
        amount: 1200,
        currency: "USD",
        amountPretty: prettyPrice(1200),
      })
    );
  });

  it("skips PayPal refunds outside the first month", async function () {
    const startTime = new Date(
      Date.now() - 45 * 24 * 60 * 60 * 1000
    ).toISOString();

    const fetchSpy = jasmine.createSpy("fetch");
    global.fetch = fetchSpy;

    const req = {
      user: {
        paypal: { id: "I-999", status: "ACTIVE", start_time: startTime },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(req.refund).toBeUndefined();
  });

  it("continues when Stripe reports a refund has already happened", async function () {
    const now = Date.now();
    const created = Math.floor((now - 7 * 24 * 60 * 60 * 1000) / 1000);

    const stripeError = new Error("Charge already refunded");
    stripeError.code = "charge_already_refunded";

    const stripeClient = {
      invoices: {
        list: jasmine.createSpy("list").and.returnValue(
          Promise.resolve({
            data: [{ id: "in_987", paid: true, charge: "ch_987", created }],
          })
        ),
      },
      refunds: {
        create: jasmine
          .createSpy("create")
          .and.returnValue(Promise.reject(stripeError)),
      },
      customers: { del: jasmine.createSpy("del") },
    };

    Delete._setStripeClient(stripeClient);

    const req = {
      user: {
        subscription: { customer: "cus_refunded", created },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(stripeClient.invoices.list).toHaveBeenCalled();
    expect(stripeClient.refunds.create).toHaveBeenCalled();
    expect(req.refund).toEqual(
      jasmine.objectContaining({
        issued: false,
        provider: "stripe",
        providerPretty: "Stripe",
        skipped: true,
        error: jasmine.stringMatching(/already refunded/i),
      })
    );
  });

  it("continues when Stripe refunds fail unexpectedly", async function () {
    const now = Date.now();
    const created = Math.floor((now - 5 * 24 * 60 * 60 * 1000) / 1000);

    const stripeClient = {
      invoices: {
        list: jasmine.createSpy("list").and.returnValue(
          Promise.resolve({
            data: [{ id: "in_777", paid: true, charge: "ch_777", created }],
          })
        ),
      },
      refunds: {
        create: jasmine
          .createSpy("create")
          .and.returnValue(Promise.reject(new Error("Stripe outage"))),
      },
      customers: { del: jasmine.createSpy("del") },
    };

    Delete._setStripeClient(stripeClient);

    const req = {
      user: {
        subscription: { customer: "cus_fail", created },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(stripeClient.refunds.create).toHaveBeenCalled();
    expect(req.refund).toEqual(
      jasmine.objectContaining({
        issued: false,
        provider: "stripe",
        skipped: true,
        error: jasmine.stringMatching(/stripe outage/i),
      })
    );
  });

  it("continues when PayPal reports a refund has already happened", async function () {
    const startTime = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const expectedAuth = `Basic ${Buffer.from("client:secret").toString("base64")}`;

    const transactionsData = {
      transactions: [
        {
          id: "CAPTURE321",
          status: "COMPLETED",
          time: new Date().toISOString(),
          amount: { value: "10.00", currency: "USD" },
        },
      ],
    };

    const refundError = {
      name: "UNPROCESSABLE_ENTITY",
      details: [
        {
          issue: "REFUND_ALREADY_COMPLETED",
          description: "Refund has already been completed for this capture.",
        },
      ],
      message: "Refund has already been completed for this capture.",
    };

    const fetchSpy = jasmine
      .createSpy("fetch")
      .and.callFake((url, options = {}) => {
        if (url.includes("/transactions")) {
          expect(options.headers.Authorization).toBe(expectedAuth);
          return Promise.resolve(mockResponse(200, transactionsData));
        }

        if (url.includes("/refund")) {
          expect(options.method).toBe("POST");
          return Promise.resolve(mockResponse(422, refundError));
        }

        return Promise.reject(new Error(`Unexpected URL ${url}`));
      });

    global.fetch = fetchSpy;

    const req = {
      user: {
        paypal: { id: "I-ALREADY", status: "ACTIVE", start_time: startTime },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(fetchSpy.calls.count()).toBe(2);
    expect(req.refund).toEqual(
      jasmine.objectContaining({
        issued: false,
        provider: "paypal",
        providerPretty: "PayPal",
        skipped: true,
        error: jasmine.stringMatching(/already/i),
      })
    );
  });

  it("continues when PayPal refunds fail unexpectedly", async function () {
    const startTime = new Date(
      Date.now() - 3 * 24 * 60 * 60 * 1000
    ).toISOString();

    const transactionsData = {
      transactions: [
        {
          id: "CAPTURE500",
          status: "COMPLETED",
          time: new Date().toISOString(),
          amount_with_breakdown: {
            gross_amount: { value: "25.00", currency_code: "USD" },
          },
        },
      ],
    };

    const refundError = { name: "INTERNAL_SERVER_ERROR", message: "boom" };

    const fetchSpy = jasmine
      .createSpy("fetch")
      .and.callFake((url, options = {}) => {
        if (url.includes("/transactions")) {
          return Promise.resolve(mockResponse(200, transactionsData));
        }

        if (url.includes("/refund")) {
          return Promise.resolve(mockResponse(500, refundError));
        }

        return Promise.reject(new Error(`Unexpected URL ${url}`));
      });

    global.fetch = fetchSpy;

    const req = {
      user: {
        paypal: { id: "I-FAIL", status: "ACTIVE", start_time: startTime },
        email: "user@example.com",
      },
    };

    await runMiddleware(Delete.exports.refund, req);

    expect(fetchSpy.calls.count()).toBe(2);
    expect(req.refund).toEqual(
      jasmine.objectContaining({
        issued: false,
        provider: "paypal",
        skipped: true,
        error: jasmine.stringMatching(/boom/i),
      })
    );
  });

  it("continues deleting account when Stripe customer is already missing", async function () {
    const stripeError = new Error("No such customer");
    stripeError.type = "StripeInvalidRequestError";
    stripeError.code = "resource_missing";
    stripeError.statusCode = 404;

    const stripeClient = {
      invoices: { list: jasmine.createSpy("list") },
      refunds: { create: jasmine.createSpy("create") },
      customers: {
        del: jasmine
          .createSpy("del")
          .and.returnValue(Promise.reject(stripeError)),
      },
    };

    Delete._setStripeClient(stripeClient);

    const req = {
      user: {
        subscription: {
          customer: "cus_missing",
          created: Math.floor(Date.now() / 1000),
        },
      },
      issueDeletionRefundHandled: true,
    };

    spyOn(console, "warn");
    spyOn(console, "error");

    await runMiddleware(Delete.exports.subscription, req);

    expect(stripeClient.customers.del).toHaveBeenCalledWith("cus_missing");
    expect(console.warn).toHaveBeenCalledWith(
      "Stripe customer already missing; continuing account deletion",
      jasmine.objectContaining({
        customer: "cus_missing",
        code: "resource_missing",
        type: "StripeInvalidRequestError",
        statusCode: 404,
      })
    );
    expect(console.error).not.toHaveBeenCalled();
  });

  it("fails deleting account for unexpected Stripe customer deletion errors", async function () {
    const stripeError = new Error("Stripe network issue");
    stripeError.type = "StripeConnectionError";

    const stripeClient = {
      invoices: { list: jasmine.createSpy("list") },
      refunds: { create: jasmine.createSpy("create") },
      customers: {
        del: jasmine
          .createSpy("del")
          .and.returnValue(Promise.reject(stripeError)),
      },
    };

    Delete._setStripeClient(stripeClient);

    const req = {
      user: {
        subscription: {
          customer: "cus_broken",
          created: Math.floor(Date.now() / 1000),
        },
      },
      issueDeletionRefundHandled: true,
    };

    spyOn(console, "warn");
    spyOn(console, "error");

    await expectAsync(
      runMiddleware(Delete.exports.subscription, req)
    ).toBeRejectedWith(stripeError);

    expect(stripeClient.customers.del).toHaveBeenCalledWith("cus_broken");
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "Error in deleting subscription:",
      stripeError
    );
  });

  it("sends the refund email when a refund is issued", function (done) {
    const refund = {
      issued: true,
      provider: "stripe",
      providerPretty: "Stripe",
      amountPretty: prettyPrice(500),
      currency: "USD",
    };

    spyOn(Email, "DELETED_FIRST_PERIOD").and.callFake((uid, locals, callback) =>
      callback()
    );
    spyOn(Email, "DELETED").and.callFake((uid, locals, callback) => callback());

    const req = {
      user: { uid: "user_123", email: "user@example.com" },
      refund,
    };

    Delete.exports.email(req, {}, function (err) {
      expect(err).toBeUndefined();
      expect(Email.DELETED_FIRST_PERIOD).toHaveBeenCalledWith(
        "",
        jasmine.objectContaining({ refund, email: "user@example.com" }),
        jasmine.any(Function)
      );
      expect(Email.DELETED).not.toHaveBeenCalled();
      done();
    });
  });
});

function mockResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}
