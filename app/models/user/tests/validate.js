var client = require("models/client");
var key = require("../key");
var validate = require("../validate/index");

function validateUser(user, updates) {
  return new Promise(function (resolve, reject) {
    validate(user, updates, function (err, updatedUser, changes) {
      if (err) return reject(err);
      resolve({ user: updatedUser, changes: changes });
    });
  });
}

describe("user validate", function () {
  var uid = "user_validate_tst";
  var email = "validatetest@example.com";
  var extraCleanupKeys = [];

  function createUser(overrides) {
    return Object.assign({
      uid: uid,
      email: email,
      blogs: [],
      isDisabled: false,
      lastSession: "",
      passwordHash: "hash123",
      created: Date.now(),
      welcomeEmailSent: true,
      subscription: {},
      paypal: {}
    }, overrides);
  }

  beforeEach(async function () {
    var user = createUser();
    await client.set(key.user(uid), JSON.stringify(user));
    await client.set(key.email(email), uid);
  });

  afterEach(async function () {
    await client.del([key.user(uid), key.email(email)].concat(extraCleanupKeys));
    extraCleanupKeys = [];
  });

  it("returns updated user and changes array", async function () {
    var user = createUser();
    var result = await validateUser(user, { lastSession: "new-session" });
    expect(result.user.lastSession).toEqual("new-session");
    expect(result.changes).toContain("lastSession");
  });

  it("validates string fields", async function () {
    var user = createUser();
    var result = await validateUser(user, { lastSession: "test" });
    expect(result.user.lastSession).toEqual("test");
  });

  it("validates boolean fields", async function () {
    var user = createUser();
    var result = await validateUser(user, { isDisabled: true });
    expect(result.user.isDisabled).toBe(true);
    expect(result.changes).toContain("isDisabled");
  });

  it("validates array fields", async function () {
    var user = createUser();
    var result = await validateUser(user, { blogs: ["blog1", "blog2"] });
    expect(result.user.blogs).toEqual(["blog1", "blog2"]);
    expect(result.changes).toContain("blogs");
  });

  it("validates object fields", async function () {
    var user = createUser();
    var subscription = { customer: "cus_new", status: "active" };
    var result = await validateUser(user, { subscription: subscription });
    expect(result.user.subscription).toEqual(subscription);
    expect(result.changes).toContain("subscription");
  });

  it("rejects invalid type for string field", async function () {
    var user = createUser();
    var error = await validateUser(user, { lastSession: 123 }).then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
  });

  it("rejects invalid type for boolean field", async function () {
    var user = createUser();
    var error = await validateUser(user, { isDisabled: "true" }).then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
  });

  it("rejects invalid type for array field", async function () {
    var user = createUser();
    var error = await validateUser(user, { blogs: "blog1" }).then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
  });

  it("handles multiple updates", async function () {
    var user = createUser();
    var result = await validateUser(user, {
      lastSession: "new-session",
      isDisabled: true,
      blogs: ["blog1"]
    });
    expect(result.user.lastSession).toEqual("new-session");
    expect(result.user.isDisabled).toBe(true);
    expect(result.user.blogs).toEqual(["blog1"]);
    expect(result.changes.length).toBe(3);
  });

  it("includes fields in changes array even if value is same (for non-email fields)", async function () {
    var user = createUser({ lastSession: "same-session" });
    var result = await validateUser(user, { lastSession: "same-session" });
    expect(result.changes).toContain("lastSession");
  });

  it("does not include email in changes when normalized value is the same", async function () {
    var user = createUser({ email: "test@example.com" });
    var result = await validateUser(user, { email: "TEST@EXAMPLE.COM" });
    expect(result.changes).not.toContain("email");
    expect(result.user.email).toEqual("test@example.com");
  });

  it("mutates the user object", async function () {
    var user = createUser();
    await validateUser(user, { lastSession: "mutated" });
    expect(user.lastSession).toEqual("mutated");
  });

  it("uses field-specific validator for email", async function () {
    var user = createUser();
    var result = await validateUser(user, { email: "NEW@EXAMPLE.COM" });
    expect(result.user.email).toEqual("new@example.com");
  });

  it("rejects email in use by another user", async function () {
    var otherEmail = "other-validate@example.com";
    var otherUid = "user_other_valid";
    var otherUser = {
      uid: otherUid,
      email: otherEmail,
      blogs: [],
      isDisabled: false,
      lastSession: "",
      passwordHash: "hash123",
      subscription: {},
      paypal: {}
    };
    await client.set(key.user(otherUid), JSON.stringify(otherUser));
    await client.set(key.email(otherEmail), otherUid);
    extraCleanupKeys.push(key.user(otherUid), key.email(otherEmail));

    var user = createUser();
    var error = await validateUser(user, { email: otherEmail }).then(
      function () { return null; },
      function (err) { return err; }
    );

    expect(error).not.toBeNull();
    expect(error.code).toEqual("EEXISTS");
  });
});
