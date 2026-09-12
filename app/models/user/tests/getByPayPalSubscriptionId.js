var client = require("models/client");
var key = require("../key");
var getByPayPalSubscriptionId = require("../getByPayPalSubscriptionId");
var promisify = require("util").promisify;
var get = promisify(getByPayPalSubscriptionId);

describe("user getByPayPalSubscriptionId", function () {
  var uid = "user_paypal_test";
  var subscriptionId = "I-TEST123";
  var validUser = {
    uid: uid,
    email: "paypal@example.com",
    blogs: [],
    isDisabled: false,
    lastSession: "",
    passwordHash: "hash123",
    subscription: {},
    paypal: { id: subscriptionId }
  };

  beforeEach(async function () {
    await client.set(key.user(uid), JSON.stringify(validUser));
    await client.set(key.paypal(subscriptionId), uid);
    await client.sAdd(key.uids, uid);
  });

  afterEach(async function () {
    await client.del([key.user(uid), key.paypal(subscriptionId)]);
    await client.sRem(key.uids, uid);
  });

  it("returns null for non-existent PayPal subscription ID", async function () {
    var result = await get("I-NONEXISTENT");
    expect(result).toBeNull();
  });

  it("retrieves a user by PayPal subscription ID", async function () {
    var result = await get(subscriptionId);
    expect(result.uid).toEqual(uid);
    expect(result.paypal.id).toEqual(subscriptionId);
  });

  it("returns null when PayPal index exists but user does not", async function () {
    await client.del(key.user(uid));
    var result = await get(subscriptionId);
    expect(result).toBeNull();
  });
});
