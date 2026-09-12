var client = require("models/client");
var key = require("../key");
var generateAccessToken = require("../generateAccessToken");
var checkAccessToken = require("../checkAccessToken");
var promisify = require("util").promisify;
var generate = promisify(generateAccessToken);
var check = promisify(checkAccessToken);

describe("user generateAccessToken", function () {
  var generatedTokens = [];

  afterEach(async function () {
    for (var i = 0; i < generatedTokens.length; i++) {
      await client.del(key.accessToken(generatedTokens[i]));
    }
    generatedTokens = [];
  });

  it("generates a token with specified UID", async function () {
    var uid = "user_token_test";
    var token = await generate({ uid: uid });
    generatedTokens.push(token);
    expect(token).toBeDefined();
    expect(token.length).toBe(32);
    var value = await client.get(key.accessToken(token));
    expect(value).toEqual(uid);
  });

  it("generates unique tokens", async function () {
    var token1 = await generate({ uid: "user_unique_1" });
    var token2 = await generate({ uid: "user_unique_2" });
    generatedTokens.push(token1, token2);
    expect(token1).not.toEqual(token2);
  });

  it("sets default TTL of 24 hours", async function () {
    var token = await generate({ uid: "user_ttl_test" });
    generatedTokens.push(token);
    var ttl = await client.ttl(key.accessToken(token));
    expect(ttl).toBeGreaterThan(86000);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  it("respects custom expiry time", async function () {
    var token = await generate({ uid: "user_expiry_test", expires: 60 });
    generatedTokens.push(token);
    var ttl = await client.ttl(key.accessToken(token));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it("token is hex encoded", async function () {
    var token = await generate({ uid: "user_hex_test" });
    generatedTokens.push(token);
    expect(/^[0-9a-f]+$/.test(token)).toBe(true);
  });
});

describe("user checkAccessToken integration", function () {
  it("validates and consumes a token", async function () {
    var uid = "user_check_token";
    var token = await generate({ uid: uid });
    
    var result = await check(token);
    expect(result).toEqual(uid);
    
    var error = await check(token).then(
      function () { return null; },
      function (err) { return err; }
    );
    expect(error).not.toBeNull();
    expect(error.message).toEqual("Invalid access token");
  });
});
