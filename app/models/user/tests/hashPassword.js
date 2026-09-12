var hashPassword = require("../hashPassword");
var checkPassword = require("../checkPassword");
var client = require("models/client");
var key = require("../key");
var promisify = require("util").promisify;
var hash = promisify(hashPassword);
var check = promisify(checkPassword);

describe("user hashPassword", function () {
  it("generates a bcrypt hash", async function () {
    var password = "mysecretpassword";
    var hashedPassword = await hash(password);
    expect(hashedPassword).toBeDefined();
    expect(hashedPassword.length).toBeGreaterThan(0);
    expect(hashedPassword).not.toEqual(password);
  });

  it("generates different hashes for the same password", async function () {
    var password = "samepassword";
    var hash1 = await hash(password);
    var hash2 = await hash(password);
    expect(hash1).not.toEqual(hash2);
  });

  it("handles empty password", async function () {
    var hashedPassword = await hash("");
    expect(hashedPassword).toBeDefined();
    expect(hashedPassword.length).toBeGreaterThan(0);
  });

  it("handles special characters in password", async function () {
    var password = "p@$$w0rd!#$%^&*()";
    var hashedPassword = await hash(password);
    expect(hashedPassword).toBeDefined();
    expect(hashedPassword).not.toEqual(password);
  });

  it("handles unicode characters in password", async function () {
    var password = "密码🔐émoji";
    var hashedPassword = await hash(password);
    expect(hashedPassword).toBeDefined();
    expect(hashedPassword).not.toEqual(password);
  });
});

describe("user checkPassword", function () {
  var uid = "user_checkpw_test";
  var password = "testpassword123";

  beforeEach(async function () {
    var passwordHash = await hash(password);
    var user = {
      uid: uid,
      email: "checkpw@example.com",
      blogs: [],
      isDisabled: false,
      lastSession: "",
      passwordHash: passwordHash,
      subscription: {},
      paypal: {}
    };
    await client.set(key.user(uid), JSON.stringify(user));
  });

  afterEach(async function () {
    await client.del(key.user(uid));
  });

  it("returns true for correct password", async function () {
    var result = await check(uid, password);
    expect(result).toBe(true);
  });

  it("returns false for incorrect password", async function () {
    var result = await check(uid, "wrongpassword");
    expect(result).toBe(false);
  });

  it("returns false for empty password when user has a password set", async function () {
    var result = await check(uid, "");
    expect(result).toBe(false);
  });

  it("returns error for non-existent user", async function () {
    var error = await check("user_nonexistent", password).then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("No user");
  });

  it("handles case-sensitive passwords correctly", async function () {
    var resultLower = await check(uid, password.toLowerCase());
    var resultUpper = await check(uid, password.toUpperCase());
    var resultCorrect = await check(uid, password);
    
    expect(resultCorrect).toBe(true);
    if (password !== password.toLowerCase()) {
      expect(resultLower).toBe(false);
    }
    if (password !== password.toUpperCase()) {
      expect(resultUpper).toBe(false);
    }
  });
});
