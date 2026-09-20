describe("onedrive getHealth", function () {
  const getHealth = require("../getHealth");
  const { connect } = require("./helpers");

  // Create test blog
  global.test.blog();

  it("is ok when the blog has no OneDrive account", async function () {
    expect(await getHealth(this.blog.id)).toEqual({ state: "ok", issues: [] });
  });

  it("is ok for a healthy account", async function () {
    await connect(this.blog.id);
    expect(await getHealth(this.blog.id)).toEqual({ state: "ok", issues: [] });
  });

  it("reports revoked access with when it started", async function () {
    await connect(this.blog.id, { error_code: 401, error_since: 1758000000000 });

    const result = await getHealth(this.blog.id);

    expect(result.state).toBe("error");
    expect(result.issues[0].code).toBe("REAUTH_REQUIRED");
    expect(result.issues[0].since).toBe(1758000000000);
  });

  it("reports a deleted folder and full storage", async function () {
    await connect(this.blog.id, { error_code: 404 });
    expect((await getHealth(this.blog.id)).issues[0].code).toBe("SOURCE_MISSING");

    await connect(this.blog.id, { error_code: 507 });
    expect((await getHealth(this.blog.id)).issues[0].code).toBe("QUOTA_EXCEEDED");
  });
});
