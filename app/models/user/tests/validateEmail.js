var client = require("models/client");
var key = require("../key");
var validateEmail = require("../validate/email");
var promisify = require("util").promisify;
var validate = promisify(validateEmail);

describe("user validate email", function () {
  var uid = "user_validate_eml";
  var otherUid = "user_other_email";
  var email = "validate@example.com";
  var otherEmail = "other@example.com";
  var validUser = {
    uid: uid,
    email: email,
    blogs: [],
    isDisabled: false,
    lastSession: "",
    passwordHash: "hash123",
    subscription: {},
    paypal: {}
  };
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

  beforeEach(async function () {
    await client.set(key.user(uid), JSON.stringify(validUser));
    await client.set(key.email(email), uid);
    await client.set(key.user(otherUid), JSON.stringify(otherUser));
    await client.set(key.email(otherEmail), otherUid);
    await client.sAdd(key.uids, [uid, otherUid]);
  });

  afterEach(async function () {
    await client.del([
      key.user(uid),
      key.email(email),
      key.user(otherUid),
      key.email(otherEmail),
      key.email("new@example.com"),
      key.email("normalized@example.com")
    ]);
    await client.sRem(key.uids, [uid, otherUid]);
  });

  it("returns error for empty email", async function () {
    var error = await validate(validUser, "").then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("Please enter an email");
  });

  it("returns error for whitespace-only email", async function () {
    var error = await validate(validUser, "   ").then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("Please enter an email");
  });

  it("returns error for invalid email format", async function () {
    var error = await validate(validUser, "notanemail").then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("Please enter a valid email");
  });

  it("returns error for email without domain", async function () {
    var error = await validate(validUser, "user@").then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("Please enter a valid email");
  });

  it("returns error for email without TLD", async function () {
    var error = await validate(validUser, "user@domain").then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("Please enter a valid email");
  });

  it("returns error when email is already in use by another user", async function () {
    var error = await validate(validUser, otherEmail).then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("This email is in use.");
    expect(error.code).toEqual("EEXISTS");
  });

  it("allows user to keep their own email", async function () {
    var result = await validate(validUser, email);
    expect(result).toEqual(email);
  });

  it("allows user to keep their own email with different case", async function () {
    var result = await validate(validUser, "VALIDATE@EXAMPLE.COM");
    expect(result).toEqual(email);
  });

  it("allows new unique email", async function () {
    var newEmail = "new@example.com";
    var result = await validate(validUser, newEmail);
    expect(result).toEqual(newEmail);
  });

  it("normalizes email to lowercase", async function () {
    var result = await validate(validUser, "NORMALIZED@EXAMPLE.COM");
    expect(result).toEqual("normalized@example.com");
  });

  it("trims whitespace from email", async function () {
    var result = await validate(validUser, "  new@example.com  ");
    expect(result).toEqual("new@example.com");
  });

  it("removes spaces within email", async function () {
    var result = await validate(validUser, "new @example.com");
    expect(result).toEqual("new@example.com");
  });

  it("handles combined normalization", async function () {
    var result = await validate(validUser, "  NEW @EXAMPLE.COM  ");
    expect(result).toEqual("new@example.com");
  });

  it("accepts valid email formats", async function () {
    var validEmails = [
      "user@domain.com",
      "user.name@domain.com",
      "user+tag@domain.com",
      "user@subdomain.domain.com",
      "user123@domain.co.uk"
    ];

    for (var i = 0; i < validEmails.length; i++) {
      var result = await validate(validUser, validEmails[i]);
      expect(result).toEqual(validEmails[i]);
    }
  });
});
