describe("sync/update/stalledBuilds", function () {
  var stalledBuilds = require("../update/stalledBuilds");
  var sync = require("../index");
  var folder = require("storage/folder");
  var client = require("models/client");
  var email = require("helper/email");
  var Entry = require("models/entry");

  global.test.blog();

  global.test.timeout(30 * 1000);

  var stallMs;

  beforeEach(function () {
    stallMs = stalledBuilds.options.stallMs;
    stalledBuilds.options.stallMs = 500;
    spyOn(email, "BUILD_STALLED").and.returnValue(Promise.resolve());
  });

  afterEach(async function () {
    stalledBuilds.options.stallMs = stallMs;
    await client.del(stalledBuilds.alertKey(this.blog.id));
  });

  // Blocks the event loop for ms, as a quadratic converter does. The stall
  // is measured by a timer firing every second, so a block of 1.7s is at
  // least 0.7s late, over the 0.5s the specs count as a stall.
  function block(ms) {
    var until = Date.now() + ms;
    while (Date.now() < until);
  }

  async function attempts(blogID, path) {
    var version = await stalledBuilds.versionOf(blogID, path);
    return client.get(stalledBuilds.attemptsKey(blogID, path, version));
  }

  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return null;
  }

  it("runs the build and leaves nothing behind when it doesn't stall", async function () {
    var blog = this.blog;
    await folder.write(blog.id, "/a.txt", "a");

    var result = await stalledBuilds(blog, "/a.txt", async () => "built");

    expect(result).toBe("built");
    expect(await attempts(blog.id, "/a.txt")).toBe(null);
  });

  it("leaves nothing behind for a build that throws without stalling", async function () {
    var blog = this.blog;
    await folder.write(blog.id, "/a.txt", "a");

    var err = await rejection(
      stalledBuilds(blog, "/a.txt", async () => {
        throw new Error("bad file");
      })
    );

    expect(err.message).toBe("bad file");
    expect(await attempts(blog.id, "/a.txt")).toBe(null);
  });

  it("skips a file whose last two builds blocked the event loop, and emails once", async function () {
    var blog = this.blog;
    var builds = 0;
    var slow = async () => {
      builds += 1;
      block(1700);
    };
    await folder.write(blog.id, "/a.txt", "a");

    await stalledBuilds(blog, "/a.txt", slow);
    expect(await attempts(blog.id, "/a.txt")).toBe("1");
    await stalledBuilds(blog, "/a.txt", slow);
    expect(await attempts(blog.id, "/a.txt")).toBe("2");

    var err = await rejection(stalledBuilds(blog, "/a.txt", slow));
    expect(err.code).toBe("BUILD_STALLED");
    err = await rejection(stalledBuilds(blog, "/a.txt", slow));
    expect(err.code).toBe("BUILD_STALLED");

    expect(builds).toBe(2);
    expect(email.BUILD_STALLED).toHaveBeenCalledTimes(1);
    expect(email.BUILD_STALLED.calls.argsFor(0)[1]).toEqual(
      jasmine.objectContaining({ blogID: blog.id, path: "/a.txt" })
    );
  });

  it("counts a build that never ended, as a crashed process leaves it", async function () {
    var blog = this.blog;
    await folder.write(blog.id, "/a.txt", "a");
    var version = await stalledBuilds.versionOf(blog.id, "/a.txt");
    var key = stalledBuilds.attemptsKey(blog.id, "/a.txt", version);
    await client.set(key, String(stalledBuilds.MAX_ATTEMPTS), { EX: 60 });

    var err = await rejection(
      stalledBuilds(blog, "/a.txt", async () => "built")
    );

    expect(err.code).toBe("BUILD_STALLED");
  });

  it("doesn't count a stall which ended before the build began", async function () {
    var blog = this.blog;
    await folder.write(blog.id, "/a.txt", "a");

    // The next build starts straight after the stall, before the timer has
    // fired to see it
    block(1700);
    await stalledBuilds(blog, "/a.txt", async () => "built");

    expect(await attempts(blog.id, "/a.txt")).toBe(null);
  });

  it("builds the file again once it changes", async function () {
    var blog = this.blog;
    var slow = async () => block(1700);
    await folder.write(blog.id, "/a.txt", "a");
    await stalledBuilds(blog, "/a.txt", slow);
    await stalledBuilds(blog, "/a.txt", slow);

    await folder.write(blog.id, "/a.txt", "edited");

    expect(await stalledBuilds(blog, "/a.txt", async () => "built")).toBe(
      "built"
    );
  });

  it("keeps the post and flags the file when a sync skips it", async function () {
    var blog = this.blog;
    var blogID = blog.id;

    await folder.write(blogID, "/post.txt", "First version");
    await sync(blogID, (syncFolder) => syncFolder.update("/post.txt"));
    expect((await Entry.get(blogID, "/post.txt")).html).toContain("First");

    // Two builds of the new version crashed their processes
    await folder.write(blogID, "/post.txt", "Second version");
    var version = await stalledBuilds.versionOf(blogID, "/post.txt");
    await client.set(
      stalledBuilds.attemptsKey(blogID, "/post.txt", version),
      "2",
      { EX: 60 }
    );

    await sync(blogID, (syncFolder) =>
      syncFolder.update("/post.txt").catch(() => {})
    );

    expect((await Entry.get(blogID, "/post.txt")).html).toContain("First");
    expect((await folder.stat(blogID, "/post.txt")).flags).toEqual([
      jasmine.objectContaining({ code: "BUILD_TIMEOUT", step: "build" }),
    ]);
  });
});
