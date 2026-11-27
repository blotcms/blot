// A setup that fails leaves the blog a reason, which the create page shows
// until the next setup, a disconnect, or its expiry
describe("git client: a failed setup", function () {
  require("./setup")({ setClientToGit: false, clone: false });

  var Express = require("express");
  var client = require("models/client");
  var Blog = require("models/blog");
  var database = require("clients/git/database");
  var create = require("clients/git/create");
  var disconnect = require("clients/git/disconnect");
  var establishSyncLock = require("sync/establishSyncLock");
  var folder = require("./setup/folder");

  beforeEach(async function () {
    var blog = this.blog;
    var ctx = this;
    ctx.rendered = null;

    var app = Express()
      .use(function (req, res, next) {
        req.blog = blog;
        req.body = {};
        res.locals.breadcrumbs = { add: function () {} };
        res.render = function (view, locals) {
          ctx.rendered = Object.assign({ view }, res.locals, locals);
          res.sendStatus(200);
        };
        next();
      })
      .use(require("clients/git/routes").dashboard);

    this.listener = await new Promise(function (resolve) {
      var server = app.listen(0, function () {
        resolve(server);
      });
    });
  });

  afterEach(async function () {
    var listener = this.listener;
    await new Promise(function (resolve) {
      listener.close(resolve);
    });
  });

  // What the dashboard shows at GET /, following its redirect to /create
  async function page(ctx) {
    var base = "http://127.0.0.1:" + ctx.listener.address().port;
    var response = await fetch(base + "/", { redirect: "manual" });
    var location = response.headers.get("location");

    if (location && /\/create$/.test(location)) {
      await fetch(base + "/create");
      return { create: true, failed: ctx.rendered.failed };
    }

    return { create: false };
  }

  async function setupError(blog) {
    try {
      await create(blog);
    } catch (err) {
      return err;
    }
    return null;
  }

  it("shows why it failed on the create page, once the setup has ended", async function () {
    spyOn(database, "createToken").and.callFake(async function () {
      throw new Error("Redis went away");
    });

    expect(await setupError(this.blog)).toEqual(jasmine.any(Error));

    expect(await database.isCreating(this.blog.id)).toBe(false);
    var shown = await page(this);
    expect(shown.create).toBe(true);
    expect(shown.failed).toMatch(/couldn’t finish setting up the repository/);

    var ttl = await client.ttl(database.failedKey(this.blog.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(database.FAILED_TTL_SECONDS);
  });

  it("sends a status, so a page showing the setup reloads", async function () {
    spyOn(database, "createToken").and.callFake(async function () {
      throw new Error("Redis went away");
    });

    await setupError(this.blog);

    // The messenger doesn't wait for its status to be stored
    var messages = [];
    for (
      var i = 0;
      i < 20 && !messages.includes("Repository setup failed");
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      messages = (await Blog.getStatuses(this.blog.id)).statuses.map(
        (status) => status.message
      );
    }
    expect(messages).toContain("Repository setup failed");
  });

  it("says to remove a .git folder the blog folder has", async function () {
    await folder.write(this.blog.id, "/.git/HEAD", "ref: refs/heads/master\n");

    expect(await setupError(this.blog)).toEqual(jasmine.any(Error));

    expect((await page(this)).failed).toMatch(/has a \.git folder in it/);
  });

  it("says to try again when the folder is busy syncing", async function () {
    var lock = await establishSyncLock(this.blog.id);

    try {
      expect(await setupError(this.blog)).toEqual(jasmine.any(Error));
    } finally {
      await lock.done();
    }

    expect((await page(this)).failed).toMatch(/busy syncing/);
  });

  it("is cleared by the next setup, which succeeds", async function () {
    await database.setFailed(this.blog.id, "An earlier failure");

    await create(this.blog);

    expect(await database.getFailed(this.blog.id)).toBe(null);
    expect((await page(this)).create).toBe(false);
  });

  it("is cleared by a disconnect", async function () {
    await database.setFailed(this.blog.id, "An earlier failure");

    await disconnect(this.blog.id);

    expect(await database.getFailed(this.blog.id)).toBe(null);
  });

  it("records nothing for a setup a disconnect stopped", async function () {
    spyOn(database, "createToken").and.callFake(async function () {
      throw Object.assign(new Error("Cancelled"), { code: "ECANCELED" });
    });

    expect(await setupError(this.blog)).toEqual(jasmine.any(Error));

    expect(await database.getFailed(this.blog.id)).toBe(null);
  });

  it("records nothing when the blog already has a repository", async function () {
    await create(this.blog);

    var error = await setupError(this.blog);

    expect(error && error.code).toBe("EEXIST");
    expect(await database.getFailed(this.blog.id)).toBe(null);
  });

  it("shows no reason on the create page when there is none", async function () {
    expect((await page(this)).failed).toBe(null);
  });
});
