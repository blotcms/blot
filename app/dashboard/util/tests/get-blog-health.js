const clients = require("clients");
const health = require("clients/health");
const getBlogHealth = require("../get-blog-health");

describe("getBlogHealth", function () {
  afterEach(function () {
    delete clients.fakeHealthClient;
  });

  it("treats a client without getHealth as healthy", async function () {
    clients.fakeHealthClient = {};

    const blog = await getBlogHealth({ id: "blog_1", client: "fakeHealthClient" });

    expect(blog.health).toEqual(health.ok());
    expect(blog.healthIssue).toBeUndefined();
  });

  it("treats a blog with no client as healthy", async function () {
    const blog = await getBlogHealth({ id: "blog_1" });

    expect(blog.health).toEqual(health.ok());
    expect(blog.healthIssue).toBeUndefined();
  });

  it("exposes the most severe issue with its label", async function () {
    clients.fakeHealthClient = {
      getHealth: async function (blogID) {
        expect(blogID).toBe("blog_1");
        return health.error([
          { code: "SYNC_ERROR" },
          { code: "REAUTH_REQUIRED", since: 1758000000000 },
        ]);
      },
    };

    const blog = await getBlogHealth({ id: "blog_1", client: "fakeHealthClient" });

    expect(blog.health.state).toBe("error");
    expect(blog.healthIssue).toEqual({
      code: "REAUTH_REQUIRED",
      label: "Reconnect required",
      message: health.ISSUES.REAUTH_REQUIRED.message,
      since: 1758000000000,
      action: health.ISSUES.REAUTH_REQUIRED.action,
    });
  });

  it("does not expose an issue while syncing", async function () {
    clients.fakeHealthClient = { getHealth: async () => health.syncing() };

    const blog = await getBlogHealth({ id: "blog_1", client: "fakeHealthClient" });

    expect(blog.health.state).toBe("syncing");
    expect(blog.healthIssue).toBeUndefined();
  });

  it("falls back to healthy when getHealth fails", async function () {
    spyOn(console, "error");
    clients.fakeHealthClient = {
      getHealth: async function () {
        throw new Error("redis down");
      },
    };

    const blog = await getBlogHealth({ id: "blog_1", client: "fakeHealthClient" });

    expect(blog.health).toEqual(health.ok());
    expect(blog.healthIssue).toBeUndefined();
  });
});
