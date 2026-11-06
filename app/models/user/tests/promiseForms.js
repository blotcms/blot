describe("user reads without a callback", function () {
  var client = require("models/client");
  var key = require("../key");
  var getById = require("../getById");
  var getByEmail = require("../getByEmail");
  var getAllIds = require("../getAllIds");
  var hashPassword = require("../hashPassword");
  var checkPassword = require("../checkPassword");
  var generateAccessToken = require("../generateAccessToken");
  var checkAccessToken = require("../checkAccessToken");

  var uid = "user_promise_forms_test";
  var email = "promise-forms@example.com";

  afterEach(async function () {
    await client.del(key.user(uid));
    await client.del(key.email(email));
    await client.sRem(key.uids, uid);
  });

  it("returns promises for lookups", async function () {
    var passwordHash = await hashPassword("correct horse");
    await client.sAdd(key.uids, uid);
    await client.set(key.email(email), uid);
    await client.set(
      key.user(uid),
      JSON.stringify({ uid, email, passwordHash, blogs: [] })
    );

    expect((await getById(uid)).email).toBe(email);
    expect((await getByEmail(" " + email.toUpperCase() + " ")).uid).toBe(uid);
    expect(await getById("user_nonexistent_promise")).toBe(null);
    expect(await getAllIds()).toContain(uid);
    expect(await checkPassword(uid, "correct horse")).toBe(true);
    expect(await checkPassword(uid, "wrong")).toBe(false);
    await expectAsync(
      checkPassword("user_nonexistent_promise", "x")
    ).toBeRejectedWithError("No user");
  });

  it("returns promises for access tokens, which can be used once", async function () {
    var token = await generateAccessToken({ uid: uid });
    expect(await checkAccessToken(token)).toBe(uid);
    await expectAsync(checkAccessToken(token)).toBeRejectedWithError(
      "Invalid access token"
    );
  });
});
