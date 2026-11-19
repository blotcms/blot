describe("sync update builds", function () {
  const builds = require("../update/builds");

  const blogID = "blog_builds_spec";

  // What promise rejects with, or a failed spec if it resolves
  async function rejection(promise) {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    fail("expected a rejection");
  }

  function deferred() {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  }

  it("passes straight through outside a batch", async function () {
    expect(builds.concurrent(blogID)).toBe(false);
    expect(await builds.queue(blogID, "/a.txt", async () => "built")).toBe(
      "built"
    );
    builds.track(blogID, new Promise(() => {}));
    expect(builds.running(blogID)).toEqual([]);
  });

  it("gives a recheck's snapshot the builds running, not other rechecks", async function () {
    const slow = deferred();
    const snapshots = [];

    await builds.batch(blogID, async () => {
      // One slow build, still running while the rechecks start
      const build = builds.queue(blogID, "/slow.txt", () => slow.promise);
      await new Promise(setImmediate);

      // Each recheck takes its snapshot as rebuildDependents does, then
      // waits for it in the background
      for (let i = 0; i < 5; i++) {
        const earlier = builds.running(blogID);
        snapshots.push(earlier.length);
        builds.track(blogID, Promise.all(earlier));
      }

      slow.resolve();
      await build;
    });

    expect(snapshots).toEqual([1, 1, 1, 1, 1]);
    expect(builds.running(blogID)).toEqual([]);
  });

  it("waits for builds and background work before the batch resolves", async function () {
    const build = deferred();
    const recheck = deferred();
    const finished = [];
    let resolved = false;

    const batch = builds
      .batch(blogID, async () => {
        builds
          .queue(blogID, "/a.txt", () => build.promise)
          .then(() => finished.push("build"));
        builds
          .track(blogID, recheck.promise)
          .then(() => finished.push("recheck"));
      })
      .then(() => (resolved = true));

    await new Promise(setImmediate);
    expect(resolved).toBe(false);

    build.resolve();
    await new Promise(setImmediate);
    expect(resolved).toBe(false);

    recheck.resolve();
    await batch;

    expect(finished.sort()).toEqual(["build", "recheck"]);
  });

  it("runs one build of a path at a time", async function () {
    const events = [];
    const first = deferred();

    await builds.batch(blogID, async () => {
      const a = builds.queue(blogID, "/a.txt", async () => {
        events.push("start 1");
        await first.promise;
        events.push("end 1");
      });
      const b = builds.queue(blogID, "/a.txt", async () => {
        events.push("start 2");
      });

      await new Promise(setImmediate);
      expect(events).toEqual(["start 1"]);

      first.resolve();
      await Promise.all([a, b]);
    });

    expect(events).toEqual(["start 1", "end 1", "start 2"]);
  });

  it("queues a '+' folder's files and the plain file of its entry together", async function () {
    expect(builds.entryPath("/article.md+/one.md")).toBe("/article.md");
    expect(builds.entryPath("/article.md+")).toBe("/article.md");
    expect(builds.entryPath("/article.md")).toBe("/article.md");
    expect(builds.entryPath("/notes/a.md")).toBe("/notes/a.md");

    const events = [];
    const first = deferred();

    await builds.batch(blogID, async () => {
      const folderPost = builds.queue(blogID, "/article.md+", async () => {
        events.push("start folder");
        await first.promise;
        events.push("end folder");
      });
      const plain = builds.queue(blogID, "/article.md", async () => {
        events.push("start plain");
      });

      await new Promise(setImmediate);
      first.resolve();
      await Promise.all([folderPost, plain]);
    });

    expect(events).toEqual(["start folder", "end folder", "start plain"]);
  });

  describe("a Redis outage in background work", function () {
    const { SimpleError } = require("redis");
    const outage = () =>
      new SimpleError("NOREPLICAS Not enough good replicas to write.");

    it("fails the batch once it has settled", async function () {
      const recheck = deferred();
      let settled = false;

      const batch = builds.batch(blogID, async () => {
        builds.track(
          blogID,
          recheck.promise.then(() => {
            settled = true;
            throw outage();
          })
        );
        return "done";
      });

      recheck.resolve();

      expect(String(await rejection(batch))).toContain("NOREPLICAS");
      expect(settled).toBe(true);

      // The next batch starts clean
      expect(await builds.batch(blogID, async () => "next")).toBe("next");
    });

    it("but not any other error", async function () {
      const result = await builds.batch(blogID, async () => {
        builds.track(blogID, Promise.reject(new Error("one file")));
        return "done";
      });

      expect(result).toBe("done");
    });

    it("from a dependents recheck fails the batch", async function () {
      const rebuildDependents = require("../update/rebuildDependents");
      const Blog = require("models/blog");
      const client = require("models/client");
      const slow = deferred();
      let reads = 0;

      spyOn(Blog, "get").and.callFake(async () => ({ id: blogID }));
      spyOn(client, "sMembers").and.callFake(async (key) => {
        if (key.indexOf("template") > -1) return [];
        // The first read finds no dependents; the recheck's read fails
        if (reads++ === 0) return [];
        throw outage();
      });

      const batch = builds.batch(blogID, async () => {
        // A build still running, which the recheck must wait for
        const build = builds.queue(blogID, "/slow.txt", () => slow.promise);
        await new Promise(setImmediate);

        await rebuildDependents(blogID, "/target.md");

        slow.resolve();
        await build;
      });

      expect(String(await rejection(batch))).toContain("NOREPLICAS");
      expect(reads).toBe(2);
    });
  });
});
