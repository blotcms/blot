describe("google drive cached auth", function () {
  const cachedAuth = require("../serviceAccount/cachedAuth");

  // Records how each auth was made
  function FakeAuth(options) {
    this.options = options;
    this.getAccessToken = async () => "token";
  }

  afterEach(function () {
    cachedAuth.cache.clear();
  });

  it("makes one auth per service account and scopes, refreshed early", function () {
    const credentials = { client_id: "a", private_key_id: "k1" };

    const first = cachedAuth(FakeAuth, credentials, ["drive"]);
    expect(cachedAuth(FakeAuth, credentials, ["drive"])).toBe(first);
    expect(cachedAuth(FakeAuth, credentials, ["docs"])).not.toBe(first);
    expect(cachedAuth(FakeAuth, { client_id: "b" }, ["drive"])).not.toBe(first);
    expect(
      first.options.clientOptions.eagerRefreshThresholdMillis
    ).toBeGreaterThan(5 * 60 * 1000);
  });

  it("makes a new auth when the account's key changes", function () {
    const first = cachedAuth(
      FakeAuth,
      { client_id: "a", private_key_id: "k1" },
      ["drive"]
    );

    expect(
      cachedAuth(FakeAuth, { client_id: "a", private_key_id: "k2" }, ["drive"])
    ).not.toBe(first);
  });
});
