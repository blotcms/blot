var client = require("models/client");
var key = require("../key");
var getByCustomerId = require("../getByCustomerId");
var promisify = require("util").promisify;
var get = promisify(getByCustomerId);

describe("user getByCustomerId", function () {
  var uid = "user_custid_test";
  var customerId = "cus_test123";
  var validUser = {
    uid: uid,
    email: "customer@example.com",
    blogs: [],
    isDisabled: false,
    lastSession: "",
    passwordHash: "hash123",
    subscription: { customer: customerId },
    paypal: {}
  };

  beforeEach(async function () {
    await client.set(key.user(uid), JSON.stringify(validUser));
    await client.set(key.customer(customerId), uid);
    await client.sAdd(key.uids, uid);
  });

  afterEach(async function () {
    await client.del([key.user(uid), key.customer(customerId)]);
    await client.sRem(key.uids, uid);
  });

  it("returns null for non-existent customer ID", async function () {
    var result = await get("cus_nonexistent");
    expect(result).toBeNull();
  });

  it("retrieves a user by Stripe customer ID", async function () {
    var result = await get(customerId);
    expect(result.uid).toEqual(uid);
    expect(result.subscription.customer).toEqual(customerId);
  });

  it("returns null when customer index exists but user does not", async function () {
    await client.del(key.user(uid));
    var result = await get(customerId);
    expect(result).toBeNull();
  });
});
