var client = require("models/client");
var key = require("../key");
var getByEmail = require("../getByEmail");

describe("user getByEmail", function () {
  var uid = "user_getbyemail_t";
  var email = "getbyemail@example.com";
  var validUser = {
    uid: uid,
    email: email,
    blogs: [],
    isDisabled: false,
    lastSession: "",
    passwordHash: "hash123",
    subscription: {},
    paypal: {},
  };

  beforeEach(async function () {
    await client.set(key.user(uid), JSON.stringify(validUser));
    await client.set(key.email(email), uid);
    await client.sAdd(key.uids, uid);
  });

  afterEach(async function () {
    await client.del([key.user(uid), key.email(email)]);
    await client.sRem(key.uids, uid);
  });

  it("returns null for non-existent email", async function () {
    var result = await getByEmail("nonexistent@example.com");
    expect(result).toBeNull();
  });

  it("retrieves a user by email", async function () {
    var result = await getByEmail(email);
    expect(result.uid).toEqual(uid);
    expect(result.email).toEqual(email);
  });

  it("normalizes email to lowercase", async function () {
    var result = await getByEmail("GETBYEMAIL@EXAMPLE.COM");
    expect(result.uid).toEqual(uid);
  });

  it("trims whitespace from email", async function () {
    var result = await getByEmail("  getbyemail@example.com  ");
    expect(result.uid).toEqual(uid);
  });

  it("handles combined case and whitespace normalization", async function () {
    var result = await getByEmail("  GetByEmail@Example.COM  ");
    expect(result.uid).toEqual(uid);
  });

  it("returns null when email index exists but user does not", async function () {
    await client.del(key.user(uid));
    var result = await getByEmail(email);
    expect(result).toBeNull();
  });
});
