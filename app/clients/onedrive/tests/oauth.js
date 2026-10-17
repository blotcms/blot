describe("onedrive oauth", function () {
  const nock = require("nock");
  const config = require("config");
  const oauth = require("../util/oauth");
  const getAccessToken = require("../util/getAccessToken");
  const database = require("../database");
  const { promisify } = require("util");

  const original = Object.assign({}, config.onedrive);

  // Create test blog
  global.test.blog();

  beforeEach(function () {
    config.onedrive.client_id = "test-client-id";
    config.onedrive.client_secret = "test-client-secret";
  });

  afterEach(function () {
    Object.assign(config.onedrive, original);
    nock.cleanAll();
  });

  it("builds an authorize URL with the app folder scope and state", function () {
    const url = new URL(oauth.authorizeUrl("abc123"));

    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe("test-client-id");
    expect(url.searchParams.get("state")).toBe("abc123");
    expect(url.searchParams.get("scope")).toBe(
      "Files.ReadWrite.AppFolder offline_access User.Read"
    );
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /\/clients\/onedrive\/authenticate$/
    );
  });

  it("exchanges a code for tokens", async function () {
    let body;

    nock("https://login.microsoftonline.com")
      .post("/consumers/oauth2/v2.0/token", function (b) {
        body = b;
        return true;
      })
      .reply(200, {
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
      });

    const tokens = await oauth.exchangeCode("the-code");

    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("the-code");
    expect(body.client_secret).toBe("test-client-secret");
    expect(tokens.access_token).toBe("access");
    expect(tokens.refresh_token).toBe("refresh");
    expect(tokens.expires_at).toBeGreaterThan(Date.now());
  });

  it("reads the account from Graph", async function () {
    nock("https://graph.microsoft.com")
      .get("/v1.0/me")
      .reply(200, { id: "abc", userPrincipalName: "me@outlook.com" });

    expect(await oauth.getProfile("access")).toEqual({
      account_id: "abc",
      email: "me@outlook.com",
    });
  });

  it("returns a valid stored access token without refreshing", async function () {
    await promisify(database.set)(this.blog.id, {
      account_id: "a",
      email: "",
      access_token: "still-good",
      refresh_token: "r",
      expires_at: Date.now() + 3600 * 1000,
      error_code: 0,
    });

    expect(await getAccessToken(this.blog.id)).toBe("still-good");
  });

  it("refreshes an expired token and saves the rotated refresh token", async function () {
    await promisify(database.set)(this.blog.id, {
      account_id: "a",
      email: "",
      access_token: "old",
      refresh_token: "old-refresh",
      expires_at: Date.now() - 1000,
      error_code: 0,
    });

    nock("https://login.microsoftonline.com")
      .post("/consumers/oauth2/v2.0/token")
      .reply(200, {
        access_token: "new",
        refresh_token: "new-refresh",
        expires_in: 3600,
      });

    expect(await getAccessToken(this.blog.id)).toBe("new");

    const stored = await promisify(database.get)(this.blog.id);
    expect(stored.access_token).toBe("new");
    expect(stored.refresh_token).toBe("new-refresh");
  });

  it("flags the account when the refresh token is rejected", async function () {
    await promisify(database.set)(this.blog.id, {
      account_id: "a",
      email: "",
      access_token: "old",
      refresh_token: "dead",
      expires_at: Date.now() - 1000,
      error_code: 0,
    });

    nock("https://login.microsoftonline.com")
      .post("/consumers/oauth2/v2.0/token")
      .reply(400, { error: "invalid_grant", error_description: "expired" });

    let error;
    try {
      await getAccessToken(this.blog.id);
    } catch (e) {
      error = e;
    }

    expect(error && error.code).toBe("invalid_grant");

    const stored = await promisify(database.get)(this.blog.id);
    expect(stored.error_code).toBe(401);
  });
});
