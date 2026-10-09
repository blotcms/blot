const clients = require("clients");
const health = require("clients/health");
const readOnly = require("helper/readOnly");
const getBlogHealth = require("../get-blog-health");

describe("getBlogHealth", function () {
  global.test.timeout(15 * 1000);

  beforeEach(async function () {
    await readOnly.disable();
  });

  // A failing test must not leave the freeze on for other specs
  afterEach(async function () {
    delete clients.fakeHealthClient;
    await readOnly.disable();
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

  describe("while Blot is read-only", function () {
    it("reports a sync paused issue for a blog with a healthy client", async function () {
      const before = Date.now();

      await readOnly.enable({ reason: "test", ttl: 60 });
      clients.fakeHealthClient = { getHealth: async () => health.ok() };

      const blog = await getBlogHealth({
        id: "blog_1",
        client: "fakeHealthClient",
      });

      expect(blog.health.state).toBe("error");
      expect(blog.healthIssue.code).toBe("SYNC_PAUSED");
      expect(blog.healthIssue.label).toBe("Sync paused");
      expect(blog.healthIssue.message).toBe(
        health.ISSUES.SYNC_PAUSED.message
      );
      expect(blog.healthIssue.action).toBeUndefined();
      expect(blog.healthIssue.since).toBeGreaterThanOrEqual(before);
      expect(blog.healthIssue.since).toBeLessThanOrEqual(Date.now());
    });

    it("reports a sync paused issue for a client without getHealth", async function () {
      await readOnly.enable({ reason: "test", ttl: 60 });
      clients.fakeHealthClient = {};

      const blog = await getBlogHealth({
        id: "blog_1",
        client: "fakeHealthClient",
      });

      expect(blog.healthIssue.code).toBe("SYNC_PAUSED");
    });

    it("reports a sync paused issue for a client that is syncing", async function () {
      await readOnly.enable({ reason: "test", ttl: 60 });
      clients.fakeHealthClient = { getHealth: async () => health.syncing() };

      const blog = await getBlogHealth({
        id: "blog_1",
        client: "fakeHealthClient",
      });

      expect(blog.health.state).toBe("error");
      expect(blog.healthIssue.code).toBe("SYNC_PAUSED");
    });

    it("lets a real issue from the client win", async function () {
      await readOnly.enable({ reason: "test", ttl: 60 });
      clients.fakeHealthClient = {
        getHealth: async () =>
          health.error([{ code: "REAUTH_REQUIRED", since: 1758000000000 }]),
      };

      const blog = await getBlogHealth({
        id: "blog_1",
        client: "fakeHealthClient",
      });

      expect(blog.healthIssue).toEqual({
        code: "REAUTH_REQUIRED",
        label: "Reconnect required",
        message: health.ISSUES.REAUTH_REQUIRED.message,
        since: 1758000000000,
        action: health.ISSUES.REAUTH_REQUIRED.action,
      });
    });

    it("leaves a blog with no client healthy", async function () {
      await readOnly.enable({ reason: "test", ttl: 60 });

      const blog = await getBlogHealth({ id: "blog_1" });

      expect(blog.health).toEqual(health.ok());
      expect(blog.healthIssue).toBeUndefined();
    });

    it("ignores a failure to read the freeze status", async function () {
      spyOn(readOnly, "status").and.returnValue(
        Promise.reject(new Error("redis down"))
      );
      clients.fakeHealthClient = { getHealth: async () => health.ok() };

      const blog = await getBlogHealth({
        id: "blog_1",
        client: "fakeHealthClient",
      });

      expect(readOnly.status).toHaveBeenCalled();
      expect(blog.health).toEqual(health.ok());
      expect(blog.healthIssue).toBeUndefined();
    });
  });

  it("does not report sync paused when Blot is not read-only", async function () {
    clients.fakeHealthClient = { getHealth: async () => health.ok() };

    const blog = await getBlogHealth({
      id: "blog_1",
      client: "fakeHealthClient",
    });

    expect(blog.health).toEqual(health.ok());
    expect(blog.healthIssue).toBeUndefined();
  });
});
