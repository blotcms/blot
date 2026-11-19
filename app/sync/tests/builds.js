describe("sync update builds", function () {
  const builds = require("../update/builds");

  const blogID = "blog_builds_spec";

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
});
