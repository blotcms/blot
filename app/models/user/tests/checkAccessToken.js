var client = require("models/client");
var key = require("../key");
var check = require("util").promisify(require("../checkAccessToken"));

describe("one-time access tokens", function () {
  var token = "atomic-access-token-test";

  afterEach(async function () {
    await client.del(key.accessToken(token));
  });

  it("allows exactly one concurrent consumer", async function () {
    await client.set(key.accessToken(token), "user-id");
    var results = await Promise.all(Array.from({ length: 10 }, function () {
      return check(token).then(value => ({ value }), error => ({ error }));
    }));
    expect(results.filter(result => result.value === "user-id").length).toEqual(1);
    expect(results.filter(result => result.error).length).toEqual(9);
    expect(await client.get(key.accessToken(token))).toBeNull();
  });

  it("rejects missing and expired tokens", async function () {
    await client.set(key.accessToken(token), "user-id");
    await client.pExpireAt(key.accessToken(token), Date.now() - 1);
    var error = await check(token).then(() => null, err => err);
    expect(error.message).toEqual("Invalid access token");
  });

  it("reports Redis failure instead of authenticating", async function () {
    spyOn(client, "getDel").and.returnValue(Promise.reject(new Error("Redis unavailable")));
    var error = await check(token).then(() => null, err => err);
    expect(error.message).toEqual("Redis unavailable");
  });
});
