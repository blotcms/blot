describe("git store shadow mode: backfill", function () {
  var setup = require("./setup");
  var config = require("config");
  var shadow = require("clients/git/shadow");
  var maintenance = require("clients/git/shadow/maintenance");
  var backfill = require("clients/git/shadow/backfill");

  setup();

  // History pushed while shadow mode was off for the blog
  async function pushUnshadowed(ctx) {
    config.git_store.shadow = "";
    await ctx.local.writeAndPush("/a.txt", "A");
    await ctx.local.writeAndPush("/b.txt", "B");
    config.git_store.shadow = ctx.blog.id;
  }

  function options(ctx, extra) {
    return Object.assign({ scratchDir: ctx.tmp + "/backfill-scratch" }, extra);
  }

  it("imports a blog pushed while shadow mode was off, and a second run changes nothing", async function () {
    await pushUnshadowed(this);
    expect(this.stores[this.blog.id]).toBeUndefined();

    var first = await backfill(options(this));
    expect(first.blogs).toBe(1);
    expect(first.outcomes).toEqual({ "import:imported": 1 });
    expect(first.bytesUp).toBeGreaterThan(0);

    var current = await setup.expectMirrored(this);
    expect(current.seq).toBe(1);

    var line = this.shadowLines("import")[0];
    expect(line).toContain("outcome=imported");
    expect(line).toContain("reason=backfill");
    expect(line).toMatch(/ storeMs=\d+ .*bytesUp=\d+ /);
    expect(line).not.toContain(this.blog.handle);

    // In sync: one manifest read, and nothing written
    var store = this.stores[this.blog.id];
    var puts = store.stats.puts + store.stats.putIfAbsents;

    var second = await backfill(options(this));
    expect(second.outcomes).toEqual({ "push:same": 1 });
    expect(store.stats.puts + store.stats.putIfAbsents).toBe(puts);
    expect((await setup.expectMirrored(this)).seq).toBe(1);

    // The summary line
    expect(this.shadowLines("backfill").length).toBe(2);
    expect(this.shadowLines("backfill")[1]).toContain("push:same=1");
  });

  it("brings a store which is behind up to date", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);

    config.git_store.shadow = "";
    await this.local.writeAndPush("/b.txt", "B");
    config.git_store.shadow = this.blog.id;

    var summary = await backfill(options(this, { blog: this.blog.id }));
    expect(summary.outcomes).toEqual({ "push:ok": 1 });
    await setup.expectMirrored(this);
  });

  it("writes nothing with dryRun", async function () {
    await pushUnshadowed(this);

    var summary = await backfill(options(this, { dryRun: true }));
    expect(summary.outcomes).toEqual({ "import:would-import": 1 });

    var store = this.stores[this.blog.id];
    expect(store.stats.puts + store.stats.putIfAbsents + store.stats.deletes).toBe(0);
    expect(this.shadowLines("import")[0]).toContain("dryRun=true");
  });

  it("only backfills shadowed blogs, unless asked for all", async function () {
    await pushUnshadowed(this);
    config.git_store.shadow = "blog_someoneelse";

    var summary = await backfill(options(this));
    expect(summary.blogs).toBe(0);
    expect(this.stores[this.blog.id]).toBeUndefined();

    summary = await backfill(options(this, { blog: this.blog.id }));
    expect(summary.blogs).toBe(0);
    expect(this.stores[this.blog.id]).toBeUndefined();

    summary = await backfill(options(this, { blog: this.blog.id, all: true }));
    expect(summary.outcomes).toEqual({ "import:imported": 1 });
    await setup.expectMirrored(this);
  });

  it("goes on to the next blog when one fails", async function () {
    await pushUnshadowed(this);

    spyOn(maintenance, "gitBlogs").and.returnValue(Promise.resolve(["blog_broken", this.blog.id]));
    var mirror = shadow.mirror;
    spyOn(shadow, "mirror").and.callFake(function (blogID, opts) {
      if (blogID === "blog_broken") return Promise.reject(new Error("the bucket fell over"));
      return mirror(blogID, opts);
    });

    var summary = await backfill(options(this, { concurrency: 2 }));
    expect(summary.blogs).toBe(2);
    expect(summary.outcomes).toEqual({ "push:error": 1, "import:imported": 1 });
    await setup.expectMirrored(this);
  });

  it("deletes the copy and imports it again with resetFirst", async function () {
    await this.local.writeAndPush("/a.txt", "A");
    await setup.expectMirrored(this);
    await this.local.writeAndPush("/b.txt", "B");
    var before = await setup.expectMirrored(this);
    expect(before.seq).toBeGreaterThan(1);

    var summary = await backfill(options(this, { blog: this.blog.id, resetFirst: true }));
    expect(summary.outcomes).toEqual({ "import:imported": 1 });

    // The removal's tombstone takes the seq after the old newest, and the
    // import the one after that: the numbering never starts again at 1
    var store = this.stores[this.blog.id];
    var fresh = Object.assign({}, store, { id: store.id });
    expect((await setup.expectMirrored(this, fresh)).seq).toBe(before.seq + 2);
  });
});
