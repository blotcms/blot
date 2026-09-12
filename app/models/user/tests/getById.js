var client = require("models/client");
var key = require("../key");
var getById = require("../getById");
var promisify = require("util").promisify;
var get = promisify(getById);

describe("user getById", function () {
  var uid = "user_getbyid_test";
  var validUser = {
    uid: uid,
    email: "getbyid@example.com",
    blogs: [],
    isDisabled: false,
    lastSession: "",
    passwordHash: "hash123",
    subscription: {},
    paypal: {}
  };

  beforeEach(async function () {
    await client.sAdd(key.uids, uid);
  });

  afterEach(async function () {
    await client.del(key.user(uid));
    await client.sRem(key.uids, uid);
  });

  it("returns null for non-existent user", async function () {
    var result = await get("user_nonexistent");
    expect(result).toBeNull();
  });

  it("retrieves a user by uid", async function () {
    await client.set(key.user(uid), JSON.stringify(validUser));
    var result = await get(uid);
    expect(result.uid).toEqual(uid);
    expect(result.email).toEqual("getbyid@example.com");
  });

  it("applies default created=0 for legacy users", async function () {
    var legacyUser = { uid: uid, email: "legacy@example.com" };
    await client.set(key.user(uid), JSON.stringify(legacyUser));
    var result = await get(uid);
    expect(result.created).toBe(0);
  });

  it("applies default welcomeEmailSent=true for legacy users", async function () {
    var legacyUser = { uid: uid, email: "legacy@example.com" };
    await client.set(key.user(uid), JSON.stringify(legacyUser));
    var result = await get(uid);
    expect(result.welcomeEmailSent).toBe(true);
  });

  it("preserves existing created and welcomeEmailSent values", async function () {
    var userWithValues = Object.assign({}, validUser, {
      created: 1234567890,
      welcomeEmailSent: false
    });
    await client.set(key.user(uid), JSON.stringify(userWithValues));
    var result = await get(uid);
    expect(result.created).toBe(1234567890);
    expect(result.welcomeEmailSent).toBe(false);
  });

  it("returns error for invalid JSON", async function () {
    await client.set(key.user(uid), "not valid json");
    var error = await get(uid).then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("BADJSON");
  });

  it("returns error for JSON that is not an object", async function () {
    await client.set(key.user(uid), JSON.stringify("string value"));
    var error = await get(uid).then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
  });
});
