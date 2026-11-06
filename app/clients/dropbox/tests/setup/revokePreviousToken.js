describe("dropbox setup revokePreviousToken", function () {
  const helperPath = require.resolve("../../routes/setup/revokePreviousToken");
  const databasePath = require.resolve("clients/dropbox/database");
  const sdkPath = require.resolve("dropbox");
  const originals = {};
  let revoked, others, failRevoke;

  beforeEach(function () {
    [helperPath, databasePath, sdkPath].forEach(
      (p) => (originals[p] = require.cache[p])
    );
    revoked = [];
    others = [];
    failRevoke = false;

    require.cache[databasePath] = {
      exports: {
        listBlogs: (_id, cb) =>
          cb(
            null,
            others.map((o) => ({ id: o.id }))
          ),
        get: (id, cb) =>
          cb(
            null,
            others.find((o) => o.id === id)
          ),
      },
    };

    // Stub the SDK so no request is made; records the token revoked.
    require.cache[sdkPath] = {
      exports: {
        Dropbox: function () {
          let token;
          this.auth = {
            setAccessToken: (t) => (token = t),
            setClientId() {},
            setClientSecret() {},
            setRefreshToken() {},
            checkAndRefreshAccessToken: async () => {},
          };
          this.authTokenRevoke = async () => {
            revoked.push(token);
            if (failRevoke) throw new Error("boom");
          };
        },
      },
    };

    delete require.cache[helperPath];
  });

  afterEach(function () {
    [helperPath, databasePath, sdkPath].forEach((p) => {
      if (originals[p]) require.cache[p] = originals[p];
      else delete require.cache[p];
    });
  });

  const previous = {
    account_id: "acct",
    access_token: "old-token",
    refresh_token: "",
    full_access: false,
  };
  const current = { blogID: "blog_a", access_token: "new-token" };

  it("revokes the old token when permission changes", async function () {
    const revoke = require("../../routes/setup/revokePreviousToken");
    expect(await revoke(previous, current)).toEqual(true);
    expect(revoked).toEqual(["old-token"]);
  });

  it("does nothing for a first-time connection or an unchanged token", async function () {
    const revoke = require("../../routes/setup/revokePreviousToken");
    expect(await revoke(null, current)).toEqual(false);
    expect(
      await revoke(previous, { blogID: "blog_a", access_token: "old-token" })
    ).toEqual(false);
    expect(revoked).toEqual([]);
  });

  it("does not revoke a token another blog still uses", async function () {
    others = [{ id: "blog_b", access_token: "old-token", refresh_token: "" }];
    const revoke = require("../../routes/setup/revokePreviousToken");
    expect(await revoke(previous, current)).toEqual(false);
    expect(revoked).toEqual([]);
  });

  it("revokes when other blogs use different tokens", async function () {
    others = [{ id: "blog_b", access_token: "other-token", refresh_token: "" }];
    const revoke = require("../../routes/setup/revokePreviousToken");
    expect(await revoke(previous, current)).toEqual(true);
  });

  it("swallows revoke failures", async function () {
    failRevoke = true;
    const revoke = require("../../routes/setup/revokePreviousToken");
    expect(await revoke(previous, current)).toEqual(false);
    expect(revoked).toEqual(["old-token"]);
  });
});
