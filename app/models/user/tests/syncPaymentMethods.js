var syncPaymentMethods = require("../syncPaymentMethods");
var User = require("../index");

function baseStripeClient(overrides) {
  return Object.assign(
    {
      customers: Object.assign(
        {
          retrieveSubscription: jasmine
            .createSpy("retrieveSubscription")
            .and.callFake(function (customerId, subscriptionId, cb) {
              cb(null, { id: subscriptionId, default_payment_method: null });
            }),
          listCards: jasmine
            .createSpy("listCards")
            .and.callFake(function (customerId, params, cb) {
              cb(null, { data: [] });
            }),
        },
        (overrides && overrides.customers) || {}
      ),
      paymentMethods: (overrides && overrides.paymentMethods) || {
        list: jasmine.createSpy("list").and.callFake(function (params, cb) {
          cb(null, { data: [] });
        }),
      },
    },
    {}
  );
}

describe("user syncPaymentMethods", function () {
  global.test.user();

  afterEach(function () {
    syncPaymentMethods._resetStripeClient();
  });

  it("returns an empty list and does not call Stripe for a user without a Stripe customer", async function () {
    var paymentMethods = await syncPaymentMethods(this.user);
    expect(paymentMethods).toEqual([]);
  });

  describe("with a Stripe customer", function () {
    beforeEach(async function () {
      var test = this;

      await User.set(this.user.uid, {
        subscription: { id: "sub_123", customer: "cus_123" },
      });

      test.user = await User.getById(test.user.uid);
    });

    it("caches payment methods from Stripe, marking the customer's default", async function () {
      var stripeClient = baseStripeClient({
        customers: {
          retrieve: jasmine
            .createSpy("retrieve")
            .and.callFake(function (customerId, cb) {
              cb(null, {
                id: customerId,
                invoice_settings: { default_payment_method: "pm_2" },
                default_source: null,
              });
            }),
        },
        paymentMethods: {
          list: jasmine.createSpy("list").and.callFake(function (params, cb) {
            cb(null, {
              data: [
                {
                  id: "pm_1",
                  card: {
                    brand: "visa",
                    last4: "4242",
                    exp_month: 1,
                    exp_year: 2030,
                  },
                },
                {
                  id: "pm_2",
                  card: {
                    brand: "mastercard",
                    last4: "4444",
                    exp_month: 6,
                    exp_year: 2031,
                  },
                },
              ],
              has_more: false,
            });
          }),
        },
      });

      syncPaymentMethods._setStripeClient(stripeClient);

      var test = this;

      var paymentMethods = await syncPaymentMethods(this.user);

      expect(paymentMethods.length).toBe(2);
      expect(paymentMethods[0]).toEqual(
        jasmine.objectContaining({
          id: "pm_1",
          brand: "visa",
          isDefault: false,
        })
      );
      expect(paymentMethods[1]).toEqual(
        jasmine.objectContaining({
          id: "pm_2",
          brand: "mastercard",
          isDefault: true,
        })
      );

      var user = await User.getById(test.user.uid);
      expect(user.paymentMethods.length).toBe(2);
    });

    it("prefers the subscription-level default over the customer-level default", async function () {
      var stripeClient = baseStripeClient({
        customers: {
          retrieve: jasmine
            .createSpy("retrieve")
            .and.callFake(function (customerId, cb) {
              cb(null, {
                id: customerId,
                invoice_settings: { default_payment_method: "pm_1" },
                default_source: null,
              });
            }),
          retrieveSubscription: jasmine
            .createSpy("retrieveSubscription")
            .and.callFake(function (customerId, subscriptionId, cb) {
              cb(null, { id: subscriptionId, default_payment_method: "pm_2" });
            }),
        },
        paymentMethods: {
          list: jasmine.createSpy("list").and.callFake(function (params, cb) {
            cb(null, {
              data: [
                {
                  id: "pm_1",
                  card: {
                    brand: "visa",
                    last4: "1111",
                    exp_month: 1,
                    exp_year: 2030,
                  },
                },
                {
                  id: "pm_2",
                  card: {
                    brand: "visa",
                    last4: "2222",
                    exp_month: 1,
                    exp_year: 2030,
                  },
                },
              ],
              has_more: false,
            });
          }),
        },
      });

      syncPaymentMethods._setStripeClient(stripeClient);

      var paymentMethods = await syncPaymentMethods(this.user);

      expect(
        paymentMethods.find(function (pm) {
          return pm.id === "pm_1";
        }).isDefault
      ).toBe(false);
      expect(
        paymentMethods.find(function (pm) {
          return pm.id === "pm_2";
        }).isDefault
      ).toBe(true);
    });

    it("treats a missing subscription as having no override, falling back to the customer default", async function () {
      var stripeClient = baseStripeClient({
        customers: {
          retrieve: jasmine
            .createSpy("retrieve")
            .and.callFake(function (customerId, cb) {
              cb(null, {
                id: customerId,
                invoice_settings: { default_payment_method: "pm_1" },
                default_source: null,
              });
            }),
          retrieveSubscription: jasmine
            .createSpy("retrieveSubscription")
            .and.callFake(function (customerId, subscriptionId, cb) {
              var notFound = new Error("No such subscription");
              notFound.code = "resource_missing";
              cb(notFound);
            }),
        },
        paymentMethods: {
          list: jasmine.createSpy("list").and.callFake(function (params, cb) {
            cb(null, {
              data: [
                {
                  id: "pm_1",
                  card: {
                    brand: "visa",
                    last4: "1111",
                    exp_month: 1,
                    exp_year: 2030,
                  },
                },
              ],
              has_more: false,
            });
          }),
        },
      });

      syncPaymentMethods._setStripeClient(stripeClient);

      var paymentMethods = await syncPaymentMethods(this.user);
      expect(paymentMethods[0].isDefault).toBe(true);
    });

    it("propagates a non-resource_missing error from the subscription fetch instead of silently falling back", async function () {
      var stripeClient = baseStripeClient({
        customers: {
          retrieve: jasmine
            .createSpy("retrieve")
            .and.callFake(function (customerId, cb) {
              cb(null, {
                id: customerId,
                invoice_settings: {},
                default_source: null,
              });
            }),
          retrieveSubscription: jasmine
            .createSpy("retrieveSubscription")
            .and.callFake(function (customerId, subscriptionId, cb) {
              cb(new Error("Stripe is temporarily unavailable"));
            }),
        },
      });

      syncPaymentMethods._setStripeClient(stripeClient);

      try {
        await syncPaymentMethods(this.user);
        fail("expected rejection");
      } catch (err) {
        expect(err).toBeTruthy();
      }
    });

    it("honors a subscription-level legacy default_source over the customer's default", async function () {
      var stripeClient = baseStripeClient({
        customers: {
          retrieve: jasmine
            .createSpy("retrieve")
            .and.callFake(function (customerId, cb) {
              cb(null, {
                id: customerId,
                invoice_settings: {},
                default_source: "card_customer_default",
              });
            }),
          retrieveSubscription: jasmine
            .createSpy("retrieveSubscription")
            .and.callFake(function (customerId, subscriptionId, cb) {
              cb(null, {
                id: subscriptionId,
                default_payment_method: null,
                default_source: "card_subscription_default",
              });
            }),
          listCards: jasmine
            .createSpy("listCards")
            .and.callFake(function (customerId, params, cb) {
              cb(null, {
                data: [
                  {
                    id: "card_customer_default",
                    brand: "Visa",
                    last4: "1111",
                    exp_month: 1,
                    exp_year: 2030,
                  },
                  {
                    id: "card_subscription_default",
                    brand: "Visa",
                    last4: "2222",
                    exp_month: 1,
                    exp_year: 2030,
                  },
                ],
              });
            }),
        },
      });

      syncPaymentMethods._setStripeClient(stripeClient);

      var paymentMethods = await syncPaymentMethods(this.user);

      expect(
        paymentMethods.find(function (pm) {
          return pm.id === "card_subscription_default";
        }).isDefault
      ).toBe(true);
      expect(
        paymentMethods.find(function (pm) {
          return pm.id === "card_customer_default";
        }).isDefault
      ).toBe(false);
    });

    it("follows has_more to fetch every page of legacy cards", async function () {
      var pageOne = {
        data: [
          {
            id: "card_1",
            brand: "Visa",
            last4: "1111",
            exp_month: 1,
            exp_year: 2030,
          },
        ],
        has_more: true,
      };
      var pageTwo = {
        data: [
          {
            id: "card_2",
            brand: "Visa",
            last4: "2222",
            exp_month: 1,
            exp_year: 2030,
          },
        ],
        has_more: false,
      };

      var stripeClient = baseStripeClient({
        customers: {
          retrieve: jasmine
            .createSpy("retrieve")
            .and.callFake(function (customerId, cb) {
              cb(null, {
                id: customerId,
                invoice_settings: {},
                default_source: null,
              });
            }),
          listCards: jasmine
            .createSpy("listCards")
            .and.callFake(function (customerId, params, cb) {
              if (params.starting_after === "card_1") return cb(null, pageTwo);
              cb(null, pageOne);
            }),
        },
      });

      syncPaymentMethods._setStripeClient(stripeClient);

      var paymentMethods = await syncPaymentMethods(this.user);

      expect(paymentMethods.length).toBe(2);
      expect(
        paymentMethods.map(function (pm) {
          return pm.id;
        })
      ).toEqual(["card_1", "card_2"]);
    });

    it("follows has_more to fetch every page of payment methods", async function () {
      var pageOne = {
        data: [
          {
            id: "pm_1",
            card: {
              brand: "visa",
              last4: "1111",
              exp_month: 1,
              exp_year: 2030,
            },
          },
        ],
        has_more: true,
      };
      var pageTwo = {
        data: [
          {
            id: "pm_2",
            card: {
              brand: "visa",
              last4: "2222",
              exp_month: 1,
              exp_year: 2030,
            },
          },
        ],
        has_more: false,
      };

      var stripeClient = baseStripeClient({
        customers: {
          retrieve: jasmine
            .createSpy("retrieve")
            .and.callFake(function (customerId, cb) {
              cb(null, {
                id: customerId,
                invoice_settings: {},
                default_source: null,
              });
            }),
        },
        paymentMethods: {
          list: jasmine.createSpy("list").and.callFake(function (params, cb) {
            if (params.starting_after === "pm_1") return cb(null, pageTwo);
            cb(null, pageOne);
          }),
        },
      });

      syncPaymentMethods._setStripeClient(stripeClient);

      var paymentMethods = await syncPaymentMethods(this.user);

      expect(paymentMethods.length).toBe(2);
      expect(
        paymentMethods.map(function (pm) {
          return pm.id;
        })
      ).toEqual(["pm_1", "pm_2"]);
    });

    it("includes every legacy card, marking only the default source as default", async function () {
      var stripeClient = baseStripeClient({
        customers: {
          retrieve: jasmine
            .createSpy("retrieve")
            .and.callFake(function (customerId, cb) {
              cb(null, {
                id: customerId,
                invoice_settings: {},
                default_source: "card_legacy1",
              });
            }),
          listCards: jasmine
            .createSpy("listCards")
            .and.callFake(function (customerId, params, cb) {
              cb(null, {
                data: [
                  {
                    id: "card_legacy1",
                    brand: "Visa",
                    last4: "1881",
                    exp_month: 3,
                    exp_year: 2029,
                  },
                  {
                    id: "card_legacy2",
                    brand: "MasterCard",
                    last4: "9001",
                    exp_month: 4,
                    exp_year: 2029,
                  },
                ],
              });
            }),
        },
      });

      syncPaymentMethods._setStripeClient(stripeClient);

      var paymentMethods = await syncPaymentMethods(this.user);

      expect(paymentMethods.length).toBe(2);
      expect(paymentMethods).toEqual(
        jasmine.arrayContaining([
          jasmine.objectContaining({
            id: "card_legacy1",
            brand: "visa",
            isDefault: true,
            isLegacy: true,
          }),
          jasmine.objectContaining({
            id: "card_legacy2",
            brand: "mastercard",
            isDefault: false,
            isLegacy: true,
          }),
        ])
      );
    });
  });
});
