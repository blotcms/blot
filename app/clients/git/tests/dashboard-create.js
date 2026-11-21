// The dashboard's git page while a repository is being set up: it shows the
// setup only while the blog's own mark (database.setCreating) is there, which
// expires by itself, never because of the owner's account-wide status
describe("git client dashboard: a setup in progress", function () {
  require("./setup")({ setClientToGit: false, clone: false });

  var Express = require("express");
  var client = require("models/client");
  var database = require("clients/git/database");
  var disconnect = require("clients/git/disconnect");
  var setStatus = database.setStatus;
  var setCreating = database.setCreating;
  var isCreating = database.isCreating;

  beforeEach(async function () {
    var blog = this.blog;
    var ctx = this;
    ctx.rendered = null;

    this.app = Express()
      .use(function (req, res, next) {
        req.blog = blog;
        req.body = {};
        res.locals.breadcrumbs = { add: function () {} };
        res.message = function () {
          res.sendStatus(200);
        };
        // The page itself: its rendering is not what is checked here, only
        // whether it shows the setup as still running
        res.render = function (view, locals) {
          ctx.rendered = Object.assign({}, res.locals, locals);
          res.sendStatus(200);
        };
        next();
      })
      .use(require("clients/git/routes").dashboard);

    var app = this.app;
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

  // Where GET / sends the dashboard: "create", or "page" if it shows the page
  async function landing(ctx) {
    var response = await fetch(
      "http://127.0.0.1:" + ctx.listener.address().port + "/",
      { redirect: "manual" }
    );
    if (response.status >= 300 && response.status < 400) {
      return /\/create$/.test(response.headers.get("location"))
        ? "create"
        : response.headers.get("location");
    }
    return response.status === 200 ? "page" : "status " + response.status;
  }

  it("sends a blog with no repository and no mark to /create, whatever the owner's status says", async function () {
    // What a setup cut off by a crash or a deploy left behind
    await setStatus(this.blog.owner, "createInProgress");

    expect(await landing(this)).toBe("create");
  });

  it("shows the setup while the blog is marked, and not once the mark has expired", async function () {
    await setCreating(this.blog.id);
    expect(await landing(this)).toBe("page");

    // A mark with only a moment left, as one left by a setup cut off an hour ago
    await client.set(database.creatingKey(this.blog.id), "1", { PX: 50 });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await isCreating(this.blog.id)).toBe(false);
    expect(await landing(this)).toBe("create");
  });

  it("marks the setup with an expiry, and clears it when the setup ends", async function () {
    await setCreating(this.blog.id);

    var ttl = await client.ttl(database.creatingKey(this.blog.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(database.CREATING_TTL_SECONDS);

    await require("clients/git/create")(this.blog);

    expect(await isCreating(this.blog.id)).toBe(false);
    expect(await landing(this)).toBe("page");
  });

  it("shows the repository as being created only until it exists, whatever the owner's status says", async function () {
    await setCreating(this.blog.id);
    await setStatus(this.blog.owner, "createComplete");

    expect(await landing(this)).toBe("page");
    expect(this.rendered.createInProgress).toBe(true);

    await require("clients/git/create")(this.blog);
    // A setup for another of the owner's blogs
    await setStatus(this.blog.owner, "createInProgress");

    expect(await landing(this)).toBe("page");
    expect(this.rendered.createInProgress).toBe(false);
  });

  it("is cleared by a disconnect, with the owner's status", async function () {
    await setCreating(this.blog.id);
    await setStatus(this.blog.owner, "createInProgress");

    await disconnect(this.blog.id);

    expect(await isCreating(this.blog.id)).toBe(false);
    expect(await database.getStatus(this.blog.owner)).toBe(null);
    expect(await landing(this)).toBe("create");
  });
});
