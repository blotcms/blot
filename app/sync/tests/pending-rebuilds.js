// Whole-blog rebuilds are written to Redis before they start and cleared
// once done, so one a deploy cuts off is run again by the next process to
// find the blog's folder free.
describe("pending rebuilds", function () {
  const pendingRebuilds = require("../pendingRebuilds");
  const folderLock = require("../lock");
  const client = require("models/client");
  const Entry = require("models/entry");

  global.test.blog();

  const path = "/hello.txt";

  beforeEach(async function () {
    // Written to the folder but not built
    await this.blog.write({ path, content: "Title: Hello" });
    this.built = async () => {
      const entry = await Entry.get(this.blog.id, path);
      return !!entry && !entry.deleted;
    };
  });

  afterEach(async function () {
    await pendingRebuilds.alarm.cancel(this.blog.id);
    await client.del([
      pendingRebuilds.pendingKey(this.blog.id),
      pendingRebuilds.runningKey(this.blog.id),
      pendingRebuilds.attemptsKey(this.blog.id),
    ]);
  });

  it("queues the flags with an alarm due now", async function () {
    const before = Date.now();

    await pendingRebuilds.queue(this.blog.id, ["resave", "rebuild"]);

    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([
      "rebuild",
      "resave",
    ]);
    const due = await pendingRebuilds.alarm.when(this.blog.id);
    expect(due).toBeGreaterThanOrEqual(before);
    expect(due).toBeLessThanOrEqual(Date.now());
  });

  it("rejects a flag it doesn't know", async function () {
    let error;
    try {
      await pendingRebuilds.queue(this.blog.id, ["rebuild", "everything"]);
    } catch (err) {
      error = err;
    }
    expect(error instanceof TypeError).toBe(true);
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([]);
  });

  it("rebuilds only the paths queued, and skips one no longer in the folder", async function () {
    const other = "/other.txt";

    await this.blog.write({ path: other, content: "Title: Other" });
    await pendingRebuilds.queuePaths(this.blog.id, [path, "/gone.txt"]);

    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([
      "path:/gone.txt",
      "path:" + path,
    ]);

    await pendingRebuilds.run(this.blog.id);

    expect(await this.built()).toBe(true);
    expect(await Entry.get(this.blog.id, other)).toBeFalsy();
    expect(await Entry.get(this.blog.id, "/gone.txt")).toBeFalsy();
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([]);
  });

  it("rejects a queued path that isn't one", async function () {
    let error;
    try {
      await pendingRebuilds.queuePaths(this.blog.id, ["hello.txt"]);
    } catch (err) {
      error = err;
    }
    expect(error instanceof TypeError).toBe(true);
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([]);
  });

  it("rebuilds the blog and clears the record", async function () {
    await pendingRebuilds.queue(this.blog.id, ["rebuild"]);
    await pendingRebuilds.run(this.blog.id);

    expect(await this.built()).toBe(true);
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([]);
    expect(await client.exists(pendingRebuilds.attemptsKey(this.blog.id))).toBe(
      0
    );
  });

  it("runs again a rebuild that a killed process left part done", async function () {
    // What a run killed by a deploy leaves: its flags taken, not cleared
    await client.sAdd(pendingRebuilds.runningKey(this.blog.id), "rebuild");
    await client.set(pendingRebuilds.attemptsKey(this.blog.id), "1");

    await pendingRebuilds.run(this.blog.id);

    expect(await this.built()).toBe(true);
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([]);
  });

  it("leaves the rebuild queued while the folder is locked", async function () {
    await pendingRebuilds.queue(this.blog.id, ["rebuild"]);

    const lock = await folderLock.lock(this.blog.id);

    try {
      await pendingRebuilds.run(this.blog.id);
    } finally {
      await lock.release();
    }

    expect(await this.built()).toBe(false);
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual(["rebuild"]);
    // and looks again later
    expect(await pendingRebuilds.alarm.when(this.blog.id)).toBeGreaterThan(
      Date.now()
    );

    await pendingRebuilds.run(this.blog.id);

    expect(await this.built()).toBe(true);
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([]);
  });

  it("the alarm runs a rebuild nobody else ran", async function () {
    await pendingRebuilds.queue(this.blog.id, ["rebuild"]);

    expect(await pendingRebuilds.alarm.poll()).toBeGreaterThan(0);

    expect(await this.built()).toBe(true);
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([]);
    expect(await pendingRebuilds.alarm.when(this.blog.id)).toBe(null);
  });

  it("gives up on a rebuild killed too many times", async function () {
    await client.sAdd(pendingRebuilds.runningKey(this.blog.id), "rebuild");
    await client.set(
      pendingRebuilds.attemptsKey(this.blog.id),
      String(pendingRebuilds.MAX_ATTEMPTS)
    );

    await pendingRebuilds.run(this.blog.id);

    expect(await this.built()).toBe(false);
    expect(await pendingRebuilds.pending(this.blog.id)).toEqual([]);
  });

  it("drops the record of a blog that no longer exists", async function () {
    const blogID = "blog_doesnotexist" + Date.now();

    await pendingRebuilds.queue(blogID, ["rebuild"]);
    await pendingRebuilds.run(blogID);

    expect(await pendingRebuilds.pending(blogID)).toEqual([]);
    await pendingRebuilds.alarm.cancel(blogID);
  });
});
