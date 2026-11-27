describe("git store: push limit", function () {
  const config = require("config");
  const { pushLimit, PUSH_CACHE_SHARE } = require("clients/git/served/receive");
  const { container } = require("../../../../../proxy/build/locals");

  const MiB = 1024 * 1024;

  it("is the ceiling when half the cache is larger", function () {
    expect(pushLimit({ maxBytes: 50 * 1024 * MiB })).toBe(
      config.git_store.max_push_bytes
    );
  });

  it("is half the cache when that is smaller than the ceiling", function () {
    const maxBytes = 1024 * MiB;

    expect(PUSH_CACHE_SHARE).toBe(0.5);
    expect(pushLimit({ maxBytes })).toBe(512 * MiB);
  });

  // config/index.js's cache_bytes, which the git specs' setup lowers
  it("is about 2 GB with the production cache", function () {
    expect(config.git_store.max_push_bytes).toBe(1900 * MiB);
    expect(pushLimit({ maxBytes: 50 * 1024 * MiB })).toBe(1900 * MiB);
  });

  it("is below the proxy's body limit for git requests", function () {
    const proxyLimit = container({ env: {}, config }).git_client_max_body_size;

    expect(proxyLimit).toBe("2000M");
    expect(parseInt(proxyLimit, 10) * MiB).toBeGreaterThan(
      config.git_store.max_push_bytes
    );
  });
});
