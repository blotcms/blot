describe("dropbox accessTokenCache", function () {
  const redis = require("models/client");
  const cache = require("../util/accessTokenCache");

  const blogID = "blog_tokencache" + Date.now();
  const account = { refresh_token: "refresh-1" };

  afterEach(async function () {
    await cache.drop(blogID);
  });

  it("returns a token that is not near expiry, with a TTL short of it", async function () {
    const expiresAt = Date.now() + 4 * 60 * 60 * 1000;
    await cache.set(blogID, account, "token-1", expiresAt);

    const cached = await cache.get(blogID, account);
    expect(cached.access_token).toBe("token-1");
    expect(cached.expires_at).toBe(expiresAt);

    const ttl = await redis.pTTL(cache.key(blogID));
    expect(ttl).toBeLessThanOrEqual(expiresAt - Date.now() - 59 * 1000);
    expect(ttl).toBeGreaterThan(0);
  });

  it("does not store a token about to expire", async function () {
    await cache.set(blogID, account, "token-1", Date.now() + 30 * 1000);
    expect(await cache.get(blogID, account)).toBe(null);
  });

  it("ignores a token issued for another refresh token", async function () {
    await cache.set(blogID, account, "token-1", Date.now() + 3600 * 1000);
    expect(await cache.get(blogID, { refresh_token: "refresh-2" })).toBe(null);
  });

  it("forgets a dropped token", async function () {
    await cache.set(blogID, account, "token-1", Date.now() + 3600 * 1000);
    await cache.drop(blogID);
    expect(await cache.get(blogID, account)).toBe(null);
  });
});
